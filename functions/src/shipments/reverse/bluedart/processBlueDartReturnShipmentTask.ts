// functions/src/functions/shipments/return/processBlueDartReturnShipmentTask.ts

import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";
import { FieldValue, Transaction, Timestamp } from "firebase-admin/firestore";
import {
  buildBlueDartReturnPayload,
  evaluateBlueDartResponse,
  getBlueDartToken,
} from "../../../couriers";
import { NON_RETRYABLE_ERROR_CODES, SHARED_STORE_IDS, TASKS_SECRET } from "../../../config";
import {
  BusinessIsAuthorisedToProcessThisOrder,
  httpRetryable,
  maybeCompleteBatch,
  parseJson,
  requireHeaderSecret,
} from "../../../helpers";
import { handleReturnJobFailure } from "../helpers";
import { sendDTOBookedOrderWhatsAppMessage } from "../../../services";
import { db } from "../../../firebaseAdmin";

// ---------------------------------------------------------------------------
// Sanitize nested objects before writing to Firestore
// (mirrors the same helper in the forward BlueDart task)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------

export const processBlueDartReturnShipmentTask = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      // ── Auth + method guard ─────────────────────────────────────────────
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");
      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { businessId, shop, batchId, jobId, shippingMode } = (req.body || {}) as {
        businessId?: string;
        shop?: string;
        batchId?: string;
        jobId?: string;
        shippingMode?: string;
      };

      if (!shippingMode || !businessId || !shop || !batchId || !jobId) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      // ── Firestore refs ──────────────────────────────────────────────────
      const batchRef = db
        .collection("users")
        .doc(businessId)
        .collection("book_return_batches")
        .doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(String(jobId));
      const orderRef = db.collection("accounts").doc(shop).collection("orders").doc(String(jobId));
      const businessRef = db.collection("users").doc(businessId);

      // ── Atomic idempotency check + status update ────────────────────────
      const shouldProceed = await db.runTransaction(async (tx: Transaction) => {
        const job = await tx.get(jobRef);
        const jobData = job.data();

        if (jobData?.status === "success") {
          const batch = await tx.get(batchRef);
          const batchData = batch.data() || {};
          if ((batchData.processing || 0) > 0) {
            tx.update(batchRef, { processing: FieldValue.increment(-1) });
          }
          return false;
        }

        if (jobData?.status === "failed") {
          return false; // Already failed, don't reprocess
        }

        const prevAttempts = Number(jobData?.attempts || 0);
        const jobStatus = jobData?.status;
        const firstAttempt = prevAttempts === 0 || jobStatus === "queued" || !jobStatus;

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

      // ── Load order ──────────────────────────────────────────────────────
      const ordSnap = await orderRef.get();
      if (!ordSnap.exists) throw new Error("ORDER_NOT_FOUND");
      const order = ordSnap.data();

      const businessDoc = await businessRef.get();
      const businessData = businessDoc.data();
      const shopData = (await db.collection("accounts").doc(shop).get()).data() as any;

      // ── Authorization check for shared/multi-vendor stores ──────────────
      if (SHARED_STORE_IDS.includes(shop)) {
        const vendorName = businessData?.vendorName;
        const vendors = order?.vendors;
        const canProcess = BusinessIsAuthorisedToProcessThisOrder(businessId, vendorName, vendors);

        if (!canProcess.authorised) {
          const failure = await handleReturnJobFailure({
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
            res.status(failure.statusCode).json({ ok: true, action: failure.reason });
          }
          return;
        }
      }

      // ── Order status gate ───────────────────────────────────────────────
      const status = order?.customStatus;
      if (status !== "Delivered" && status !== "DTO Requested") {
        const failure = await handleReturnJobFailure({
          shop,
          batchRef,
          jobRef,
          jobId,
          errorCode: "INVALID_ORDER_STATUS",
          errorMessage: `Order status is '${status}' - not 'Delivered' or 'DTO Requested'. Cannot book return.`,
          isRetryable: false,
        });

        if (failure.shouldReturnFailure) {
          res.status(failure.statusCode).json({
            ok: false,
            reason: failure.reason,
            code: "INVALID_ORDER_STATUS",
          });
        } else {
          res.status(failure.statusCode).json({ ok: true, action: failure.reason });
        }
        return;
      }

      // ── Blue Dart config ────────────────────────────────────────────────
      const blueDartConfig = businessData?.integrations?.couriers?.bluedart;

      const customerCode = blueDartConfig?.customerCode as string | undefined;
      const loginId = blueDartConfig?.loginId as string | undefined;
      const licenceKey = blueDartConfig?.licenceKey as string | undefined;
      const appApiKey = blueDartConfig?.appApiKey as string | undefined;
      const appApiSecret = blueDartConfig?.appApiSecret as string | undefined;

      if (!customerCode || !loginId || !licenceKey || !appApiKey || !appApiSecret) {
        throw new Error("BLUEDART_CONFIG_MISSING");
      }

      // ── JWT token ───────────────────────────────────────────────────────
      let jwtToken: string;
      try {
        jwtToken = await getBlueDartToken(appApiKey, appApiSecret);
      } catch (authError: any) {
        const failure = await handleReturnJobFailure({
          shop,
          batchRef,
          jobRef,
          jobId,
          errorCode: authError.message.split(/\s/)[0],
          errorMessage: authError.message,
          isRetryable:
            authError.message.includes("NETWORK") || authError.message.includes("HTTP_5"),
        });

        if (failure.shouldReturnFailure) {
          res.status(failure.statusCode).json({
            ok: false,
            reason: failure.reason,
            code: authError.message.split(/\s/)[0],
          });
        } else {
          res.status(failure.statusCode).json({ ok: true, action: failure.reason });
        }
        return;
      }

      // ── Build return payload ────────────────────────────────────────────
      const payload = buildBlueDartReturnPayload({
        orderId: String(jobId),
        order,
        customerCode,
        loginId,
        licenceKey,
      });

      // ── Call Blue Dart GenerateWayBill API ──────────────────────────────
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

      // ── HTTP-layer errors ───────────────────────────────────────────────
      if (!resp.ok) {
        const failure = await handleReturnJobFailure({
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
          res.status(failure.statusCode).json({ ok: true, action: failure.reason });
        }
        return;
      }

      // ── Parse + evaluate carrier response ──────────────────────────────
      const carrier = parseJson(text);
      const verdict = evaluateBlueDartResponse(carrier);

      // Guard: success without AWB is a hard error
      if (verdict.ok && !verdict.awbNo) {
        throw new Error("BLUEDART_SUCCESS_WITHOUT_AWB");
      }

      if (!verdict.ok) {
        const failure = await handleReturnJobFailure({
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
          res.status(failure.statusCode).json({ ok: true, action: failure.reason });
        }
        return;
      }

      // ── Success path (atomic) ───────────────────────────────────────────
      const awb = verdict.awbNo!;

      await db.runTransaction(async (tx: Transaction) => {
        const job = await tx.get(jobRef);
        const jobData = job.data();

        if (jobData?.status === "success") {
          return; // Already processed — prevent double-counting
        }

        tx.update(jobRef, {
          status: "success",
          awb,
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
            awb_reverse: awb,
            courier_reverse: "Blue Dart",
            courierReverseProvider: "Blue Dart",
            customStatus: "DTO Booked",
            customStatusesLogs: FieldValue.arrayUnion({
              status: "DTO Booked",
              createdAt: Timestamp.now(),
              remarks: `Return shipment was successfully booked on Blue Dart (AWB: ${awb})`,
            }),
          },
          { merge: true },
        );
      });

      await maybeCompleteBatch(batchRef);
      await sendDTOBookedOrderWhatsAppMessage(shopData, order);

      res.json({
        ok: true,
        awb,
        carrierShipmentId: verdict.carrierShipmentId ?? null,
        tokenNumber: verdict.tokenNumber ?? null,
      });
      return;
    } catch (e: any) {
      // ── Generic / unexpected failure ────────────────────────────────────
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.split(/\s/)[0];
      const isRetryable = !NON_RETRYABLE_ERROR_CODES.has(code);

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
            .collection("book_return_batches")
            .doc(batchId);
          const jobRef = batchRef.collection("jobs").doc(String(jobId));

          const failure = await handleReturnJobFailure({
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
            res.status(failure.statusCode).json({ ok: true, action: failure.reason });
          }
          return;
        }
      } catch (handlerError) {
        console.error("Error in failure handler:", handlerError);
      }

      // Fallback if refs weren't available
      if (isRetryable) {
        res.status(503).json({ error: "job_failed_transient", code, message: msg });
      } else {
        res.status(200).json({ ok: false, permanent: true, reason: code, message: msg });
      }
    }
  },
);
