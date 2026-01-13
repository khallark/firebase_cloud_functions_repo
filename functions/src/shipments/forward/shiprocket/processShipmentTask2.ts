// functions/src/functions/shipments/forward/processShipmentTask2.ts

import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";
import fetch from "node-fetch";
import { releaseAwb } from "../../../services";
import { FieldValue, Transaction, Timestamp } from "firebase-admin/firestore";
import { buildShiprocketPayload, evaluateShiprocketResponse } from "../../../couriers";
import { NON_RETRYABLE } from "../../helpers";
import { requestShiprocketPickup } from "../../../couriers";
import { TASKS_SECRET, SHARED_STORE_IDS } from "../../../config";
import {
  BusinessIsAuthorisedToProcessThisOrder,
  handleJobFailure,
  maybeCompleteBatch,
  parseJson,
  requireHeaderSecret,
} from "../../../helpers";
import { db } from "../../../firebaseAdmin";

/**
 * Processes a single shipment task for Shiprocket
 */
export const processShipmentTask2 = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    // NOTE: Shiprocket order creation does NOT allocate an AWB from your pool.
    let awb: string | undefined;
    let awbReleased = false;

    // -------------------------------------------------------------------------

    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");
      if (req.method !== "POST") return void res.status(405).json({ error: "method_not_allowed" });

      const { businessId, shop, batchId, jobId, pickupName, shippingMode } = (req.body || {}) as {
        businessId?: string;
        shop?: string;
        batchId?: string;
        jobId?: string;
        pickupName?: string;
        shippingMode?: string;
      };
      if (!businessId || !shop || !batchId || !jobId || !pickupName || !shippingMode) {
        return void res.status(400).json({ error: "bad_payload" });
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

        // Check terminal states atomically
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
        return void res.json({ ok: true, dedup: true });
      }

      // Load order to check status
      const ordSnap = await orderRef.get();
      if (!ordSnap.exists) throw new Error("ORDER_NOT_FOUND");
      const order = ordSnap.data();

      // Carrier token/config
      const businessDoc = await businessRef.get();
      const businessData = businessDoc.data();

      // Check if the shop is exceptional one, if yes, then check if the given business is authorised to process this order or not
      if (SHARED_STORE_IDS.includes(shop)) {
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
          return void res.status(failure.statusCode).json({
            ok: false,
            reason: failure.reason,
            code: "ORDER_ALREADY_SHIPPED",
          });
        } else {
          return void res.status(failure.statusCode).json({
            ok: true,
            action: failure.reason,
          });
        }
      }
      // ----------------------------------------------------------------------

      const shiprocketCfg = businessData?.integrations?.couriers?.shiprocket || {};
      // const email = shiprocketCfg?.email;
      // const password = shiprocketCfg?.password;

      // const response = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({ email, password }),
      // });

      // if(!response.ok) {

      // }
      // const text = await response.json();
      // const srToken = json.

      const srToken =
        shiprocketCfg?.accessToken ||
        shiprocketCfg?.token ||
        shiprocketCfg?.apiKey ||
        shiprocketCfg?.bearer;

      if (!srToken) throw new Error("CARRIER_KEY_MISSING");

      // Cache data to avoid repeated lookups
      const batchData = (await batchRef.get()).data();

      // Determine if this is a priority shipment
      const isPriority = batchData?.courier === "Priority";

      // Get shipping mode
      const payloadShippingMode = (() => {
        if (!isPriority) return shippingMode;

        const priorityCouriers = businessData?.integrations?.couriers?.priorityList;
        const shiprocketConfig = priorityCouriers?.find(
          (courier: any) => courier.name === "shiprocket",
        );

        return shiprocketConfig?.mode ?? "Surface";
      })();

      // ---- Create payload ----
      const payload = buildShiprocketPayload({
        orderId: String(jobId),
        order,
        pickupName,
        shippingMode: payloadShippingMode,
      });

      // --- Idempotency: Check if order was already created in Shiprocket ---
      let srOrderId: string | number | undefined;
      let srShipmentId: string | number | undefined = order?.shiprocketShipmentId;

      if (srShipmentId) {
        // Order already created, skip to AWB assignment
        console.log(`Reusing existing Shiprocket shipment ${srShipmentId} for job ${jobId}`);
      } else {
        // ---- Shiprocket Create Order ----
        const base = "https://apiv2.shiprocket.in";
        const createPath = "/v1/external/orders/create/adhoc";

        const resp = await fetch(`${base}${createPath}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${srToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        const text = await resp.text();
        const orderCreateJson = parseJson(text);

        // Evaluate response (works for both 2xx and non-2xx)
        const verdict = evaluateShiprocketResponse(orderCreateJson);

        // Handle both HTTP errors and business logic errors
        if (!verdict.ok) {
          const errorCode = verdict.code;
          const errorMessage = verdict.message;
          const isRetryable = verdict.retryable;

          const failure = await handleJobFailure({
            businessId,
            shop,
            batchRef,
            jobRef,
            jobId,
            errorCode,
            errorMessage,
            isRetryable,
            apiResp: orderCreateJson,
          });

          if (failure.shouldReturnFailure) {
            return void res.status(failure.statusCode).json({
              ok: false,
              reason: failure.reason,
              code: errorCode,
            });
          } else {
            return void res.status(failure.statusCode).json({
              ok: true,
              action: failure.reason,
            });
          }
        }

        // Extract data from successful response
        srOrderId = verdict.orderId ?? orderCreateJson?.order_id;
        srShipmentId = verdict.shipmentId ?? orderCreateJson?.shipment_id;

        if (!srShipmentId) {
          console.log(orderCreateJson);
          // This shouldn't happen with successful verdict, but handle gracefully
          const failure = await handleJobFailure({
            businessId,
            shop,
            batchRef,
            jobRef,
            jobId,
            errorCode: "MISSING_SHIPMENT_ID",
            errorMessage: "Shiprocket returned success but missing shipment_id",
            isRetryable: true,
            apiResp: orderCreateJson,
          });

          if (failure.shouldReturnFailure) {
            return void res.status(failure.statusCode).json({
              ok: false,
              reason: failure.reason,
              code: "MISSING_SHIPMENT_ID",
            });
          } else {
            return void res.status(failure.statusCode).json({
              ok: true,
              action: failure.reason,
            });
          }
        }

        // Persist shipment ID to order document immediately
        await orderRef.set(
          {
            shiprocketOrderId: srOrderId ?? null,
            shiprocketShipmentId: srShipmentId,
          },
          { merge: true },
        );

        // Also store in job for tracking
        await jobRef.set(
          {
            stage: "order_created",
          },
          { merge: true },
        );

        // Wait a second before AWB assignment
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // ---- Shiprocket Assign AWB ----
      const base = "https://apiv2.shiprocket.in";
      const awbPath = "/v1/external/courier/assign/awb";

      const awbResp = await fetch(`${base}${awbPath}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${srToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          shipment_id: srShipmentId,
        }),
      });

      const awbText = await awbResp.text();
      const awbJson = parseJson(awbText);

      // Evaluate response (works for both 2xx and non-2xx)
      const awbVerdict = evaluateShiprocketResponse(awbJson);

      // Handle both HTTP errors and business logic errors
      if (!awbVerdict.ok) {
        const errorCode = awbVerdict.code;
        const errorMessage = awbVerdict.message;
        const isRetryable = awbVerdict.retryable;

        const failure = await handleJobFailure({
          businessId,
          shop,
          batchRef,
          jobRef,
          jobId,
          errorCode,
          errorMessage,
          isRetryable,
          apiResp: awbJson,
        });

        if (failure.shouldReturnFailure) {
          return void res.status(failure.statusCode).json({
            ok: false,
            reason: failure.reason,
            code: errorCode,
          });
        } else {
          return void res.status(failure.statusCode).json({
            ok: true,
            action: failure.reason,
          });
        }
      }

      // Extract AWB data from successful response
      const node = awbJson?.response?.data ?? awbJson?.data ?? awbJson?.response ?? awbJson;
      const awbCode = node?.awb_code ?? null;
      const courierName = node?.courier_name ?? null;
      const courierId = node?.courier_company_id ?? null;

      if (!awbCode) {
        console.log(awbJson);
        // This shouldn't happen with successful verdict, but handle gracefully
        const failure = await handleJobFailure({
          businessId,
          shop,
          batchRef,
          jobRef,
          jobId,
          errorCode: "MISSING_AWB_CODE",
          errorMessage: "Shiprocket returned success but missing AWB code",
          isRetryable: true,
          apiResp: awbJson,
        });

        if (failure.shouldReturnFailure) {
          return void res.status(failure.statusCode).json({
            ok: false,
            reason: failure.reason,
            code: "MISSING_AWB_CODE",
          });
        } else {
          return void res.status(failure.statusCode).json({
            ok: true,
            action: failure.reason,
          });
        }
      }

      // --- Request Shiprocket Pickup (best effort) ---
      let pickupErrorMessage: string | undefined;

      try {
        const pickupResult = await requestShiprocketPickup(srToken, srShipmentId!);

        if (!pickupResult.success) {
          console.warn(`Pickup request failed for job ${jobId}:`, pickupResult.error);
          pickupErrorMessage =
            "Shiprocket: Pickup Request failed, please do it manually on shiprocket";
        }
      } catch (pickupError) {
        console.error(`Pickup request error for job ${jobId}:`, pickupError);
        pickupErrorMessage =
          "Shiprocket: Pickup Request failed, please do it manually on shiprocket";
      }

      // FIX: Atomic success update
      await db.runTransaction(async (tx: Transaction) => {
        const job = await tx.get(jobRef);
        const jobData = job.data();

        if (jobData?.status === "success") {
          return; // Already processed
        }

        const jobUpdate: any = {
          status: "success",
          awb: awbCode,
          carrierShipmentId: srShipmentId ?? null,
          carrier: "Shiprocket",
          courierName: courierName ?? null,
          courierCompanyId: courierId ?? null,
          errorCode: FieldValue.delete(),
          completedAt: FieldValue.serverTimestamp(),
          apiResp: {
            orderCreate: srOrderId ? "persisted" : "reused",
            awbAssign: awbJson,
          },
        };

        if (pickupErrorMessage) {
          jobUpdate.errorMessage = pickupErrorMessage;
        } else {
          jobUpdate.errorMessage = FieldValue.delete();
        }

        tx.update(jobRef, jobUpdate);

        tx.update(batchRef, {
          processing: FieldValue.increment(-1),
          success: FieldValue.increment(1),
        });

        tx.set(
          orderRef,
          {
            awb: awbCode,
            courier: `Shiprocket: ${courierName ?? "Unknown"}`,
            courierProvider: "Shiprocket",
            customStatus: "Ready To Dispatch",
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Ready To Dispatch",
              createdAt: Timestamp.now(),
              remarks: `The order's shipment was successfully made on ${courierName} via Shiprocket (AWB: ${awbCode})`,
            }),
          },
          { merge: true },
        );
      });

      await maybeCompleteBatch(batchRef);

      return void res.json({
        ok: true,
        awb: awbCode,
        carrierShipmentId: srShipmentId ?? null,
        shiprocketOrderId: srOrderId ?? null,
      });
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
          if (awb && !awbReleased) {
            try {
              await releaseAwb(businessId, awb);
              awbReleased = true;
            } catch (e) {
              console.error("Failed to release AWB:", e);
            }
          }

          const batchRef = db
            .collection("accounts")
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
            return void res.status(failure.statusCode).json({
              error: isRetryable ? "job_failed_transient" : "job_failed_permanent",
              code,
              message: msg,
            });
          } else {
            return void res.status(failure.statusCode).json({
              ok: true,
              action: failure.reason,
            });
          }
        }
      } catch (handlerError) {
        console.error("Error in failure handler:", handlerError);
      }

      // Fallback if we couldn't use the handler
      return void res
        .status(isRetryable ? 503 : 200)
        .json(
          isRetryable
            ? { error: "job_failed_transient", details: String(e?.message ?? e) }
            : { ok: false, permanent: true, reason: code },
        );
    }
  },
);
