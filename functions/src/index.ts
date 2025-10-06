// functions/src/index.ts
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/scheduler";
import type { Request, Response } from "express";
import fetch from "node-fetch";
import { db, FieldValue } from "./firebaseAdmin";
import { createTask } from "./cloudTasks";
import { allocateAwb, releaseAwb } from "./awb";
import { buildDelhiveryPayload, buildShiprocketPayload } from "./buildPayload";
import { defineSecret } from "firebase-functions/params";
import { setGlobalOptions } from "firebase-functions/options";
import { DocumentReference, Timestamp } from "firebase-admin/firestore";

setGlobalOptions({ region: process.env.LOCATION || "asia-south1" });

const TASKS_SECRET = defineSecret("TASKS_SECRET");
const ENQUEUE_FUNCTION_SECRET = defineSecret("ENQUEUE_FUNCTION_SECRET");

/** Small helper to require a shared secret header */
function requireHeaderSecret(req: Request, header: string, expected: string) {
  const got = (req.get(header) || "").trim();
  if (!got || got !== (expected || "").trim()) throw new Error(`UNAUTH_${header}`);
}

function capitalizeWords(sentence: string): string {
  if (!sentence) return sentence;
  return sentence
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

async function maybeCompleteBatch(batchRef: DocumentReference): Promise<void> {
  await db.runTransaction(async (tx) => {
    const b = await tx.get(batchRef);
    const d = b.data() || {};
    const total = Number(d.total || 0);
    const success = Number(d.success || 0);
    const failed = Number(d.failed || 0);
    const processing = Number(d.processing || 0);
    if (total && success + failed === total && processing === 0) {
      tx.update(batchRef, {
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}

async function handleJobFailure(params: {
  shop: string;
  batchRef: DocumentReference;
  jobRef: DocumentReference;
  jobId: string;
  errorCode: string;
  errorMessage: string;
  isRetryable: boolean;
  apiResp?: any;
}): Promise<{ shouldReturnFailure: boolean; statusCode: number; reason: string }> {
  const { shop, batchRef, jobRef, jobId, errorCode, errorMessage, isRetryable, apiResp } = params;

  const jobSnap = await jobRef.get();
  const batchSnap = await batchRef.get();
  const jobData = jobSnap.data() || {};
  const batchData = batchSnap.data() || {};

  const attempts = Number(jobData.attempts || 0);
  const maxAttempts = Number(process.env.SHIPMENT_QUEUE_MAX_ATTEMPTS || 3);
  const attemptsExhausted = attempts >= maxAttempts;

  // Check if this is a Priority job
  const isPriority = batchData.courier === "Priority";

  // Priority fallback conditions:
  // 1. It's a Priority job
  // 2. Either attempts exhausted OR non-retryable error
  // 3. Has fallback handler URL configured
  const shouldAttemptFallback = isPriority && (attemptsExhausted || !isRetryable);
  const fallbackUrl = process.env.PRIORITY_FALLBACK_HANDLER_URL;

  if (shouldAttemptFallback && fallbackUrl) {
    try {
      // Mark job as attempting fallback
      await jobRef.update({
        status: "attempting_fallback",
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage.slice(0, 400),
        lastFailedAt: FieldValue.serverTimestamp(),
        ...(apiResp && { lastApiResp: apiResp }),
      });

      // Queue fallback handler task
      await createTask(
        { shop, batchId: batchRef.id, jobId },
        {
          tasksSecret: TASKS_SECRET.value() || "",
          url: fallbackUrl,
          queue: String(process.env.SHIPMENT_QUEUE_NAME) || "shipments-queue",
          delaySeconds: 2,
        },
      );

      console.log(`Priority fallback triggered for job ${jobId} after ${errorCode}`);

      // Don't return failure - fallback handler will decide final outcome
      // Return 200 to prevent Cloud Tasks from retrying this task
      return {
        shouldReturnFailure: false,
        statusCode: 200,
        reason: "fallback_queued",
      };
    } catch (fallbackError) {
      console.error("Failed to queue fallback handler:", fallbackError);
      // Fall through to normal failure handling
    }
  }

  // Normal failure handling (non-Priority or fallback failed)
  const updateData: any = {
    status: isRetryable ? (attemptsExhausted ? "failed" : "retrying") : "failed",
    errorCode: isRetryable ? "EXCEPTION" : errorCode,
    errorMessage: errorMessage.slice(0, 400),
  };

  if (apiResp) {
    updateData.apiResp = apiResp;
  }

  await Promise.all([
    jobRef.set(updateData, { merge: true }),
    batchRef.update(
      isRetryable && !attemptsExhausted
        ? { processing: FieldValue.increment(-1) }
        : { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) },
    ),
  ]);

  if (!isRetryable || attemptsExhausted) {
    await maybeCompleteBatch(batchRef);
  }

  return {
    shouldReturnFailure: true,
    statusCode: isRetryable && !attemptsExhausted ? 503 : 200,
    reason: isRetryable ? "retryable_error" : "permanent_error",
  };
}

/** Called by Vercel API to enqueue Cloud Tasks (one per jobId) */
export const enqueueShipmentTasks = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [ENQUEUE_FUNCTION_SECRET, TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { shop, orders, courier, pickupName, shippingMode, requestedBy } = (req.body || {}) as {
        shop?: string;
        orders?: string;
        courier?: string;
        pickupName?: string;
        shippingMode?: string;
        requestedBy?: string;
      };

      if (
        !shop ||
        !courier ||
        !pickupName ||
        !shippingMode ||
        !Array.isArray(orders) ||
        orders.length === 0
      ) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      const shopDoc = (await db.collection("accounts").doc(shop).get()).data();
      if (!shopDoc) {
        res.status(400).json({ error: "shop_not_found" });
        return;
      }

      const priorityCourier =
        courier === "Priority"
          ? shopDoc?.integrations?.couriers?.priorityList?.[0]?.toLowerCase()
          : null;

      const url = (() => {
        if (courier === "Delhivery") return String(process.env.SHIPMENT_TASK_TARGET_URL_1);
        if (courier === "Shiprocket") return String(process.env.SHIPMENT_TASK_TARGET_URL_2);

        if (courier === "Priority") {
          if (!priorityCourier) {
            throw new Error("Priority courier not configured in shop settings");
          }
          if (priorityCourier === "delhivery")
            return String(process.env.SHIPMENT_TASK_TARGET_URL_1);
          if (priorityCourier === "shiprocket")
            return String(process.env.SHIPMENT_TASK_TARGET_URL_2);
          throw new Error(`Unsupported priority courier: ${priorityCourier}`);
        }

        throw new Error(`Unsupported courier: ${courier}`);
      })();

      // 1) Create batch header
      const batchRef = db.collection("accounts").doc(shop).collection("shipment_batches").doc();

      await batchRef.set({
        shop,
        courier,
        pickupName,
        shippingMode,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: requestedBy, // <-- stamp UID
        total: orders.length,
        queued: orders.length,
        status: "running", // queued | running | complete
        processing: 0,
        success: 0,
        failed: 0,
      });

      // 2) Create job docs
      const writer = db.bulkWriter();

      for (const o of orders) {
        writer.set(
          batchRef.collection("jobs").doc(String(o.orderId)),
          {
            orderId: String(o.orderId),
            ...(courier === "Priority" ? { courier: capitalizeWords(priorityCourier) } : {}),
            orderName: o.name,
            status: "queued",
            attempts: 0,
          },
          { merge: true },
        );
      }
      await writer.close();

      const batchId = batchRef.id;
      const jobIds = orders.map((o) => String(o.orderId));

      // Create one Cloud Task per job
      await Promise.all(
        jobIds.map((jobId) =>
          createTask({ shop, batchId, courier, jobId, pickupName, shippingMode } as any, {
            tasksSecret: TASKS_SECRET.value() || "",
            url,
            queue: String(process.env.SHIPMENT_QUEUE_NAME) || "shipments-queue",
          }),
        ),
      );

      await batchRef.update({ status: "running" });
      res.status(202).json({ collectionName: "shipment_batches", batchId });
      return;
    } catch (e: any) {
      console.error("enqueue error:", e);
      res.status(500).json({ error: "start_batch_failed", details: String(e?.message ?? e) });
      return;
    }
  },
);

// outer catch non-retryable error codes
const NON_RETRYABLE = new Set(["CARRIER_KEY_MISSING", "ORDER_NOT_FOUND"]);

// ============================================================================
// PRIORITY FALLBACK HANDLER
// ============================================================================

/**
 * Handles Priority courier fallback when a courier fails after exhausting attempts.
 * Checks if there's a next courier in the priority list and queues a new task for it.
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

      const { shop, batchId, jobId } = req.body as {
        shop?: string;
        batchId?: string;
        jobId?: string;
      };

      if (!shop || !batchId || !jobId) {
        res.status(400).json({ error: "missing_required_params" });
        return;
      }

      const batchRef = db
        .collection("accounts")
        .doc(shop)
        .collection("shipment_batches")
        .doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(jobId);

      // Get job, batch, and shop data
      const [jobSnap, batchSnap, shopSnap] = await Promise.all([
        jobRef.get(),
        batchRef.get(),
        db.collection("accounts").doc(shop).get(),
      ]);

      if (!jobSnap.exists || !batchSnap.exists || !shopSnap.exists) {
        res.status(404).json({ error: "documents_not_found" });
        return;
      }

      const jobData = jobSnap.data()!;
      const batchData = batchSnap.data()!;
      const shopDoc = shopSnap.data()!;

      // Only handle Priority jobs
      if (batchData.courier !== "Priority") {
        res.status(400).json({ error: "not_a_priority_job" });
        return;
      }

      // Get priority list from shop config
      const priorityList = shopDoc?.integrations?.couriers?.priorityList || [];
      if (!Array.isArray(priorityList) || priorityList.length === 0) {
        // No priority list configured, mark as permanently failed
        await Promise.all([
          jobRef.update({
            status: "failed",
            errorCode: "PRIORITY_LIST_NOT_CONFIGURED",
            errorMessage: "Priority courier list not configured in shop settings",
            finalFailedAt: FieldValue.serverTimestamp(),
          }),
          batchRef.update({
            processing: FieldValue.increment(-1),
            failed: FieldValue.increment(1),
          }),
        ]);

        await maybeCompleteBatch(batchRef);
        res.status(400).json({ error: "priority_list_not_configured" });
        return;
      }

      // Determine current courier and find its index
      const currentCourier = jobData.courier || capitalizeWords(priorityList[0]);
      const currentIndex = priorityList.findIndex(
        (c: string) => capitalizeWords(c) === currentCourier,
      );

      if (currentIndex === -1) {
        // Current courier not in list, mark as failed
        await Promise.all([
          jobRef.update({
            status: "failed",
            errorCode: "COURIER_NOT_IN_PRIORITY_LIST",
            errorMessage: `Current courier ${currentCourier} not found in priority list`,
            finalFailedAt: FieldValue.serverTimestamp(),
          }),
          batchRef.update({
            processing: FieldValue.increment(-1),
            failed: FieldValue.increment(1),
          }),
        ]);

        await maybeCompleteBatch(batchRef);
        res.status(400).json({ error: "current_courier_not_in_priority_list" });
        return;
      }

      const nextIndex = currentIndex + 1;

      // Check if there's a next courier available
      if (nextIndex >= priorityList.length) {
        // No more fallback couriers, mark as permanently failed
        // FIX: Use the actual last error instead of generic message
        const lastError = jobData.lastErrorMessage || jobData.errorMessage || "Unknown error";
        const lastErrorCode = jobData.lastErrorCode || jobData.errorCode || "UNKNOWN";

        await Promise.all([
          jobRef.update({
            status: "failed",
            errorCode: lastErrorCode,
            errorMessage: `${currentCourier}: ${lastError}`,
            allCouriersExhausted: true,
            triedCouriers: (jobData.previousCouriers || []).concat(currentCourier),
            finalFailedAt: FieldValue.serverTimestamp(),
          }),
          batchRef.update({
            processing: FieldValue.increment(-1),
            failed: FieldValue.increment(1),
          }),
        ]);

        await maybeCompleteBatch(batchRef);

        res.json({
          ok: true,
          action: "no_fallback_available",
          message: "All priority couriers exhausted",
          triedCouriers: (jobData.previousCouriers || []).concat(currentCourier),
        });
        return;
      }

      // Get next courier
      const nextCourier = capitalizeWords(priorityList[nextIndex]);

      // Determine target URL for next courier
      const url = (() => {
        const courierLower = priorityList[nextIndex].toLowerCase();
        if (courierLower === "delhivery") {
          return String(process.env.SHIPMENT_TASK_TARGET_URL_1);
        }
        if (courierLower === "shiprocket") {
          return String(process.env.SHIPMENT_TASK_TARGET_URL_2);
        }
        throw new Error(`Unsupported fallback courier: ${courierLower}`);
      })();

      // Update job document with fallback info
      const previousCouriers = jobData.previousCouriers || [];
      await jobRef.update({
        status: "fallback_queued",
        courier: nextCourier,
        attempts: 0, // Reset attempts for new courier
        previousCouriers: FieldValue.arrayUnion(currentCourier),
        fallbackAttempt: (jobData.fallbackAttempt || 0) + 1,
        lastFallbackAt: FieldValue.serverTimestamp(),
        // Clear old error fields
        errorCode: FieldValue.delete(),
        errorMessage: FieldValue.delete(),
      });

      // Create new Cloud Task for fallback courier
      await createTask(
        {
          shop,
          batchId,
          jobId,
          pickupName: batchData.pickupName,
          shippingMode: batchData.shippingMode,
        } as any,
        {
          tasksSecret: TASKS_SECRET.value() || "",
          url,
          queue: String(process.env.SHIPMENT_QUEUE_NAME) || "shipments-queue",
          delaySeconds: 5, // Small delay before retry with new courier
        },
      );

      console.log(
        `Priority fallback: ${currentCourier} → ${nextCourier} for job ${jobId} (attempt ${(jobData.fallbackAttempt || 0) + 1})`,
      );

      res.json({
        ok: true,
        action: "fallback_queued",
        fromCourier: currentCourier,
        toCourier: nextCourier,
        fallbackAttempt: (jobData.fallbackAttempt || 0) + 1,
        previousCouriers: previousCouriers.concat(currentCourier),
      });
    } catch (error: any) {
      console.error("handlePriorityFallback error:", error);

      // Try to mark job as failed on handler error
      try {
        const { shop, batchId, jobId } = req.body;
        if (shop && batchId && jobId) {
          const batchRef = db
            .collection("accounts")
            .doc(shop)
            .collection("shipment_batches")
            .doc(batchId);
          const jobRef = batchRef.collection("jobs").doc(jobId);

          await Promise.all([
            jobRef.update({
              status: "failed",
              errorCode: "FALLBACK_HANDLER_ERROR",
              errorMessage: `Fallback handler error: ${error.message || String(error)}`,
              finalFailedAt: FieldValue.serverTimestamp(),
            }),
            batchRef.update({
              processing: FieldValue.increment(-1),
              failed: FieldValue.increment(1),
            }),
          ]);

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

/** Cloud Tasks → processes exactly ONE shipment job */
export const processShipmentTask = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
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

    /** Classify Delhivery create-shipment response */
    function evalDelhiveryResp(carrier: any): {
      ok: boolean;
      retryable: boolean;
      code: string;
      message: string;
      carrierShipmentId?: string | null;
    } {
      const remarksArr = carrier.packages?.[0]?.remarks;
      let remarks = "";
      if (Array.isArray(remarksArr)) remarks = remarksArr.join("\n ");

      // Success signals seen in Delhivery responses
      const waybill =
        carrier?.shipment_id ?? carrier?.packets?.[0]?.waybill ?? carrier?.waybill ?? null;

      const okFlag = (carrier?.success === true && carrier?.error !== true) || Boolean(waybill);

      if (okFlag) {
        return {
          ok: true,
          retryable: false,
          code: "OK",
          message: "created",
          carrierShipmentId: waybill,
        };
      }

      // ----- Known permanent validation/business errors (non-retryable) -----
      return {
        ok: false,
        retryable: false,
        code: "CARRIER_AMBIGUOUS",
        message: remarks || "Unknown carrier error",
      };
    }

    /** Decide if an HTTP failure status is retryable */
    function httpRetryable(status: number) {
      // transient: throttling / contention / timeouts / early hints
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

      const { shop, batchId, jobId, pickupName, shippingMode } = (req.body || {}) as {
        shop?: string;
        batchId?: string;
        jobId?: string;
        pickupName?: string;
        shippingMode?: string;
      };
      if (!shop || !batchId || !jobId || !pickupName || !shippingMode) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      const batchRef = db
        .collection("accounts")
        .doc(shop)
        .collection("shipment_batches")
        .doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(String(jobId));
      const orderRef = db.collection("accounts").doc(shop).collection("orders").doc(String(jobId));
      const accountRef = db.collection("accounts").doc(shop);

      // Idempotency: if already success, just ack
      const jSnap = await jobRef.get();
      if (jSnap.exists && jSnap.data()?.status === "success") {
        // Fix any inconsistent batch counters
        await db.runTransaction(async (tx) => {
          const b = await tx.get(batchRef);
          const d = b.data() || {};

          // If still marked as processing, decrement it
          if ((d.processing || 0) > 0) {
            tx.update(batchRef, {
              processing: FieldValue.increment(-1),
            });
          }
        });

        await maybeCompleteBatch(batchRef);

        res.json({ ok: true, dedup: true });
        return;
      }

      // --- Start bookkeeping (transaction) -----------------------------------
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(jobRef);
        const data = snap.data() || {};
        const prevAttempts = Number(data.attempts || 0);
        const jobStatus = data.status;

        // FIX: Don't decrement queued if this is a fallback attempt
        // Fallback jobs go: processing → attempting_fallback → fallback_queued → processing
        // They were never re-queued, so don't decrement queued again
        const isFallbackAttempt =
          jobStatus === "fallback_queued" || jobStatus === "attempting_fallback";
        const firstAttempt =
          (prevAttempts === 0 || jobStatus === "queued" || !jobStatus) && !isFallbackAttempt;

        // move to processing, increment attempts
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
      });

      // Allocate AWB
      awb = await allocateAwb(shop);

      // Load order
      const ordSnap = await orderRef.get();
      if (!ordSnap.exists) throw new Error("ORDER_NOT_FOUND");
      const order = ordSnap.data();

      // Build payload for Delhivery
      const payload = buildDelhiveryPayload({
        orderId: String(jobId),
        awb,
        order,
        pickupName,
        shippingMode,
      });

      // Carrier API key
      const accSnap = await accountRef.get();
      const apiKey = accSnap.data()?.integrations?.couriers?.delhivery?.apiKey as
        | string
        | undefined;
      if (!apiKey) throw new Error("CARRIER_KEY_MISSING");

      // Call Delhivery (IMPORTANT: format=json&data=<json>)
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
            await releaseAwb(shop, awb);
            awbReleased = true;
          } catch (e) {
            console.error("Failed to release AWB:", e);
          }
        }

        const failure = await handleJobFailure({
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
      const verdict = evalDelhiveryResp(carrier);

      if (!verdict.ok) {
        if (awb && !awbReleased) {
          try {
            await releaseAwb(shop, awb);
            awbReleased = true;
          } catch (e) {
            console.error("Failed to release AWB:", e);
          }
        }

        const failure = await handleJobFailure({
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
      awbReleased = true; // guard: DO NOT release a used AWB if anything throws after this

      await Promise.all([
        jobRef.update({
          status: "success",
          awb,
          carrierShipmentId: verdict.carrierShipmentId ?? null,
          errorCode: FieldValue.delete(),
          errorMessage: FieldValue.delete(),
          apiResp: carrier,
          completedAt: FieldValue.serverTimestamp(),
        }),
        batchRef.update({
          processing: FieldValue.increment(-1),
          success: FieldValue.increment(1),
        }),
        orderRef.set(
          {
            awb,
            courier: "Delhivery",
            customStatus: "Ready To Dispatch",
            shippingMode,
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Ready To Dispatch",
              createdAt: Timestamp.now(),
              remarks: `The order's shipment was successfully made on Delhivery (${shippingMode}) (AWB: ${awb})`,
            }),
          },
          { merge: true },
        ),
      ]);

      await maybeCompleteBatch(batchRef);

      res.json({ ok: true, awb, carrierShipmentId: verdict.carrierShipmentId ?? null });
      return;
    } catch (e: any) {
      // Generic failure (network/bug/etc.)
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.split(/\s/)[0]; // first token
      const isRetryable = !NON_RETRYABLE.has(code);

      try {
        const { shop, batchId, jobId } = (req.body || {}) as {
          shop?: string;
          batchId?: string;
          jobId?: string;
        };

        if (shop && batchId && jobId) {
          if (awb && !awbReleased) {
            try {
              await releaseAwb(shop, awb);
              awbReleased = true;
            } catch (e) {
              console.error("Failed to release AWB:", e);
            }
          }

          const batchRef = db
            .collection("accounts")
            .doc(shop)
            .collection("shipment_batches")
            .doc(batchId);
          const jobRef = batchRef.collection("jobs").doc(String(jobId));

          const failure = await handleJobFailure({
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

/** Cloud Tasks → processes exactly ONE shipment job (Shiprocket: create order → assign AWB) */
export const processShipmentTask2 = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    // NOTE: Shiprocket order creation does NOT allocate an AWB from your pool.
    // We keep `awb` only to mirror your generic catch/finalization shape.
    let awb: string | undefined;
    let awbReleased = false;

    // --- small helpers -------------------------------------------------------
    const parseJson = (t: string) => {
      try {
        return JSON.parse(t);
      } catch {
        return { raw: t };
      }
    };

    /** Decide if an HTTP failure status is retryable */
    function httpRetryable(status: number) {
      // 5xx and 429 are retryable; 4xx are usually permanent
      if (status === 429) return true;
      if (status >= 500) return true;
      return false;
    }

    /** Classify Shiprocket create-order response */
    function evalShiprocketResp(sr: any): {
      ok: boolean;
      retryable: boolean;
      code: string;
      message: string;
      orderId?: string | number | null;
      shipmentId?: string | number | null;
    } {
      const msgFields = [
        sr?.message,
        sr?.msg,
        sr?.error,
        sr?.error_message,
        sr?.errors ? JSON.stringify(sr?.errors) : "",
      ]
        .filter((x) => typeof x === "string" && x.length)
        .join(" | ");

      const rawMsg = msgFields || "";

      // Success shape seen in docs: { order_id, shipment_id, status: "NEW", status_code: 1, ... }
      const looksSuccess =
        "order_id" in (sr ?? {}) &&
        sr.order_id != null &&
        "shipment_id" in (sr ?? {}) &&
        sr.shipment_id != null &&
        sr?.status_code === 1;

      if (looksSuccess) {
        return {
          ok: true,
          retryable: false,
          code: "OK",
          message: "created",
          orderId: sr?.order_id ?? null,
          shipmentId: sr?.shipment_id ?? null,
        };
      }

      // ----- Known permanent validation/business errors (non-retryable) -----
      return {
        ok: false,
        retryable: false,
        code: "CARRIER_AMBIGUOUS",
        message: rawMsg || "carrier error",
      };
    }

    async function requestShiprocketPickup(
      srToken: string,
      shipmentId: string | number,
    ): Promise<{ success: boolean; error?: string; data?: any }> {
      try {
        const base = "https://apiv2.shiprocket.in";
        const pickupPath = "/v1/external/courier/generate/pickup";

        const pickupResp = await fetch(`${base}${pickupPath}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${srToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            shipment_id: shipmentId,
          }),
        });

        const pickupText = await pickupResp.text();
        const pickupJson = parseJson(pickupText);

        // Check for error response format: { message: "...", status_code: 400 }
        if (pickupJson?.status_code && pickupJson.status_code >= 400) {
          return {
            success: false,
            error: pickupJson.message || `Error ${pickupJson.status_code}`,
            data: pickupJson,
          };
        }

        // HTTP layer errors
        if (!pickupResp.ok) {
          return {
            success: false,
            error: pickupJson?.message || `HTTP ${pickupResp.status}: ${pickupText}`,
            data: pickupJson,
          };
        }

        // Success response has pickup_status: 1
        if (pickupJson?.pickup_status === 1) {
          return {
            success: true,
            data: pickupJson,
          };
        }

        // Ambiguous response - no clear error but no success either
        return {
          success: false,
          error: pickupJson?.message || "Unknown pickup error",
          data: pickupJson,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    // -------------------------------------------------------------------------

    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");
      if (req.method !== "POST") return void res.status(405).json({ error: "method_not_allowed" });

      const { shop, batchId, jobId, pickupName, shippingMode } = (req.body || {}) as {
        shop?: string;
        batchId?: string;
        jobId?: string;
        pickupName?: string;
        shippingMode?: string;
      };
      if (!shop || !batchId || !jobId || !pickupName || !shippingMode) {
        return void res.status(400).json({ error: "bad_payload" });
      }

      const batchRef = db
        .collection("accounts")
        .doc(shop)
        .collection("shipment_batches")
        .doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(String(jobId));
      const orderRef = db.collection("accounts").doc(shop).collection("orders").doc(String(jobId));
      const accountRef = db.collection("accounts").doc(shop);

      // Idempotency: if already success, just ack
      const jSnap = await jobRef.get();
      if (jSnap.exists && jSnap.data()?.status === "success") {
        // Ensure batch counters are consistent on retry
        await db.runTransaction(async (tx) => {
          const b = await tx.get(batchRef);
          const d = b.data() || {};

          // If still marked as processing, fix the counter
          if ((d.processing || 0) > 0) {
            tx.update(batchRef, {
              processing: FieldValue.increment(-1),
            });
          }
        });

        await maybeCompleteBatch(batchRef);

        return void res.json({ ok: true, dedup: true });
      }

      // --- Start bookkeeping (transaction) -----------------------------------
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(jobRef);
        const data = snap.data() || {};
        const prevAttempts = Number(data.attempts || 0);
        const jobStatus = data.status;

        // FIX: Don't decrement queued if this is a fallback attempt
        // Fallback jobs go: processing → attempting_fallback → fallback_queued → processing
        // They were never re-queued, so don't decrement queued again
        const isFallbackAttempt =
          jobStatus === "fallback_queued" || jobStatus === "attempting_fallback";
        const firstAttempt =
          (prevAttempts === 0 || jobStatus === "queued" || !jobStatus) && !isFallbackAttempt;

        // move to processing, increment attempts
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
      });
      // ----------------------------------------------------------------------

      // Load order
      const ordSnap = await orderRef.get();
      if (!ordSnap.exists) throw new Error("ORDER_NOT_FOUND");
      const order = ordSnap.data();

      // Carrier token/config
      const accSnap = await accountRef.get();
      const shiprocketCfg = accSnap.data()?.integrations?.couriers?.shiprocket || {};
      const srToken =
        shiprocketCfg?.accessToken ||
        shiprocketCfg?.token ||
        shiprocketCfg?.apiKey ||
        shiprocketCfg?.bearer;

      if (!srToken) throw new Error("CARRIER_KEY_MISSING");

      // ---- Create payload (minimal/defensive) ----
      const payload = buildShiprocketPayload({
        orderId: String(jobId),
        order,
        pickupName,
        shippingMode,
      });

      // --- Idempotency: reuse previously created Shiprocket IDs on retry ----
      const prior = jSnap.data() || {};
      let srOrderId: string | number | undefined = prior.shiprocketOrderId;
      let srShipmentId: string | number | undefined = prior.shiprocketShipmentId;

      // If we already created the SR order earlier, skip creation
      type SRVerdict = ReturnType<typeof evalShiprocketResp>;
      let verdict: SRVerdict;

      if (srShipmentId) {
        verdict = {
          ok: true,
          retryable: false,
          code: "OK",
          message: "created",
          orderId: srOrderId ?? null,
          shipmentId: srShipmentId,
        };
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

        // HTTP errors - NOW USING handleJobFailure
        if (!resp.ok) {
          const failure = await handleJobFailure({
            shop,
            batchRef,
            jobRef,
            jobId,
            errorCode: `HTTP_${resp.status}`,
            errorMessage: text,
            isRetryable: httpRetryable(resp.status),
          });

          if (failure.shouldReturnFailure) {
            return void res.status(failure.statusCode).json({
              ok: false,
              reason: failure.reason,
              code: `HTTP_${resp.status}`,
            });
          } else {
            return void res.status(failure.statusCode).json({
              ok: true,
              action: failure.reason,
            });
          }
        }

        const orderCreateJson = parseJson(text);
        const v = evalShiprocketResp(orderCreateJson);
        verdict = v;

        if (!v.ok) {
          const failure = await handleJobFailure({
            shop,
            batchRef,
            jobRef,
            jobId,
            errorCode: v.code,
            errorMessage: v.message,
            isRetryable: v.retryable,
            apiResp: orderCreateJson,
          });

          if (failure.shouldReturnFailure) {
            return void res.status(failure.statusCode).json({
              ok: false,
              reason: failure.reason,
              code: v.code,
            });
          } else {
            return void res.status(failure.statusCode).json({
              ok: true,
              action: failure.reason,
            });
          }
        }

        // Persist IDs immediately so retries can skip creation
        srOrderId = v.orderId ?? srOrderId;
        srShipmentId = v.shipmentId ?? srShipmentId;
        await jobRef.set(
          {
            shiprocketOrderId: srOrderId ?? null,
            shiprocketShipmentId: srShipmentId ?? null,
            stage: "order_created",
          },
          { merge: true },
        );

        // Wait for a second
        function sleep(ms: number): Promise<void> {
          return new Promise((resolve) => setTimeout(resolve, ms));
        }
        await sleep(1000);
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
          shipment_id: verdict.shipmentId, // required
          // courier_id: <number>, // optional if you want to force a courier
        }),
      });

      const awbText = await awbResp.text();

      // HTTP layer handling - NOW USING handleJobFailure
      if (!awbResp.ok) {
        const failure = await handleJobFailure({
          shop,
          batchRef,
          jobRef,
          jobId,
          errorCode: `HTTP_${awbResp.status}`,
          errorMessage: awbText,
          isRetryable: httpRetryable(awbResp.status),
        });

        if (failure.shouldReturnFailure) {
          return void res.status(failure.statusCode).json({
            ok: false,
            reason: failure.reason,
            code: `HTTP_${awbResp.status}`,
          });
        } else {
          return void res.status(failure.statusCode).json({
            ok: true,
            action: failure.reason,
          });
        }
      }

      // ---- Parse and extract according to Shiprocket structure ----
      const awbJson = parseJson(awbText) ?? {};
      // Most Shiprocket success payloads: { awb_assign_status, response: { data: { ... } } }
      const node = awbJson?.response?.data ?? awbJson?.data ?? awbJson?.response ?? awbJson; // fallbacks for odd variants
      // Build a readable error message from common fields (top-level & nested)
      const errorIfAny = (awbJson?.message || "").toLowerCase();

      // Correct fields per your example JSON
      const awbCode = node?.awb_code ?? null;
      const courierName = node?.courier_name ?? null;
      const courierId = node?.courier_company_id ?? null;

      // Success → we have an AWB
      if (awbCode) {
        // --- Request Shiprocket Pickup (best effort) ---
        let pickupResult: { success: boolean; error?: string; data?: any } = {
          success: false,
        };

        try {
          pickupResult = await requestShiprocketPickup(srToken, verdict.shipmentId!);

          if (!pickupResult.success) {
            console.warn(`Pickup request failed for job ${jobId}:`, pickupResult.error);
          }
        } catch (pickupError) {
          console.error(`Pickup request error for job ${jobId}:`, pickupError);
          pickupResult = {
            success: false,
            error: pickupError instanceof Error ? pickupError.message : String(pickupError),
          };
        }

        await Promise.all([
          jobRef.update({
            status: "success",
            awb: awbCode,
            carrierShipmentId: verdict.shipmentId ?? null,
            carrier: "Shiprocket",
            courierName: courierName ?? null,
            courierCompanyId: courierId ?? null,
            errorCode: FieldValue.delete(),
            errorMessage: FieldValue.delete(),
            completedAt: FieldValue.serverTimestamp(),
            apiResp: {
              orderCreate: srOrderId ? "persisted" : "fresh",
              awbAssign: awbJson,
            },
          }),
          batchRef.update({
            processing: FieldValue.increment(-1),
            success: FieldValue.increment(1),
          }),
          orderRef.set(
            {
              awb: awbCode,
              courier: `Shiprocket: ${courierName ?? "Unknown"}`,
              customStatus: "Ready To Dispatch",
              customStatusesLogs: FieldValue.arrayUnion({
                status: "Ready To Dispatch",
                createdAt: Timestamp.now(),
                remarks: `The order's shipment was successfully made on ${courierName} via Shiprocket (AWB: ${awbCode})`,
              }),

              // Persist Shiprocket IDs for future reference
              shiprocketOrderId: srOrderId ?? null,
              shiprocketShipmentId: verdict.shipmentId ?? null,
            },
            { merge: true },
          ),
        ]);

        await maybeCompleteBatch(batchRef);

        return void res.json({
          ok: true,
          awb: awbCode,
          carrierShipmentId: verdict.shipmentId ?? null,
          shiprocketOrderId: srOrderId ?? null,
        });
      }

      // Non-retryable AWB cases (based on typical Shiprocket messages)
      if (errorIfAny) {
        const failure = await handleJobFailure({
          shop,
          batchRef,
          jobRef,
          jobId,
          errorCode: "AWB_ASSIGN_FAILED",
          errorMessage: awbJson?.message || "Awb assign failed",
          isRetryable: false,
          apiResp: { awbAssign: awbJson },
        });

        if (failure.shouldReturnFailure) {
          return void res.status(failure.statusCode).json({
            ok: false,
            reason: failure.reason,
            code: "AWB_ASSIGN_FAILED",
          });
        } else {
          return void res.status(failure.statusCode).json({
            ok: true,
            action: failure.reason,
          });
        }
      }

      // Ambiguous → retry with handleJobFailure
      const failure = await handleJobFailure({
        shop,
        batchRef,
        jobRef,
        jobId,
        errorCode: "CARRIER_AMBIGUOUS",
        errorMessage: "carrier error",
        isRetryable: true,
        apiResp: { awbAssign: awbJson },
      });

      if (failure.shouldReturnFailure) {
        return void res.status(failure.statusCode).json({
          ok: false,
          reason: failure.reason,
          code: "CARRIER_AMBIGUOUS",
        });
      } else {
        return void res.status(failure.statusCode).json({
          ok: true,
          action: failure.reason,
        });
      }
    } catch (e: any) {
      // Generic failure (network/bug/etc.)
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.split(/\s/)[0]; // first token
      const isRetryable = !NON_RETRYABLE.has(code);

      try {
        const { shop, batchId, jobId } = (req.body || {}) as {
          shop?: string;
          batchId?: string;
          jobId?: string;
        };

        if (shop && batchId && jobId) {
          if (awb && !awbReleased) {
            try {
              await releaseAwb(shop, awb);
              awbReleased = true;
            } catch (e) {
              console.error("Failed to release AWB:", e);
            }
          }

          const batchRef = db
            .collection("accounts")
            .doc(shop)
            .collection("shipment_batches")
            .doc(batchId);
          const jobRef = batchRef.collection("jobs").doc(String(jobId));

          const failure = await handleJobFailure({
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

/** Vercel → starts a fulfillment batch and enqueues one task per orderId */
export const enqueueOrdersFulfillmentTasks = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [ENQUEUE_FUNCTION_SECRET, TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { shop, orderIds, requestedBy } = (req.body || {}) as {
        shop?: string;
        orderIds?: Array<string | number>;
        requestedBy?: string;
      };

      if (!shop || !Array.isArray(orderIds) || orderIds.length === 0) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      // Validate account + token
      const accountRef = db.collection("accounts").doc(shop);
      const accountSnap = await accountRef.get();
      if (!accountSnap.exists) {
        res.status(404).json({ error: "shop_not_found" });
        return;
      }
      const accessToken = accountSnap.get("accessToken");
      if (!accessToken) {
        res.status(500).json({ error: "missing_access_token" });
        return;
      }

      // Create summary doc
      const summaryRef = accountRef.collection("orders_fulfillment_summary").doc();
      const summaryId = summaryRef.id;
      const now = FieldValue.serverTimestamp();
      const total = orderIds.length;

      await summaryRef.set({
        shop,
        createdBy: requestedBy ?? null,
        createdAt: now,
        status: "running", // queued | running | complete
        total,
        processing: 0,
        success: 0,
        failed: 0,
      });

      // Seed job docs
      const batch = db.batch();
      const jobsCol = summaryRef.collection("jobs");
      for (const oid of orderIds) {
        const jobRef = jobsCol.doc(String(oid)); // deterministic per order
        batch.set(jobRef, {
          orderId: String(oid),
          status: "queued", // queued | processing | retrying | success | failed
          attempts: 0,
          updatedAt: now,
        });
      }
      await batch.commit();

      // Enqueue Cloud Tasks
      const workerUrl = process.env.FULFILLMENT_TASK_TARGET_URL || "";
      if (!workerUrl) {
        res.status(500).json({ error: "worker_url_not_configured" });
        return;
      }

      await Promise.all(
        orderIds.map((oid) =>
          createTask(
            {
              shop,
              summaryId,
              jobId: String(oid),
              orderId: String(oid),
            } as any, // widen payload; your createTask is generic
            {
              tasksSecret: TASKS_SECRET.value() || "",
              url: workerUrl,
              queue: process.env.FULFILLMENT_QUEUE_NAME || "fulfillments-queue",
              delaySeconds: 1,
            },
          ),
        ),
      );

      await summaryRef.update({ status: "running" });
      res.status(202).json({ collectionName: "orders_fulfillment_summary", summaryId });
      return;
    } catch (e: any) {
      console.error("startOrdersFulfillmentBatch error:", e);
      res.status(500).json({ error: "start_batch_failed", details: String(e?.message ?? e) });
      return;
    }
  },
);

// Fulfill ONE Shopify order (handles on_hold/scheduled → open)
async function fulfillOrderOnShopify(
  shop: string,
  accessToken: string,
  orderId: string | number,
  awb: string | number,
  courier: string,
): Promise<{ fulfillmentId?: string; nothingToDo?: boolean }> {
  const V = "2025-07";
  const headers = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };

  // 1) Get Fulfillment Orders (requires merchant-managed FO scopes if it's your own location)
  const foUrl = `https://${shop}/admin/api/${V}/orders/${orderId}/fulfillment_orders.json`;
  const foResp = await fetch(foUrl, { headers });
  if (!foResp.ok) {
    const text = await foResp.text();
    const err: any = new Error(`FO fetch failed: HTTP_${foResp.status}`);
    err.code = `HTTP_${foResp.status}`;
    err.detail = text;
    throw err;
  }
  let { fulfillment_orders: fos } = (await foResp.json()) as any;

  // If no FOs are visible, it’s almost always a scope issue
  if (!Array.isArray(fos) || fos.length === 0) {
    return { nothingToDo: true }; // caller can treat this as "check app scopes"
  }

  // Helpers
  const releaseHold = (id: number | string) =>
    fetch(`https://${shop}/admin/api/${V}/fulfillment_orders/${id}/release_hold.json`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });

  const openFO = (id: number | string) =>
    fetch(`https://${shop}/admin/api/${V}/fulfillment_orders/${id}/open.json`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });

  // 2) Try to convert on_hold/scheduled to open
  let touched = false;
  for (const fo of fos) {
    if (fo.status === "on_hold") {
      await releaseHold(fo.id);
      touched = true;
    } else if (fo.status === "scheduled") {
      await openFO(fo.id);
      touched = true;
    }
  }
  if (touched) {
    const refetch = await fetch(foUrl, { headers });
    if (!refetch.ok) {
      const text = await refetch.text();
      const err: any = new Error(`FO refetch failed: HTTP_${refetch.status}`);
      err.code = `HTTP_${refetch.status}`;
      err.detail = text;
      throw err;
    }
    fos = ((await refetch.json()) as any).fulfillment_orders;
  }

  // 3) Only work on fulfillable FOs
  const fulfillableFOs = (fos || []).filter(
    (fo: any) => fo.status === "open" || fo.status === "in_progress",
  );
  if (!fulfillableFOs.length) return { nothingToDo: true };

  // 4) Create the fulfillment:
  //    Pass only the FO IDs → fulfill all remaining quantities automatically.
  const lineItemsByFO = fulfillableFOs.map((fo: any) => ({
    fulfillment_order_id: fo.id,
    // Omit fulfillment_order_line_items to fulfill all remaining; safer than sending li.quantity.
  }));

  const fulfillUrl = `https://${shop}/admin/api/${V}/fulfillments.json`;
  const resp = await fetch(fulfillUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fulfillment: {
        line_items_by_fulfillment_order: lineItemsByFO,
        tracking_info: {
          number: String(awb) || "",
          // Optionally set company/url so the link is clickable in Admin:
          company: courier,
          url: String(courier).toLowerCase().includes("shiprocket")
            ? `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`
            : `https://track.delhivery.com/api/v1/packages/json/?waybill=${awb}&ref_ids=`,
        },
        notify_customer: false,
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    const err: any = new Error(`Fulfillment create failed: HTTP_${resp.status}`);
    err.code = `HTTP_${resp.status}`;
    err.detail = text;
    throw err;
  }

  const json: any = await resp.json();
  return { fulfillmentId: json?.fulfillment?.id };
}

/** Cloud Tasks → fulfills exactly ONE order and updates the summary */
export const processFulfillmentTask = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    function httpRetryable(status: number): boolean {
      return status === 408 || status === 429 || (status >= 500 && status <= 599);
    }
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");
      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { shop, summaryId, jobId, orderId } = (req.body || {}) as {
        shop?: string;
        summaryId?: string;
        jobId?: string;
        orderId?: string;
      };
      if (!shop || !summaryId || !jobId || !orderId) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      const summaryRef = db
        .collection("accounts")
        .doc(shop)
        .collection("orders_fulfillment_summary")
        .doc(summaryId);
      const jobRef = summaryRef.collection("jobs").doc(jobId);
      const orderRef = db.collection("accounts").doc(shop).collection("orders").doc(String(jobId));
      const order = await orderRef.get();
      let awb = "";
      let courier = "";
      if (order.exists) {
        awb = order.get("awb");
        courier = order.get("courier");
      }

      const [accountSnap, jobSnap] = await Promise.all([
        db.collection("accounts").doc(shop).get(),
        jobRef.get(),
      ]);

      if (!accountSnap.exists) {
        res.status(404).json({ error: "shop_not_found" });
        return;
      }
      const accessToken = accountSnap.get("accessToken");
      if (!accessToken) {
        res.status(500).json({ error: "missing_access_token" });
        return;
      }

      if (!jobSnap.exists) {
        // Deleted or missing job: ack and move on (idempotency)
        res.json({ noop: true });
        return;
      }

      const job = jobSnap.data()!;
      if (job.status === "success") {
        res.json({ alreadyDone: true });
        return;
      }

      const MAX_ATTEMPTS = Number(process.env.FULFILLMENT_QUEUE_MAX_ATTEMPTS || 3);

      // mark processing + attempt++
      await Promise.all([
        jobRef.set(
          {
            status: "processing",
            attempts: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        ),
        summaryRef.update({ processing: FieldValue.increment(1) }),
      ]);

      try {
        const result = await fulfillOrderOnShopify(shop, accessToken, orderId, awb, courier);

        await Promise.all([
          jobRef.set(
            {
              status: "success",
              fulfillmentId: result.fulfillmentId ?? null,
              nothingToDo: !!result.nothingToDo,
              errorCode: FieldValue.delete(),
              errorMessage: FieldValue.delete(),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          ),
          summaryRef.update({
            processing: FieldValue.increment(-1),
            success: FieldValue.increment(1),
          }),
          orderRef.set(
            {
              customStatus: "Dispatched",
              customStatusesLogs: FieldValue.arrayUnion({
                status: "Dispatched",
                createdAt: Timestamp.now(),
                remarks: `The order's shipment was dipatched from the warehouse.`,
              }),
            },
            { merge: true },
          ),
        ]);

        await maybeCompleteSummary(summaryRef);
        res.json({ ok: true });
        return;
      } catch (err: any) {
        const attempts = (job.attempts ?? 0) + 1;
        const codeStr: string = err?.code || "UNKNOWN";
        const httpCode = /^HTTP_(\d+)$/.exec(codeStr)?.[1];
        const retryable = httpCode ? httpRetryable(Number(httpCode)) : true;

        if (retryable) {
          const areAttempsExhausted = attempts >= Number(MAX_ATTEMPTS);
          await Promise.all([
            jobRef.set(
              {
                status: areAttempsExhausted ? "failed" : "retrying",
                errorCode: codeStr,
                errorMessage: (err?.detail || err?.message || "").slice(0, 400),
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true },
            ),
            summaryRef.update(
              areAttempsExhausted
                ? { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) }
                : { processing: FieldValue.increment(-1) },
            ),
          ]);

          await maybeCompleteSummary(summaryRef);
          // 503 tells Cloud Tasks to retry per queue policy
          res.status(503).json({ retry: true, reason: codeStr });
          return;
        } else {
          await Promise.all([
            jobRef.set(
              {
                status: "failed",
                errorCode: codeStr,
                errorMessage: (err?.detail || err?.message || "").slice(0, 400),
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true },
            ),
            summaryRef.update({
              processing: FieldValue.increment(-1),
              failed: FieldValue.increment(1),
            }),
          ]);
          await maybeCompleteSummary(summaryRef);
          res.json({ failed: true, reason: codeStr });
          return;
        }
      }
    } catch (e: any) {
      console.error("processFulfillmentTask error:", e);
      res.status(500).json({ error: "worker_failed", details: String(e?.message ?? e) });
      return;
    }
  },
);

async function maybeCompleteSummary(summaryRef: DocumentReference) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(summaryRef);
    if (!snap.exists) return;
    const d = snap.data() as any;
    const total = d.total ?? 0;
    const done = (d.success ?? 0) + (d.failed ?? 0);
    const processing = d.processing ?? 0;

    if (done >= total && processing === 0 && d.status !== "complete") {
      tx.update(summaryRef, { status: "complete", completedAt: FieldValue.serverTimestamp() });
    }
  });
}

// ============================================================================
// SHARED UTILITIES - Used by both scheduled and manual updates
// ============================================================================
function determineNewStatus(status: any): string | null {
  const { Status, StatusType } = status;

  const statusMap: Record<string, Record<string, string>> = {
    "In Transit": { UD: "In Transit", RT: "RTO In Transit", PU: "DTO In Transit" },
    Pending: { UD: "In Transit", RT: "RTO In Transit", PU: "DTO In Transit" },
    Dispatched: { UD: "Out For Delivery" },
    Delivered: { DL: "Delivered" },
    RTO: { DL: "RTO Delivered" },
    DTO: { DL: "DTO Delivered" },
    Lost: { LT: "Lost" },
  };

  return statusMap[Status]?.[StatusType] || null;
}

function getStatusRemarks(status: string): string {
  const remarks: Record<string, string> = {
    "In Transit": "This order was being moved from origin to the destination",
    "RTO In Transit": "This order was returned and being moved from pickup to origin",
    "Out For Delivery": "This order was about to reach its final destination",
    Delivered: "This order was successfully delivered to its destination",
    "RTO Delivered": "This order was successfully returned to its destination",
    "DTO In Transit": "This order was returned by the customer and was being moved to the origin",
    "DTO Delivered":
      "This order was returned by the customer and successfully returned to its origin",
    Lost: "This order was lost",
  };
  return remarks[status] || "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// CONFIGURATION
// ============================================================================
const CHUNK_SIZE = 200; // Orders processed per scheduled task
const MANUAL_CHUNK_SIZE = 100; // Order IDs processed per manual task
const API_BATCH_SIZE = 50; // Orders per Delhivery API call

// ============================================================================
// SCHEDULED STATUS UPDATES
// ============================================================================

// 1. SCHEDULER - Enqueues initial tasks (one per account)
export const enqueueStatusUpdateTasksScheduled = onSchedule(
  {
    schedule: "0 0,4,8,12,16,20 * * *", // 6 times daily
    timeZone: "Asia/Kolkata",
    region: process.env.LOCATION || "asia-south1",
    memory: "512MiB",
    timeoutSeconds: 540,
    secrets: [TASKS_SECRET],
  },
  async (event) => {
    console.log(`Starting scheduled status update batch processing...${event ? "" : ""}`);

    try {
      const usersSnapshot = await db.collection("users").where("activeAccountId", "!=", null).get();

      if (usersSnapshot.empty) {
        console.log("No users with active accounts found");
        return;
      }

      // Group users by account and filter for Delhivery integration
      const accountToUsers = new Map<string, string[]>();
      let totalUsersCount = 0;

      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const activeAccountId = userDoc.get("activeAccountId");
        if (!activeAccountId) continue;

        try {
          const accountDoc = await db.collection("accounts").doc(activeAccountId).get();
          if (!accountDoc.exists) continue;

          const apiKey = accountDoc.data()?.integrations?.couriers?.delhivery?.apiKey;
          if (apiKey) {
            if (!accountToUsers.has(activeAccountId)) {
              accountToUsers.set(activeAccountId, []);
            }
            accountToUsers.get(activeAccountId)!.push(userId);
            totalUsersCount++;
          }
        } catch (error) {
          console.error(`Error checking account ${activeAccountId}:`, error);
        }
      }

      if (accountToUsers.size === 0) {
        console.log("No accounts with Delhivery integration found");
        return;
      }

      console.log(
        `Found ${accountToUsers.size} accounts with Delhivery (${totalUsersCount} users)`,
      );

      // Create batch header
      const batchRef = db.collection("status_update_batches").doc();
      const batchId = batchRef.id;

      await batchRef.set({
        createdAt: FieldValue.serverTimestamp(),
        createdBy: "system-scheduled",
        total: accountToUsers.size,
        totalUsers: totalUsersCount,
        queued: accountToUsers.size,
        status: "running",
        processing: 0,
        success: 0,
        failed: 0,
        type: "status_update",
        schedule: "6x_daily",
      });

      // Create job documents (one per account)
      const writer = db.bulkWriter();
      for (const [accountId, userIds] of accountToUsers) {
        writer.set(
          batchRef.collection("jobs").doc(accountId),
          {
            accountId,
            userIds,
            userCount: userIds.length,
            status: "queued",
            attempts: 0,
            createdAt: FieldValue.serverTimestamp(),
            processedOrders: 0,
            updatedOrders: 0,
            totalChunks: 0,
          },
          { merge: true },
        );
      }
      await writer.close();

      const targetUrl = process.env.UPDATE_STATUS_TASK_JOB_TARGET_URL;
      if (!targetUrl) {
        throw new Error("UPDATE_STATUS_TASK_TARGET_URL not configured");
      }

      // Create initial tasks (chunk 0 for each account)
      const taskPromises = Array.from(accountToUsers.entries()).map(([accountId, userIds], index) =>
        createTask(
          {
            accountId,
            userIds,
            batchId,
            jobId: accountId,
            chunkIndex: 0,
            cursor: null,
          } as any,
          {
            tasksSecret: TASKS_SECRET.value() || "",
            url: targetUrl,
            queue: process.env.STATUS_UPDATE_QUEUE_NAME || "statuses-update-queue",
            delaySeconds: Math.floor(index * 2),
          },
        ),
      );

      await Promise.all(taskPromises);

      console.log(`Enqueued ${accountToUsers.size} initial tasks for batch ${batchId}`);
    } catch (error) {
      console.error("enqueueStatusUpdateTasks failed:", error);
      throw error;
    }
  },
);

// 2. MAIN TASK HANDLER - Processes one chunk and queues next if needed
export const updateDelhiveryStatusesJob = onRequest(
  { cors: true, timeoutSeconds: 540, secrets: [TASKS_SECRET], memory: "512MiB" },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const {
        accountId,
        userIds,
        batchId,
        jobId,
        cursor = null,
        chunkIndex = 0,
      } = req.body as {
        accountId?: string;
        userIds?: string[];
        batchId?: string;
        jobId?: string;
        cursor?: string | null;
        chunkIndex?: number;
      };

      if (!accountId || !userIds?.length || !batchId || !jobId) {
        res.status(400).json({ error: "missing_required_params" });
        return;
      }

      const batchRef = db.collection("status_update_batches").doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(jobId);

      // Idempotency check
      const jSnap = await jobRef.get();
      if (jSnap.exists && jSnap.data()?.status === "success") {
        res.json({ ok: true, dedup: true });
        return;
      }

      // Initialize job on first chunk
      if (chunkIndex === 0) {
        const validUserIds = await validateUsers(accountId, userIds);
        if (validUserIds.length === 0) {
          throw new Error("NO_VALID_USERS_FOR_ACCOUNT");
        }

        await db.runTransaction(async (tx) => {
          const snap = await tx.get(jobRef);
          const data = snap.data() || {};
          const prevAttempts = Number(data.attempts || 0);
          const firstAttempt = prevAttempts === 0 || data.status === "queued";

          tx.set(
            jobRef,
            {
              status: "processing",
              attempts: (prevAttempts || 0) + 1,
              lastAttemptAt: FieldValue.serverTimestamp(),
              accountId,
              userIds: validUserIds,
              userCount: validUserIds.length,
              processedOrders: 0,
              updatedOrders: 0,
              totalChunks: 0,
            },
            { merge: true },
          );

          const inc: any = { processing: FieldValue.increment(1) };
          if (firstAttempt) inc.queued = FieldValue.increment(-1);
          tx.update(batchRef, inc);
        });
      }

      // Verify account and get API key
      const accountDoc = await db.collection("accounts").doc(accountId).get();
      if (!accountDoc.exists) throw new Error("ACCOUNT_NOT_FOUND");

      const apiKey = accountDoc.data()?.integrations?.couriers?.delhivery?.apiKey;
      if (!apiKey) throw new Error("API_KEY_MISSING");

      // Process one chunk of orders
      const result = await processOrderChunk(accountId, apiKey, cursor);

      // Update job progress
      await jobRef.update({
        processedOrders: FieldValue.increment(result.processed),
        updatedOrders: FieldValue.increment(result.updated),
        totalChunks: FieldValue.increment(1),
        lastChunkAt: FieldValue.serverTimestamp(),
        lastCursor: result.nextCursor || FieldValue.delete(),
      });

      // If more work remains, queue next chunk
      if (result.hasMore && result.nextCursor) {
        await queueNextChunk(TASKS_SECRET.value() || "", {
          accountId,
          userIds,
          batchId,
          jobId,
          cursor: result.nextCursor,
          chunkIndex: chunkIndex + 1,
        });

        res.json({
          ok: true,
          status: "chunk_completed",
          chunkIndex,
          processed: result.processed,
          updated: result.updated,
          hasMore: true,
        });
        return;
      }

      // Job complete
      const jobData = (await jobRef.get()).data() || {};
      await Promise.all([
        jobRef.update({
          status: "success",
          message: "status_update_completed",
          completedAt: FieldValue.serverTimestamp(),
        }),
        batchRef.update({
          processing: FieldValue.increment(-1),
          success: FieldValue.increment(1),
        }),
      ]);

      await maybeCompleteBatch(batchRef);

      res.json({
        ok: true,
        status: "job_completed",
        totalProcessed: jobData.processedOrders || 0,
        totalUpdated: jobData.updatedOrders || 0,
        totalChunks: jobData.totalChunks || 0,
      });
    } catch (error: any) {
      await handleJobError(error, req.body);
      const msg = error.message || String(error);
      const code = msg.split(/\s/)[0];
      const NON_RETRYABLE = ["ACCOUNT_NOT_FOUND", "API_KEY_MISSING", "NO_VALID_USERS_FOR_ACCOUNT"];
      const isRetryable = !NON_RETRYABLE.includes(code);

      res.status(isRetryable ? 503 : 200).json({
        ok: false,
        error: isRetryable ? "job_failed_transient" : "job_failed_permanent",
        code,
        message: msg,
      });
    }
  },
);

// 3. CHUNK PROCESSOR - Fetches and processes one page of orders
interface ChunkResult {
  processed: number;
  updated: number;
  hasMore: boolean;
  nextCursor?: string;
}

async function processOrderChunk(
  accountId: string,
  apiKey: string,
  cursor: string | null,
): Promise<ChunkResult> {
  const excludedStatuses = new Set([
    "New",
    "Confirmed",
    "Ready To Dispatch",
    "DTO Requested",
    "Lost",
    "Closed",
    "RTO Closed",
    "RTO Delivered",
    "DTO Delivered",
  ]);

  // Build paginated query
  let query = db
    .collection("accounts")
    .doc(accountId)
    .collection("orders")
    .where("courier", "==", "Delhivery")
    .orderBy("__name__")
    .limit(CHUNK_SIZE);

  if (cursor) {
    query = query.startAfter(cursor);
  }

  const snapshot = await query.get();

  if (snapshot.empty) {
    return { processed: 0, updated: 0, hasMore: false };
  }

  const eligibleOrders = snapshot.docs
    .map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }))
    .filter(
      (order: any) => order.awb && order.customStatus && !excludedStatuses.has(order.customStatus),
    );

  if (eligibleOrders.length === 0) {
    const lastDoc = snapshot.docs[snapshot.docs.length - 1];
    return {
      processed: snapshot.size,
      updated: 0,
      hasMore: snapshot.size === CHUNK_SIZE,
      nextCursor: lastDoc.id,
    };
  }

  console.log(`Processing ${eligibleOrders.length} eligible orders for account ${accountId}`);

  // Process in API batches
  let totalUpdated = 0;

  for (let i = 0; i < eligibleOrders.length; i += API_BATCH_SIZE) {
    const batch = eligibleOrders.slice(i, Math.min(i + API_BATCH_SIZE, eligibleOrders.length));
    const updates = await fetchAndProcessBatch(batch, apiKey);

    // Apply updates using Firestore batch writes
    if (updates.length > 0) {
      const writeBatch = db.batch();
      updates.forEach((update) => {
        writeBatch.update(update.ref, update.data);
      });
      await writeBatch.commit();
      totalUpdated += updates.length;
      console.log(`Updated ${updates.length} orders in API batch ${i / API_BATCH_SIZE + 1}`);
    }

    // Rate limiting between API calls
    if (i + API_BATCH_SIZE < eligibleOrders.length) {
      await sleep(150);
    }
  }

  const lastDoc = snapshot.docs[snapshot.docs.length - 1];
  const hasMore = snapshot.size === CHUNK_SIZE;

  return {
    processed: eligibleOrders.length,
    updated: totalUpdated,
    hasMore,
    nextCursor: hasMore ? lastDoc.id : undefined,
  };
}

// 4. API PROCESSOR - Calls Delhivery and prepares updates
interface OrderUpdate {
  ref: DocumentReference;
  data: any;
}

async function fetchAndProcessBatch(orders: any[], apiKey: string): Promise<OrderUpdate[]> {
  const waybills = orders
    .map((order) => (order.customStatus?.includes("DTO") ? order.awb_reverse : order.awb))
    .filter(Boolean)
    .join(",");

  if (!waybills) return [];

  try {
    const trackingUrl = `https://track.delhivery.com/api/v1/packages/json/?waybill=${waybills}`;
    const response = await fetch(trackingUrl, {
      headers: {
        Authorization: `Token ${apiKey}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) {
        throw new Error(`HTTP_${response.status}`);
      }
      console.error(`Delhivery API error: ${response.status}`);
      return [];
    }

    const trackingData = (await response.json()) as any;
    const shipments = trackingData.ShipmentData || [];

    return prepareOrderUpdates(orders, shipments);
  } catch (error: any) {
    console.error("Batch processing error:", error);
    if (error.message.startsWith("HTTP_")) {
      throw error;
    }
    return [];
  }
}

// 5. UPDATE PREPARATION - Maps API responses to Firestore updates
function prepareOrderUpdates(orders: any[], shipments: any[]): OrderUpdate[] {
  const updates: OrderUpdate[] = [];
  const ordersByName = new Map(orders.map((o) => [o.name, o]));

  for (const shipmentWrapper of shipments) {
    const shipment = shipmentWrapper.Shipment;
    if (!shipment?.ReferenceNo || !shipment.Status) continue;

    const order = ordersByName.get(shipment.ReferenceNo);
    if (!order) continue;

    const newStatus = determineNewStatus(shipment.Status);
    if (!newStatus || newStatus === order.customStatus) continue;

    updates.push({
      ref: order.ref,
      data: {
        customStatus: newStatus,
        lastStatusUpdate: FieldValue.serverTimestamp(),
        customStatusesLogs: FieldValue.arrayUnion({
          status: newStatus,
          createdAt: Timestamp.now(),
          remarks: getStatusRemarks(newStatus),
        }),
      },
    });
  }

  return updates;
}

// 6. HELPER FUNCTIONS
async function validateUsers(accountId: string, userIds: string[]): Promise<string[]> {
  const results = await Promise.all(
    userIds.map(async (userId) => {
      try {
        const userDoc = await db.collection("users").doc(userId).get();
        if (!userDoc.exists) return null;
        if (userDoc.get("activeAccountId") !== accountId) return null;
        return userId;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((id): id is string => id !== null);
}

async function queueNextChunk(
  tasksSecret: string,
  params: {
    accountId: string;
    userIds: string[];
    batchId: string;
    jobId: string;
    cursor: string;
    chunkIndex: number;
  },
): Promise<void> {
  const targetUrl = process.env.UPDATE_STATUS_TASK_JOB_TARGET_URL;

  await createTask(params, {
    tasksSecret,
    url: targetUrl,
    queue: process.env.STATUS_UPDATE_QUEUE_NAME || "statuses-update-queue",
    delaySeconds: 2,
  });
}

async function handleJobError(error: any, body: any): Promise<void> {
  const { batchId, jobId, chunkIndex } = body;
  if (!batchId || !jobId) return;

  const msg = error.message || String(error);
  const code = msg.split(/\s/)[0];
  const NON_RETRYABLE = ["ACCOUNT_NOT_FOUND", "API_KEY_MISSING", "NO_VALID_USERS_FOR_ACCOUNT"];
  const isRetryable = !NON_RETRYABLE.includes(code);

  const batchRef = db.collection("status_update_batches").doc(batchId);
  const jobRef = batchRef.collection("jobs").doc(jobId);

  try {
    const jobSnap = await jobRef.get();
    const attempts = Number(jobSnap.data()?.attempts || 0);
    const maxAttempts = Number(process.env.STATUS_UPDATE_QUEUE_MAX_ATTEMPTS || 4);
    const attemptsExhausted = attempts >= maxAttempts;

    await Promise.all([
      jobRef.set(
        {
          status: isRetryable ? (attemptsExhausted ? "failed" : "retrying") : "failed",
          errorCode: isRetryable ? "EXCEPTION" : code,
          errorMessage: msg.slice(0, 400),
          failedAt: FieldValue.serverTimestamp(),
          failedAtChunk: chunkIndex || 0,
        },
        { merge: true },
      ),
      batchRef.update(
        isRetryable && !attemptsExhausted
          ? { processing: FieldValue.increment(-1) }
          : { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) },
      ),
    ]);

    await maybeCompleteBatch(batchRef);
  } catch (e) {
    console.error("Failed to update job with error status:", e);
  }
}

// ============================================================================
// CRON JOB - Closes delivered orders after 144 hours
// ============================================================================
export const closeDeliveredOrdersJob = onSchedule(
  {
    schedule: "0 3 * * *",
    timeZone: "Asia/Kolkata",
    memory: "512MiB",
    timeoutSeconds: 540,
  },
  async () => {
    console.log("Starting closeDeliveredOrdersJob");

    const hours144InMs = 144 * 60 * 60 * 1000;
    const cutoffTime = new Date(Date.now() - hours144InMs);

    console.log(`Cutoff time: ${cutoffTime.toISOString()}`);

    const accountsSnapshot = await db.collection("accounts").get();
    console.log(`Found ${accountsSnapshot.size} accounts to check`);

    let totalClosed = 0;
    let accountsProcessed = 0;
    let accountsFailed = 0;

    for (const accountDoc of accountsSnapshot.docs) {
      try {
        const ordersToClose = await accountDoc.ref
          .collection("orders")
          .where("customStatus", "==", "Delivered")
          .where("lastStatusUpdate", "<=", cutoffTime)
          .limit(500)
          .get();

        console.log(`Account ${accountDoc.id}: found ${ordersToClose.size} orders to close`);

        if (ordersToClose.empty) {
          accountsProcessed++;
          continue;
        }

        const batch = db.batch();
        ordersToClose.docs.forEach((doc) => {
          batch.update(doc.ref, {
            customStatus: "Closed",
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Closed",
              createdAt: Timestamp.now(),
              remarks: "This order Closed after approximately 144 hrs of being Delivered.",
            }),
          });
        });

        await batch.commit();
        totalClosed += ordersToClose.size;
        accountsProcessed++;
        console.log(
          `Successfully closed ${ordersToClose.size} orders for account ${accountDoc.id}`,
        );
      } catch (error) {
        accountsFailed++;
        console.error(`Failed to close orders for account ${accountDoc.id}:`, error);
      }
    }

    console.log(
      `Job complete - Accounts: ${accountsProcessed} processed, ${accountsFailed} failed. Orders closed: ${totalClosed}`,
    );
  },
);

// ============================================================================
// MANUAL STATUS UPDATES
// ============================================================================

// 1. ENTRY POINT - Creates job and queues first chunk
export const updateDelhiveryStatusesManual = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [ENQUEUE_FUNCTION_SECRET, TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { shop, orderIds, requestedBy } = req.body as {
        shop?: string;
        orderIds?: string[];
        requestedBy?: string;
      };

      if (!shop) {
        res.status(400).json({ error: "missing_shop_id" });
        return;
      }

      if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
        res.status(400).json({ error: "missing_or_empty_order_ids" });
        return;
      }

      // Verify account exists and has API key
      const accountDoc = await db.collection("accounts").doc(shop).get();
      if (!accountDoc.exists) {
        res.status(404).json({ error: "account_not_found" });
        return;
      }

      const apiKey = accountDoc.data()?.integrations?.couriers?.delhivery?.apiKey;
      if (!apiKey) {
        res.status(400).json({ error: "delhivery_api_key_missing" });
        return;
      }

      // Create manual update job document
      const jobRef = db.collection("accounts").doc(shop).collection("manual_status_updates").doc();
      const jobId = jobRef.id;

      await jobRef.set({
        accountId: shop,
        orderIds,
        totalOrders: orderIds.length,
        requestedBy: requestedBy || "manual",
        status: "queued",
        createdAt: FieldValue.serverTimestamp(),
        processedOrders: 0,
        updatedOrders: 0,
        skippedOrders: 0,
        totalChunks: 0,
      });

      // Queue first chunk task
      await queueManualUpdateChunk(TASKS_SECRET.value() || "", {
        jobId,
        accountId: shop,
        orderIds,
        requestedBy: requestedBy || "manual",
        chunkIndex: 0,
        startIndex: 0,
      });

      // Return immediately with job tracking info
      res.json({
        success: true,
        message: "status_update_job_created",
        jobId,
        accountId: shop,
        totalOrders: orderIds.length,
        estimatedChunks: Math.ceil(orderIds.length / MANUAL_CHUNK_SIZE),
        status: "processing",
        checkStatusUrl: `/api/manual-update-status?jobId=${jobId}`,
      });
    } catch (error: any) {
      console.error("updateDelhiveryStatusesManual error:", error);
      res.status(500).json({
        error: error?.message ?? error ?? "status_update_failed",
        details: String(error?.message ?? error),
      });
    }
  },
);

// 2. CHUNK PROCESSOR - Processes one batch of order IDs
export const processManualUpdateChunk = onRequest(
  { cors: true, timeoutSeconds: 540, secrets: [TASKS_SECRET], memory: "512MiB" },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { jobId, accountId, orderIds, requestedBy, chunkIndex, startIndex } = req.body as {
        jobId?: string;
        accountId?: string;
        orderIds?: string[];
        requestedBy?: string;
        chunkIndex?: number;
        startIndex?: number;
      };

      if (!jobId || !accountId || !orderIds || startIndex === undefined) {
        res.status(400).json({ error: "missing_required_params" });
        return;
      }

      const jobRef = db
        .collection("accounts")
        .doc(accountId)
        .collection("manual_status_updates")
        .doc(jobId);

      // Idempotency check
      const jSnap = await jobRef.get();
      if (jSnap.exists && jSnap.data()?.status === "completed") {
        res.json({ ok: true, dedup: true });
        return;
      }

      // Increment attempts on every execution (using transaction for safety)
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(jobRef);
        const data = snap.data() || {};
        const prevAttempts = Number(data.attempts || 0);

        const updateData: any = {
          attempts: prevAttempts + 1,
          lastAttemptAt: FieldValue.serverTimestamp(),
        };

        // Only set these on first chunk of first attempt
        if (chunkIndex === 0 && (prevAttempts === 0 || data.status === "queued")) {
          updateData.status = "processing";
          updateData.startedAt = FieldValue.serverTimestamp();
        }

        tx.update(jobRef, updateData);
      });

      // Get account and API key
      const accountDoc = await db.collection("accounts").doc(accountId).get();
      if (!accountDoc.exists) {
        throw new Error("ACCOUNT_NOT_FOUND");
      }

      const apiKey = accountDoc.data()?.integrations?.couriers?.delhivery?.apiKey;
      if (!apiKey) {
        throw new Error("API_KEY_MISSING");
      }

      // Process this chunk of order IDs
      const endIndex = Math.min(startIndex + MANUAL_CHUNK_SIZE, orderIds.length);
      const chunkOrderIds = orderIds.slice(startIndex, endIndex);

      const result = await processOrderIdsChunk(accountId, apiKey, chunkOrderIds, requestedBy);

      // Store detailed updates in subcollection
      if (result.updatedOrdersList.length > 0) {
        const batch = db.batch();
        result.updatedOrdersList.forEach((orderInfo) => {
          const updateRef = jobRef.collection("updates").doc();
          batch.set(updateRef, {
            ...orderInfo,
            chunkIndex,
            timestamp: FieldValue.serverTimestamp(),
          });
        });
        await batch.commit();
      }

      // Update job progress (without storing full updatedOrdersList)
      const updateData: any = {
        processedOrders: FieldValue.increment(result.processed),
        updatedOrders: FieldValue.increment(result.updated),
        skippedOrders: FieldValue.increment(result.skipped),
        totalChunks: FieldValue.increment(1),
        lastChunkAt: FieldValue.serverTimestamp(),
      };

      // Store errors if any
      if (result.errors.length > 0) {
        updateData.lastErrors = result.errors.slice(0, 5);
      }

      await jobRef.update(updateData);

      // Check if more chunks remain
      const hasMore = endIndex < orderIds.length;

      if (hasMore) {
        // Queue next chunk
        await queueManualUpdateChunk(TASKS_SECRET.value() || "", {
          jobId,
          accountId,
          orderIds,
          requestedBy,
          chunkIndex: chunkIndex! + 1,
          startIndex: endIndex,
        });

        res.json({
          ok: true,
          status: "chunk_completed",
          chunkIndex,
          processed: result.processed,
          updated: result.updated,
          hasMore: true,
          progress: `${endIndex}/${orderIds.length}`,
        });
        return;
      }

      // Job complete
      const finalJobData = (await jobRef.get()).data();
      await jobRef.update({
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
      });

      res.json({
        ok: true,
        status: "job_completed",
        totalProcessed: finalJobData?.processedOrders || 0,
        totalUpdated: finalJobData?.updatedOrders || 0,
        totalSkipped: finalJobData?.skippedOrders || 0,
        totalChunks: finalJobData?.totalChunks || 0,
      });
    } catch (error: any) {
      console.error("processManualUpdateChunk error:", error);

      const { jobId, accountId, chunkIndex } = req.body;
      if (!jobId || !accountId) {
        res.status(500).json({
          ok: false,
          error: "chunk_processing_failed",
          message: error.message || String(error),
        });
        return;
      }

      try {
        const jobRef = db
          .collection("accounts")
          .doc(accountId)
          .collection("manual_status_updates")
          .doc(jobId);

        const jobSnap = await jobRef.get();
        const attempts = Number(jobSnap.data()?.attempts || 0);
        const maxAttempts = Number(process.env.STATUS_UPDATE_QUEUE_MAX_ATTEMPTS || 4);
        const attemptsExhausted = attempts >= maxAttempts;

        const msg = error.message || String(error);
        const code = msg.split(/\s/)[0];
        const NON_RETRYABLE = ["ACCOUNT_NOT_FOUND", "API_KEY_MISSING"];
        const isRetryable = !NON_RETRYABLE.includes(code);

        await jobRef.update({
          status: isRetryable ? (attemptsExhausted ? "failed" : "retrying") : "failed",
          errorCode: isRetryable ? "EXCEPTION" : code,
          errorMessage: msg.slice(0, 400),
          failedAt: FieldValue.serverTimestamp(),
          failedAtChunk: chunkIndex || 0,
        });

        // Return appropriate status code for Cloud Tasks retry behavior
        res.status(isRetryable && !attemptsExhausted ? 503 : 200).json({
          ok: false,
          error:
            isRetryable && !attemptsExhausted ? "chunk_failed_transient" : "chunk_failed_permanent",
          code,
          message: msg,
        });
      } catch (e) {
        console.error("Failed to update job with error status:", e);
        res.status(500).json({
          ok: false,
          error: "chunk_processing_failed",
          message: error.message || String(error),
        });
      }
    }
  },
);

// 3. ORDER PROCESSING - Fetches orders and calls Delhivery API
interface ProcessResult {
  processed: number;
  updated: number;
  skipped: number;
  updatedOrdersList: any[];
  errors: string[];
}

async function processOrderIdsChunk(
  accountId: string,
  apiKey: string,
  orderIds: string[],
  requestedBy: string = "manual",
): Promise<ProcessResult> {
  const excludedStatuses = new Set([
    "New",
    "Confirmed",
    "Ready To Dispatch",
    "DTO Requested",
    "Lost",
    "Closed",
    "RTO Closed",
    "RTO Delivered",
    "DTO Delivered",
  ]);

  // Fetch orders in batches (Firestore getAll limit is 500)
  const orderRefs = orderIds.map((id) =>
    db.collection("accounts").doc(accountId).collection("orders").doc(id),
  );

  const orderDocs: any[] = [];
  const fetchBatchSize = 500;

  for (let i = 0; i < orderRefs.length; i += fetchBatchSize) {
    const batch = orderRefs.slice(i, Math.min(i + fetchBatchSize, orderRefs.length));
    const docs = await db.getAll(...batch);
    orderDocs.push(...docs);
  }

  // Filter to existing Delhivery orders
  const existingOrders = orderDocs
    .filter((doc) => doc.exists)
    .map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }));

  const eligibleOrders = existingOrders.filter(
    (order: any) =>
      order.courier === "Delhivery" &&
      order.awb &&
      order.customStatus &&
      !excludedStatuses.has(order.customStatus),
  );

  if (eligibleOrders.length === 0) {
    return {
      processed: orderIds.length,
      updated: 0,
      skipped: orderIds.length,
      updatedOrdersList: [],
      errors: [],
    };
  }

  console.log(`Processing ${eligibleOrders.length} eligible orders for account ${accountId}`);

  // Process in API batches
  const updatedOrdersList: any[] = [];
  const errors: string[] = [];
  let totalUpdated = 0;

  for (let i = 0; i < eligibleOrders.length; i += API_BATCH_SIZE) {
    const batch = eligibleOrders.slice(i, Math.min(i + API_BATCH_SIZE, eligibleOrders.length));
    const updates = await fetchAndProcessManualBatch(batch, apiKey, requestedBy, errors);

    // Apply updates using Firestore batch writes
    if (updates.length > 0) {
      const writeBatch = db.batch();
      updates.forEach((update) => {
        writeBatch.update(update.ref, update.data);
        updatedOrdersList.push(update.orderInfo);
      });
      await writeBatch.commit();
      totalUpdated += updates.length;
    }

    // Rate limiting
    if (i + API_BATCH_SIZE < eligibleOrders.length) {
      await sleep(150);
    }
  }

  return {
    processed: orderIds.length,
    updated: totalUpdated,
    skipped: orderIds.length - totalUpdated,
    updatedOrdersList,
    errors,
  };
}

// 4. API CALL AND UPDATE PREPARATION
interface ManualOrderUpdate {
  ref: DocumentReference;
  data: any;
  orderInfo: any;
}

async function fetchAndProcessManualBatch(
  orders: any[],
  apiKey: string,
  requestedBy: string,
  errors: string[],
): Promise<ManualOrderUpdate[]> {
  const waybills = orders
    .map((order) => (order.customStatus?.includes("DTO") ? order.awb_reverse : order.awb))
    .filter(Boolean)
    .join(",");

  if (!waybills) return [];

  try {
    const trackingUrl = `https://track.delhivery.com/api/v1/packages/json/?waybill=${waybills}`;
    const response = await fetch(trackingUrl, {
      headers: {
        Authorization: `Token ${apiKey}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorMsg = `Delhivery API error: ${response.status}`;
      console.error(errorMsg);
      errors.push(errorMsg);
      return [];
    }

    const trackingData = (await response.json()) as any;
    const shipments = trackingData.ShipmentData || [];

    return prepareManualUpdates(orders, shipments, requestedBy);
  } catch (error: any) {
    console.error("Batch processing error:", error);
    errors.push(error.message);
    return [];
  }
}

function prepareManualUpdates(
  orders: any[],
  shipments: any[],
  requestedBy: string,
): ManualOrderUpdate[] {
  const updates: ManualOrderUpdate[] = [];
  const ordersByName = new Map(orders.map((o) => [o.name, o]));

  for (const shipmentWrapper of shipments) {
    const shipment = shipmentWrapper.Shipment;
    if (!shipment?.ReferenceNo || !shipment.Status) continue;

    const order = ordersByName.get(shipment.ReferenceNo);
    if (!order) continue;

    const newStatus = determineNewStatus(shipment.Status);
    if (!newStatus || newStatus === order.customStatus) continue;

    updates.push({
      ref: order.ref,
      data: {
        customStatus: newStatus,
        lastStatusUpdate: FieldValue.serverTimestamp(),
        lastManualUpdate: FieldValue.serverTimestamp(),
        lastUpdateRequestedBy: requestedBy,
        customStatusesLogs: FieldValue.arrayUnion({
          status: newStatus,
          createdAt: Timestamp.now(),
          remarks: getStatusRemarks(newStatus),
        }),
      },
      orderInfo: {
        orderId: order.id,
        orderName: order.name,
        oldStatus: order.customStatus,
        newStatus,
        awb: order.awb,
      },
    });
  }

  return updates;
}

// 5. HELPER FUNCTIONS
async function queueManualUpdateChunk(
  tasksSecret: string,
  params: {
    jobId: string;
    accountId: string;
    orderIds: string[];
    requestedBy?: string;
    chunkIndex: number;
    startIndex: number;
  },
): Promise<void> {
  const targetUrl = process.env.UPDATE_STATUS_TASK_MANUAL_TARGET_URL;

  await createTask(params, {
    tasksSecret,
    url: targetUrl,
    queue: process.env.STATUS_UPDATE_QUEUE_NAME || "statuses-update-queue",
    delaySeconds: 2,
  });
}
