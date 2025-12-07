// functions/src/functions/shipments/forward/processShipmentTask3.ts

import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";
import fetch from "node-fetch";
import { FieldValue, Transaction, Timestamp } from "firebase-admin/firestore";
import { buildXpressbeesPayload, evaluateXpressbeesResponse, selectCourier } from "../../couriers";
import { NON_RETRYABLE } from "./shipmentHelpers";
import { SHARED_STORE_ID, TASKS_SECRET } from "../../config";
import {
  BusinessIsAuthorisedToProcessThisOrder,
  handleJobFailure,
  httpRetryable,
  maybeCompleteBatch,
  parseJson,
  requireHeaderSecret,
} from "../../helpers";
import { db } from "../../firebaseAdmin";

/**
 * Processes a single shipment task for Xpressbees
 */
export const processShipmentTask3 = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    // -------------------------------------------------------------------------

    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");
      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { businessId, shop, batchId, jobId, pickupName, shippingMode } = (req.body || {}) as {
        businessId?: string;
        shop?: string;
        batchId?: string;
        jobId?: string;
        pickupName?: string;
        shippingMode?: string;
      };

      if (!businessId || !shop || !batchId || !jobId || !pickupName || !shippingMode) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      const batchRef = db
        .collection("users")
        .doc(businessId)
        .collection("shipment_batches")
        .doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(String(jobId));
      const orderRef = db.collection("accounts").doc(shop).collection("orders").doc(String(jobId));
      const businessRef = db.collection("users").doc(businessId);

      // FIX: Atomic idempotency check inside transaction
      const shouldProceed = await db.runTransaction(async (tx: Transaction) => {
        const job = await tx.get(jobRef);
        const jobData = job.data();

        if (jobData?.status === "success") {
          const batch = await tx.get(batchRef);
          const batchData = batch.data() || {};
          if ((batchData.processing || 0) > 0) {
            tx.update(batchRef, {
              processing: FieldValue.increment(-1),
            });
          }
          return false;
        }

        if (jobData?.status === "failed") {
          return false;
        }

        const prevAttempts = Number(jobData?.attempts || 0);
        const jobStatus = jobData?.status;

        const isFallbackAttempt =
          jobStatus === "fallback_queued" || jobStatus === "attempting_fallback";
        const firstAttempt =
          (prevAttempts === 0 || jobStatus === "queued" || !jobStatus) && !isFallbackAttempt;

        tx.set(
          jobRef,
          {
            status: "processing",
            attempts: (prevAttempts || 0) + 1,
            lastAttemptAt: new Date(),
          },
          { merge: true },
        );

        const inc: any = { processing: FieldValue.increment(1) };
        if (firstAttempt) inc.queued = FieldValue.increment(-1);
        tx.update(batchRef, inc);

        return true;
      });

      if (!shouldProceed) {
        await maybeCompleteBatch(batchRef);
        res.json({ ok: true, dedup: true });
        return;
      }

      // Load order to check status
      const ordSnap = await orderRef.get();
      if (!ordSnap.exists) throw new Error("ORDER_NOT_FOUND");
      const order = ordSnap.data();

      const businessDoc = await businessRef.get();
      const businessData = businessDoc.data();

      // Check if the shop is exceptional one, if yes, then check if the given business is authorised to process this order or not
      if (shop === SHARED_STORE_ID) {
        const vendorName = businessData?.vendorName;
        const vendors = order?.vendors;
        const canProcess = BusinessIsAuthorisedToProcessThisOrder(businessId, vendorName, vendors);
        if (!canProcess.authorised) {
          const failure = await handleJobFailure({
            businessId,
            shop,
            batchRef,
            jobRef,
            jobId,
            errorCode: "NOT_AUTHORIZED_TO_PROCESS_THIS_ORDER",
            errorMessage:
              canProcess.status === 500
                ? "Some internal error occured while checking for authorization"
                : "The current business is not authorized to process this Order.",
            isRetryable: false,
          });

          if (failure.shouldReturnFailure) {
            res.status(failure.statusCode).json({
              ok: false,
              reason: failure.reason,
              code: "NOT_AUTHORIZED_TO_PROCESS_THIS_ORDER",
            });
          } else {
            res.status(failure.statusCode).json({
              ok: true,
              action: failure.reason,
            });
          }
          return;
        }
      }

      if (order?.customStatus !== "Confirmed") {
        const failure = await handleJobFailure({
          businessId,
          shop,
          batchRef,
          jobRef,
          jobId,
          errorCode: "ORDER_ALREADY_SHIPPED",
          errorMessage: `Order status is '${order?.customStatus}' - not 'Confirmed'. Order may already be shipped.`,
          isRetryable: false,
        });

        if (failure.shouldReturnFailure) {
          res.status(failure.statusCode).json({
            ok: false,
            reason: failure.reason,
            code: "ORDER_ALREADY_SHIPPED",
          });
        } else {
          res.status(failure.statusCode).json({
            ok: true,
            action: failure.reason,
          });
        }
        return;
      }

      // Get Xpressbees API key
      const xpressbeesCfg = businessData?.integrations?.couriers?.xpressbees || {};
      const apiKey = xpressbeesCfg?.apiKey || xpressbeesCfg?.token;

      if (!apiKey) throw new Error("CARRIER_KEY_MISSING");

      // Select courier based on mode and weight
      const items =
        (Array.isArray(order?.raw?.line_items) && order.raw.line_items) || order?.lineItems || [];

      // Calculate total quantity (consider item quantities)
      const totalQuantity = items.reduce((sum: number, item: any) => {
        return sum + Number(item?.quantity ?? 1);
      }, 0);

      // Get batch data
      const batchData = (await batchRef.get()).data();

      // Determine if this is a priority shipment
      const isPriority = batchData?.courier === "Priority";

      // Get shipping mode
      const payloadShippingMode = (() => {
        if (!isPriority) return shippingMode; // Use default shipping mode

        const priorityCouriers = businessData?.integrations?.couriers?.priorityList;
        const xpressbeesConfig = priorityCouriers?.find(
          (courier: any) => courier.name === "xpressbees",
        );

        return xpressbeesConfig?.mode ?? "Surface"; // Default to Surface if not configured
      })();

      let courierId: string;
      try {
        courierId = await selectCourier(apiKey, payloadShippingMode, totalQuantity);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const failure = await handleJobFailure({
          businessId,
          shop,
          batchRef,
          jobRef,
          jobId,
          errorCode: "COURIER_SELECTION_FAILED",
          errorMessage: msg,
          isRetryable: false,
        });

        if (failure.shouldReturnFailure) {
          res.status(failure.statusCode).json({
            ok: false,
            reason: failure.reason,
            code: "COURIER_SELECTION_FAILED",
          });
        } else {
          res.status(failure.statusCode).json({
            ok: true,
            action: failure.reason,
          });
        }
        return;
      }

      // Build payload for Xpressbees
      const payload = buildXpressbeesPayload({
        orderId: String(jobId),
        order,
        pickupName,
        courierId,
        shippingMode: payloadShippingMode,
      });

      // Call Xpressbees API
      const base = "https://shipment.xpressbees.com";
      const path = "/api/shipments2";

      const resp = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const text = await resp.text();
      const carrier = parseJson(text);

      // Handle network/gateway errors (non-JSON responses with non-2xx status)
      if (!resp.ok && !carrier?.status) {
        // This is a network/gateway error (502, 503, etc.) - not a proper Xpressbees API response
        const failure = await handleJobFailure({
          businessId,
          shop,
          batchRef,
          jobRef,
          jobId,
          errorCode: `HTTP_${resp.status}`,
          errorMessage: text.slice(0, 400) || `HTTP ${resp.status} error`,
          isRetryable: httpRetryable(resp.status),
        });

        if (failure.shouldReturnFailure) {
          res.status(failure.statusCode).json({
            ok: false,
            reason: failure.reason,
            code: `HTTP_${resp.status}`,
          });
        } else {
          res.status(failure.statusCode).json({
            ok: true,
            action: failure.reason,
          });
        }
        return;
      }

      // Evaluate response (works for both success and error responses)
      const verdict = evaluateXpressbeesResponse(carrier);

      // Handle API errors (proper Xpressbees error responses)
      if (!verdict.ok) {
        const failure = await handleJobFailure({
          businessId,
          shop,
          batchRef,
          jobRef,
          jobId,
          errorCode: verdict.code,
          errorMessage: verdict.message,
          isRetryable: verdict.retryable,
          apiResp: carrier,
        });

        if (failure.shouldReturnFailure) {
          res.status(failure.statusCode).json({
            ok: false,
            reason: failure.reason,
            code: verdict.code,
          });
        } else {
          res.status(failure.statusCode).json({
            ok: true,
            action: failure.reason,
          });
        }
        return;
      }

      // --- Success path ------------------------------------------------------
      // FIX: Atomic success update
      await db.runTransaction(async (tx: Transaction) => {
        const job = await tx.get(jobRef);
        const jobData = job.data();

        if (jobData?.status === "success") {
          return; // Already processed
        }

        tx.update(jobRef, {
          status: "success",
          awb: verdict.awbNumber ?? null,
          carrierShipmentId: verdict.shipmentId ?? null,
          xpressbeesOrderId: verdict.orderId ?? null,
          courierName: verdict.courierName ?? null,
          errorCode: FieldValue.delete(),
          errorMessage: FieldValue.delete(),
          apiResp: carrier,
          completedAt: FieldValue.serverTimestamp(),
        });

        tx.update(batchRef, {
          processing: FieldValue.increment(-1),
          success: FieldValue.increment(1),
        });

        tx.set(
          orderRef,
          {
            awb: verdict.awbNumber ?? null,
            courier: `Xpressbees: ${verdict.courierName ?? "Unknown"}`,
            courierProvider: "Xpressbees",
            customStatus: "Ready To Dispatch",
            shippingMode,
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Ready To Dispatch",
              createdAt: Timestamp.now(),
              remarks: `The order's shipment was successfully made on Xpressbees (${shippingMode}) (AWB: ${verdict.awbNumber})`,
            }),
          },
          { merge: true },
        );
      });

      await maybeCompleteBatch(batchRef);

      res.json({
        ok: true,
        awb: verdict.awbNumber ?? null,
        carrierShipmentId: verdict.shipmentId ?? null,
        xpressbeesOrderId: verdict.orderId ?? null,
      });
      return;
    } catch (e: any) {
      // Generic failure (network/bug/etc.)
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.split(/\s/)[0]; // first token
      const isRetryable = !NON_RETRYABLE.has(code);

      try {
        const { businessId, shop, batchId, jobId } = (req.body || {}) as {
          businessId?: string;
          shop?: string;
          batchId?: string;
          jobId?: string;
        };

        if (businessId && shop && batchId && jobId) {
          const batchRef = db
            .collection("users")
            .doc(businessId)
            .collection("shipment_batches")
            .doc(batchId);
          const jobRef = batchRef.collection("jobs").doc(String(jobId));

          const failure = await handleJobFailure({
            businessId,
            shop,
            batchRef,
            jobRef,
            jobId,
            errorCode: code,
            errorMessage: msg,
            isRetryable,
          });

          if (failure.shouldReturnFailure) {
            res.status(failure.statusCode).json({
              error: isRetryable ? "job_failed_transient" : "job_failed_permanent",
              code,
              message: msg,
            });
          } else {
            res.status(failure.statusCode).json({
              ok: true,
              action: failure.reason,
            });
          }
          return;
        }
      } catch (handlerError) {
        console.error("Error in failure handler:", handlerError);
      }

      // Fallback if we couldn't use the handler
      if (isRetryable) {
        res.status(503).json({ error: "job_failed_transient", code, message: msg });
      } else {
        res.status(200).json({ ok: false, permanent: true, reason: code, message: msg });
      }
    }
  },
);
