// functions/src/functions/shipments/forward/processBlueDartShipmentTask.ts

import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";
import { FieldValue, Transaction, Timestamp } from "firebase-admin/firestore";
import { buildBlueDartPayload, evaluateBlueDartResponse, getBlueDartToken } from "../../../couriers";
import { NON_RETRYABLE } from "../../helpers";
import { TASKS_SECRET, SHARED_STORE_IDS } from "../../../config";
import {
  BusinessIsAuthorisedToProcessThisOrder,
  handleJobFailure,
  httpRetryable,
  maybeCompleteBatch,
  parseJson,
  requireHeaderSecret,
} from "../../../helpers";
import { db } from "../../../firebaseAdmin";

// Helper function - sanitize for Firestore
function sanitizeForFirestore(obj: any): any {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeForFirestore);

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;

    const safeKey = key
      .replace(/\./g, "_")
      .replace(/\[/g, "_")
      .replace(/\]/g, "_")
      .replace(/\*/g, "_")
      .replace(/\//g, "_");

    result[safeKey] = sanitizeForFirestore(value);
  }
  return result;
}

/**
 * Processes a single shipment task for Blue Dart
 */
export const processBlueDartShipmentTask = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {

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

      // Atomic idempotency check and status update
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

        // Proceed with processing
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

      // Load order first to check status
      const ordSnap = await orderRef.get();
      if (!ordSnap.exists) throw new Error("ORDER_NOT_FOUND");
      const order = ordSnap.data();

      // Get business configuration
      const businessDoc = await businessRef.get();
      const batchData = (await batchRef.get()).data();
      const businessData = businessDoc.data();

      // Check authorization for shared stores
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
                ? "Some internal error occurred while checking for authorization"
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

      // Check if order is in correct status for shipping
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

      // Get Blue Dart configuration
      const blueDartConfig = businessData?.integrations?.couriers?.bluedart;

      // Determine if this is a priority shipment
      const isPriority = batchData?.courier === "Priority";

      if (isPriority) {
        const priorityCouriers = businessData?.integrations?.couriers?.priorityList;
        const blueDartPriorityConfig = priorityCouriers?.find(
          (courier: any) => courier.name === "bluedart"
        );

        if (blueDartPriorityConfig?.customerCode) {
          // Use priority config if available
          blueDartConfig.customerCode = blueDartPriorityConfig.customerCode;
        }
      }

      const customerCode = blueDartConfig?.customerCode as string | undefined;
      const loginId = blueDartConfig?.loginId as string | undefined;
      const licenceKey = blueDartConfig?.licenceKey as string | undefined;

      if (!customerCode || !loginId || !licenceKey) {
        throw new Error("BLUEDART_CONFIG_MISSING");
      }

      // Get JWT token for authentication
      let jwtToken: string;
      try {
        jwtToken = await getBlueDartToken();
      } catch (authError: any) {
        const failure = await handleJobFailure({
          businessId,
          shop,
          batchRef,
          jobRef,
          jobId,
          errorCode: authError.message.split(/\s/)[0],
          errorMessage: authError.message,
          isRetryable: authError.message.includes("NETWORK") || authError.message.includes("HTTP_5"),
        });

        if (failure.shouldReturnFailure) {
          res.status(failure.statusCode).json({
            ok: false,
            reason: failure.reason,
            code: authError.message.split(/\s/)[0],
          });
        } else {
          res.status(failure.statusCode).json({
            ok: true,
            action: failure.reason,
          });
        }
        return;
      }

      // Build payload for Blue Dart
      const payload = buildBlueDartPayload({
        orderId: String(jobId),
        order,
        pickupName,
        customerCode,
        loginId,
        licenceKey,
      });

      // Call Blue Dart API
      const apiUrl = "https://apigateway.bluedart.com/in/transportation/waybill/v1/GenerateWayBill";

      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: {
          JWTToken: jwtToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      const text = await resp.text();

      // Handle HTTP layer errors (non-2xx)
      if (!resp.ok) {
        const failure = await handleJobFailure({
          businessId,
          shop,
          batchRef,
          jobRef,
          jobId,
          errorCode: `HTTP_${resp.status}`,
          errorMessage: text,
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

      // Parse and evaluate carrier JSON
      const carrier = parseJson(text);
      const verdict = evaluateBlueDartResponse(carrier);

      if (!verdict.ok || !verdict.awbNo) {
        throw new Error("BLUEDART_SUCCESS_WITHOUT_AWB");
      }

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
          apiResp: sanitizeForFirestore(carrier),
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
      await db.runTransaction(async (tx: Transaction) => {
        const job = await tx.get(jobRef);
        const jobData = job.data();

        // Prevent double-counting
        if (jobData?.status === "success") {
          return;
        }

        if (!verdict.awbNo) {
          throw new Error("BLUEDART_AWB_MISSING_IN_RESPONSE");
        }

        // Update atomically
        tx.update(jobRef, {
          status: "success",
          awb: verdict.awbNo,
          carrierShipmentId: verdict.carrierShipmentId ?? null,
          tokenNumber: verdict.tokenNumber ?? null,
          errorCode: FieldValue.delete(),
          errorMessage: FieldValue.delete(),
          apiResp: sanitizeForFirestore(carrier),
          completedAt: FieldValue.serverTimestamp(),
        });

        tx.update(batchRef, {
          processing: FieldValue.increment(-1),
          success: FieldValue.increment(1),
        });

        tx.set(
          orderRef,
          {
            awb: verdict.awbNo,
            courier: "Blue Dart",
            courierProvider: "Blue Dart",
            customStatus: "Ready To Dispatch",
            shippingMode,
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Ready To Dispatch",
              createdAt: Timestamp.now(),
              remarks: `The order's shipment was successfully made on Blue Dart (${shippingMode}) (AWB: ${verdict.awbNo})`,
            }),
          },
          { merge: true },
        );
      });

      await maybeCompleteBatch(batchRef);

      res.json({
        ok: true,
        awb: verdict.awbNo,
        carrierShipmentId: verdict.carrierShipmentId ?? null,
        tokenNumber: verdict.tokenNumber ?? null
      });
      return;
    } catch (e: any) {
      // Generic failure (network/bug/etc.)
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.split(/\s/)[0];
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