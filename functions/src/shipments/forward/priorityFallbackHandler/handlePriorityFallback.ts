// functions/src/functions/shipments/forward/handlePriorityFallback.ts

import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";
import { FieldValue, Transaction } from "firebase-admin/firestore";
import { createTask } from "../../../services";
import { TASKS_SECRET } from "../../../config";
import { capitalizeWords, maybeCompleteBatch, requireHeaderSecret } from "../../../helpers";
import { db } from "../../../firebaseAdmin";

/**
 * Handles priority courier fallback logic
 * When priority courier fails, attempts next courier in priority list
 */
export const handlePriorityFallback = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");
      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { businessId, shop, batchId, jobId } = req.body;
      if (!businessId || !shop || !batchId || !jobId) {
        res.status(400).json({ error: "missing_required_params" });
        return;
      }

      const batchRef = db
        .collection("users")
        .doc(businessId)
        .collection("shipment_batches")
        .doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(jobId);

      // FIX: Atomic status check and update inside transaction
      const fallbackInfo = await db.runTransaction(async (tx: Transaction) => {
        const [jobSnap, batchSnap, businessSnap] = await Promise.all([
          tx.get(jobRef),
          tx.get(batchRef),
          tx.get(db.collection("user").doc(businessId)),
        ]);

        if (!jobSnap.exists || !batchSnap.exists || !businessSnap.exists) {
          throw new Error("DOCUMENTS_NOT_FOUND");
        }

        const jobData = jobSnap.data()!;
        const batchData = batchSnap.data()!;
        const businessDoc = businessSnap.data()!;

        // FIX: Check terminal states atomically
        if (["processing", "success", "failed"].includes(jobData.status)) {
          return { action: "already_handled", status: jobData.status };
        }

        // Only handle attempting_fallback status
        if (jobData.status !== "attempting_fallback") {
          return { action: "invalid_state", status: jobData.status };
        }

        if (batchData.courier !== "Priority") {
          throw new Error("NOT_PRIORITY_JOB");
        }

        const priorityList = businessDoc?.integrations?.couriers?.priorityList || [];
        if (!Array.isArray(priorityList) || priorityList.length === 0) {
          tx.update(jobRef, {
            status: "failed",
            errorCode: "PRIORITY_LIST_NOT_CONFIGURED",
            errorMessage: "Priority list not configured",
            finalFailedAt: FieldValue.serverTimestamp(),
          });
          tx.update(batchRef, { failed: FieldValue.increment(1) });
          return { action: "no_priority_list" };
        }

        const currentCourier = jobData.courier || capitalizeWords(priorityList[0]?.name);
        const currentIndex = priorityList.findIndex(
          (c: any) => capitalizeWords(c?.name) === currentCourier,
        );

        if (currentIndex === -1 || currentIndex >= priorityList.length - 1) {
          // No more fallback options
          const lastError = jobData.lastErrorMessage || jobData.errorMessage || "Unknown error";
          const lastErrorCode = jobData.lastErrorCode || jobData.errorCode || "UNKNOWN";

          tx.update(jobRef, {
            status: "failed",
            errorCode: lastErrorCode,
            errorMessage: `${currentCourier}: ${lastError}`,
            allCouriersExhausted: true,
            triedCouriers: (jobData.previousCouriers || []).concat(currentCourier),
            finalFailedAt: FieldValue.serverTimestamp(),
          });
          tx.update(batchRef, { failed: FieldValue.increment(1) });

          return {
            action: "no_fallback_available",
            triedCouriers: (jobData.previousCouriers || []).concat(currentCourier),
          };
        }

        // Queue next courier
        const nextIndex = currentIndex + 1;
        const nextCourier = capitalizeWords(priorityList[nextIndex]?.name);
        const courierLower = priorityList[nextIndex]?.name.toLowerCase();

        tx.update(jobRef, {
          status: "fallback_queued",
          courier: nextCourier,
          attempts: 0,
          previousCouriers: FieldValue.arrayUnion(currentCourier),
          fallbackAttempt: (jobData.fallbackAttempt || 0) + 1,
          lastFallbackAt: FieldValue.serverTimestamp(),
          errorCode: FieldValue.delete(),
          errorMessage: FieldValue.delete(),
        });

        return {
          action: "queue_fallback",
          nextCourier,
          courierLower,
          currentCourier,
          pickupName: batchData.pickupName,
          shippingMode: batchData.shippingMode,
        };
      });

      // Handle transaction results
      if (fallbackInfo.action === "already_handled") {
        res.json({ ok: true, action: "already_handled", status: fallbackInfo.status });
        return;
      }

      if (
        fallbackInfo.action === "no_priority_list" ||
        fallbackInfo.action === "no_fallback_available"
      ) {
        await maybeCompleteBatch(batchRef);
        res.json({
          ok: true,
          action: fallbackInfo.action,
          triedCouriers: fallbackInfo.triedCouriers,
        });
        return;
      }

      if (fallbackInfo.action === "queue_fallback") {
        // Determine target URL
        const url = (() => {
          if (fallbackInfo.courierLower === "delhivery") {
            return String(process.env.SHIPMENT_TASK_TARGET_URL_1);
          }
          if (fallbackInfo.courierLower === "shiprocket") {
            return String(process.env.SHIPMENT_TASK_TARGET_URL_2);
          }
          if (fallbackInfo.courierLower === "xpressbees") {
            return String(process.env.SHIPMENT_TASK_TARGET_URL_3);
          }
          throw new Error(`Unsupported fallback courier: ${fallbackInfo.courierLower}`);
        })();

        await createTask(
          {
            businessId,
            shop,
            batchId,
            jobId,
            pickupName: fallbackInfo.pickupName,
            shippingMode: fallbackInfo.shippingMode,
          } as any,
          {
            tasksSecret: TASKS_SECRET.value() || "",
            url,
            queue: String(process.env.SHIPMENT_QUEUE_NAME) || "shipments-queue",
            delaySeconds: 5,
          },
        );

        res.json({
          ok: true,
          action: "fallback_queued",
          fromCourier: fallbackInfo.currentCourier,
          toCourier: fallbackInfo.nextCourier,
        });
      }
    } catch (error: any) {
      console.error("handlePriorityFallback error:", error);

      // Mark job as failed on handler error
      try {
        const { businessId, batchId, jobId } = req.body;
        if (businessId && batchId && jobId) {
          const batchRef = db
            .collection("users")
            .doc(businessId)
            .collection("shipment_batches")
            .doc(batchId);
          const jobRef = batchRef.collection("jobs").doc(jobId);

          // FIX: Use transaction for cleanup
          await db.runTransaction(async (tx: Transaction) => {
            const job = await tx.get(jobRef);
            if (job.data()?.status !== "failed") {
              tx.update(jobRef, {
                status: "failed",
                errorCode: "FALLBACK_HANDLER_ERROR",
                errorMessage: `Fallback handler error: ${error.message}`,
                finalFailedAt: FieldValue.serverTimestamp(),
              });
              tx.update(batchRef, {
                processing: FieldValue.increment(-1),
                failed: FieldValue.increment(1),
              });
            }
          });

          await maybeCompleteBatch(batchRef);
        }
      } catch (e) {
        console.error("Failed to update job after handler error:", e);
      }

      res.status(500).json({
        error: "fallback_handler_failed",
        message: error.message || String(error),
      });
    }
  },
);
