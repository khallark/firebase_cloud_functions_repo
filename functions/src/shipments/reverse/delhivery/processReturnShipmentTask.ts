import { onRequest } from "firebase-functions/v2/https";
import { NON_RETRYABLE_ERROR_CODES, SHARED_STORE_ID, TASKS_SECRET } from "../../../config";
import {
  BusinessIsAuthorisedToProcessThisOrder,
  maybeCompleteBatch,
  requireHeaderSecret,
} from "../../../helpers";
import { allocateAwb, releaseAwb, sendDTOBookedOrderWhatsAppMessage } from "../../../services";
import { FieldValue, Timestamp, Transaction } from "firebase-admin/firestore";
import { handleReturnJobFailure } from "../helpers";
import { buildDelhiveryReturnPayload } from "../../../couriers";
import { db } from "../../../firebaseAdmin";

const RETURN_NON_RETRYABLE = NON_RETRYABLE_ERROR_CODES;

export const processReturnShipmentTask = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req, res) => {
    let awb: string | undefined;
    let awbReleased = false;

    // --- helpers -------------------------------------------------------------
    const parseJson = (t: string) => {
      try {
        return JSON.parse(t);
      } catch {
        return { raw: t };
      }
    };

    /** Classify Delhivery return response */
    function evalDelhiveryReturnResp(carrier: any): {
      ok: boolean;
      retryable: boolean;
      code: string;
      message: string;
      carrierShipmentId?: string | null;
    } {
      const remarksArr = carrier.packages?.[0]?.remarks;
      let remarks = "";
      if (Array.isArray(remarksArr)) remarks = remarksArr.join("\n ");

      const okFlag = carrier?.success === true && carrier?.error !== true;

      if (okFlag) {
        return {
          ok: true,
          retryable: false,
          code: "OK",
          message: "return created",
          carrierShipmentId: null,
        };
      }

      // Check for insufficient balance error
      const lowerRemarks = remarks.toLowerCase();
      const lowerError = String(carrier?.error || carrier?.message || "").toLowerCase();
      const combinedText = `${lowerRemarks} ${lowerError}`;

      const balanceKeywords = [
        "insufficient",
        "wallet",
        "balance",
        "insufficient balance",
        "low balance",
        "wallet balance",
        "insufficient wallet",
        "insufficient fund",
        "recharge",
        "add balance",
        "balance low",
        "no balance",
      ];

      const isBalanceError = balanceKeywords.some((keyword) => combinedText.includes(keyword));

      if (isBalanceError) {
        return {
          ok: false,
          retryable: false,
          code: "INSUFFICIENT_BALANCE",
          message: remarks || "Insufficient balance in carrier account",
        };
      }

      // Known permanent validation/business errors (non-retryable)
      return {
        ok: false,
        retryable: false,
        code: "CARRIER_AMBIGUOUS",
        message: remarks || "Unknown carrier error",
      };
    }

    /** Decide if an HTTP failure status is retryable */
    function httpRetryable(status: number) {
      if (status === 429 || status === 408 || status === 409 || status === 425) return true;
      if (status >= 500) return true;
      return false;
    }

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

      if (!businessId || !shop || !batchId || !jobId || !pickupName) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      const batchRef = db
        .collection("users")
        .doc(businessId)
        .collection("book_return_batches")
        .doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(String(jobId));
      const orderRef = db.collection("accounts").doc(shop).collection("orders").doc(String(jobId));
      const orderData = (await orderRef.get()).data() as any;
      const businessRef = db.collection("users").doc(businessId);
      const businessData = (await businessRef.get()).data() as any;
      const shopData = (await db.collection("accounts").doc(shop).get()).data() as any;

      // FIX: Atomic idempotency check and status update
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
          return false; // Already failed, don't reprocess
        }

        // Proceed with processing
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

      // Load order first to check status
      const ordSnap = await orderRef.get();
      if (!ordSnap.exists) throw new Error("ORDER_NOT_FOUND");
      const order = ordSnap.data();

      // Check if the shop is exceptional one, if yes, then chekc if the given business is authorised to process this order or not
      if (shop === SHARED_STORE_ID) {
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

      // Check if order is in correct status for return shipment
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
          res.status(failure.statusCode).json({
            ok: true,
            action: failure.reason,
          });
        }
        return;
      }

      // Allocate AWB
      awb = await allocateAwb(businessId);

      // Build payload for Delhivery return
      const payload = buildDelhiveryReturnPayload({
        orderId: String(jobId),
        awb,
        order,
        pickupName,
        shippingMode,
      });

      // Carrier API key
      const apiKey = businessData?.integrations?.couriers?.delhivery?.apiKey as string | undefined;
      if (!apiKey) throw new Error("CARRIER_KEY_MISSING");

      // Call Delhivery
      const base = "https://track.delhivery.com";
      const path = "/api/cmu/create.json";
      const body = new URLSearchParams({ format: "json", data: JSON.stringify(payload) });
      const resp = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });

      const text = await resp.text();

      // Handle HTTP layer errors (non-2xx)
      if (!resp.ok) {
        if (awb && !awbReleased) {
          try {
            await releaseAwb(businessId, awb);
            awbReleased = true;
          } catch (e) {
            console.error("Failed to release AWB:", e);
          }
        }

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
          res.status(failure.statusCode).json({
            ok: true,
            action: failure.reason,
          });
        }
        return;
      }

      // Parse and evaluate carrier JSON
      const carrier = parseJson(text);
      const verdict = evalDelhiveryReturnResp(carrier);

      if (!verdict.ok) {
        if (awb && !awbReleased) {
          try {
            await releaseAwb(businessId, awb);
            awbReleased = true;
          } catch (e) {
            console.error("Failed to release AWB:", e);
          }
        }

        const failure = await handleReturnJobFailure({
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
      awbReleased = true;

      await db.runTransaction(async (tx: Transaction) => {
        const job = await tx.get(jobRef);
        const jobData = job.data();

        // Prevent double-counting
        if (jobData?.status === "success") {
          return; // Already processed
        }

        // Update atomically
        tx.update(jobRef, {
          status: "success",
          awb,
          carrierShipmentId: verdict.carrierShipmentId ?? null,
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
            awb_reverse: awb,
            courier_reverse: "Delhivery",
            courierReverseProvider: "Delhivery",
            customStatus: "DTO Booked",
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "DTO Booked",
              createdAt: Timestamp.now(),
              remarks: `Return shipment was successfully booked on Delhivery (AWB: ${awb})`,
            }),
          },
          { merge: true },
        );
      });

      await maybeCompleteBatch(batchRef);
      await sendDTOBookedOrderWhatsAppMessage(shopData, orderData);

      res.json({ ok: true, awb, carrierShipmentId: verdict.carrierShipmentId ?? null });
      return;
    } catch (e: any) {
      // Generic failure (network/bug/etc.)
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.split(/\s/)[0]; // first token
      const isRetryable = !RETURN_NON_RETRYABLE.has(code);

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
