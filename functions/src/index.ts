// functions/src/index.ts
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/scheduler";
import type { Request, Response } from "express";
import fetch from "node-fetch";
import { db, FieldValue } from "./firebaseAdmin";
import { createTask } from "./cloudTasks";
import { allocateAwb, releaseAwb } from "./awb";
import {
  buildDelhiveryPayload,
  buildDelhiveryReturnPayload,
  buildShiprocketPayload,
  buildXpressbeesPayload,
} from "./buildPayload";
import { defineSecret } from "firebase-functions/params";
import { setGlobalOptions } from "firebase-functions/options";
import { DocumentReference, Timestamp, Transaction } from "firebase-admin/firestore";
// import { genkit } from 'genkit';
// import vertexAI from "@genkit-ai/vertexai";
import { QueryDocumentSnapshot } from "firebase-functions/firestore";

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
  await db.runTransaction(async (tx: Transaction) => {
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

  // Errors that should not trigger fallback (business logic errors, not carrier issues)
  const isExceptionError =
    errorCode === "INSUFFICIENT_BALANCE" ||
    errorCode === "ORDER_ALREADY_SHIPPED" ||
    errorCode === "ORDER_NOT_FOUND" ||
    errorCode === "COURIER_SELECTION_FAILED";

  // Priority fallback conditions:
  // 1. It's a Priority job
  // 2. Either attempts exhausted OR non-retryable error
  // 3. Has fallback handler URL configured
  // 4. NOT an exception error (insufficient balance, order issues, etc.)
  const shouldAttemptFallback =
    isPriority && (attemptsExhausted || !isRetryable) && !isExceptionError;
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

      // **FIX: Decrement processing counter when moving to fallback**
      await batchRef.update({
        processing: FieldValue.increment(-1),
      });

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

  // Normal failure handling (non-Priority or fallback failed or exception errors)
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
          ? shopDoc?.integrations?.couriers?.priorityList?.[0]?.name.toLowerCase()
          : null;

      const url = (() => {
        if (courier === "Delhivery") return String(process.env.SHIPMENT_TASK_TARGET_URL_1);
        if (courier === "Shiprocket") return String(process.env.SHIPMENT_TASK_TARGET_URL_2);
        if (courier === "Xpressbees") return String(process.env.SHIPMENT_TASK_TARGET_URL_3);

        if (courier === "Priority") {
          if (!priorityCourier) {
            throw new Error("Priority courier not configured in shop settings");
          }
          if (priorityCourier === "delhivery")
            return String(process.env.SHIPMENT_TASK_TARGET_URL_1);
          if (priorityCourier === "shiprocket")
            return String(process.env.SHIPMENT_TASK_TARGET_URL_2);
          if (priorityCourier === "xpressbees")
            return String(process.env.SHIPMENT_TASK_TARGET_URL_3);
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

      // **ADD THIS CHECK:**
      // If job is already processing or completed, don't queue another fallback
      if (
        jobData.status === "processing" ||
        jobData.status === "success" ||
        jobData.status === "failed"
      ) {
        res.json({
          ok: true,
          action: "already_handled",
          message: `Job already in ${jobData.status} state`,
        });
        return;
      }

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
            failed: FieldValue.increment(1),
          }),
        ]);

        await maybeCompleteBatch(batchRef);
        res.status(400).json({ error: "priority_list_not_configured" });
        return;
      }

      // Determine current courier and find its index
      const currentCourier = jobData.courier || capitalizeWords(priorityList[0]?.name);
      const currentIndex = priorityList.findIndex(
        (c: any) => capitalizeWords(c?.name) === currentCourier,
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
      const nextCourier = capitalizeWords(priorityList[nextIndex]?.name);

      // Determine target URL for next courier
      const url = (() => {
        const courierLower = priorityList[nextIndex]?.name.toLowerCase();
        if (courierLower === "delhivery") {
          return String(process.env.SHIPMENT_TASK_TARGET_URL_1);
        }
        if (courierLower === "shiprocket") {
          return String(process.env.SHIPMENT_TASK_TARGET_URL_2);
        }
        if (courierLower === "xpressbees") {
          return String(process.env.SHIPMENT_TASK_TARGET_URL_3);
        }
        throw new Error(`Unsupported fallback courier: ${courierLower}`);
      })();

      // // Update job document with fallback info
      // await jobRef.update({
      //   status: "fallback_queued",
      //   courier: nextCourier,
      //   attempts: 0, // Reset attempts for new courier
      //   previousCouriers: FieldValue.arrayUnion(currentCourier),
      //   fallbackAttempt: (jobData.fallbackAttempt || 0) + 1,
      //   lastFallbackAt: FieldValue.serverTimestamp(),
      //   // Clear old error fields
      //   errorCode: FieldValue.delete(),
      //   errorMessage: FieldValue.delete(),
      // });

      const previousCouriers = jobData.previousCouriers || [];

      // In handlePriorityFallback, before creating new task:
      await db.runTransaction(async (tx: Transaction) => {
        const currentJob = await tx.get(jobRef);
        const currentData = currentJob.data();

        // Only proceed if job is in expected state
        if (currentData?.status !== "attempting_fallback") {
          throw new Error("Job not in expected state for fallback");
        }

        // Update job status atomically
        tx.update(jobRef, {
          status: "fallback_queued",
          courier: nextCourier,
          attempts: 0,
          previousCouriers: FieldValue.arrayUnion(currentCourier),
          fallbackAttempt: (currentData.fallbackAttempt || 0) + 1,
          lastFallbackAt: FieldValue.serverTimestamp(),
          errorCode: FieldValue.delete(),
          errorMessage: FieldValue.delete(),
        });
      });

      // Create task AFTER atomic status update
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
        await db.runTransaction(async (tx: Transaction) => {
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

      // Load order first to check status
      const ordSnap = await orderRef.get();
      if (!ordSnap.exists) throw new Error("ORDER_NOT_FOUND");
      const order = ordSnap.data();

      // Check if order is in correct status for shipping
      if (order?.customStatus !== "Confirmed") {
        const failure = await handleJobFailure({
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

      // --- Start bookkeeping (transaction) -----------------------------------
      await db.runTransaction(async (tx: Transaction) => {
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

      // Carrier API key
      const accSnap = await accountRef.get();

      // Cache data to avoid repeated lookups
      const batchData = (await batchRef.get()).data();
      const accountData = accSnap.data();

      // Determine if this is a priority shipment
      const isPriority = batchData?.courier === "Priority";

      // Get shipping mode
      const payloadShippingMode = (() => {
        if (!isPriority) return shippingMode; // Use default shipping mode

        const priorityCouriers = accountData?.integrations?.couriers?.priorityList;
        const delhiveryConfig = priorityCouriers?.find(
          (courier: any) => courier.name === "delhivery",
        );

        return delhiveryConfig?.mode ?? "Surface"; // Default to Surface if not configured
      })();

      // Build payload for Delhivery
      const payload = buildDelhiveryPayload({
        orderId: String(jobId),
        awb,
        order,
        pickupName,
        shippingMode: payloadShippingMode,
      });

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
            lastStatusUpdate: FieldValue.serverTimestamp(),
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

    /** Classify Shiprocket create-order response (works for all responses) */
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
      const looksSuccess = !("status_code" in (sr ?? {})) || sr?.status_code === 1;

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

      // Check for insufficient balance error
      const lowerMsg = rawMsg.toLowerCase();

      const balanceKeywords = [
        "insufficient",
        "balance",
        "wallet",
        "insufficient balance",
        "low balance",
        "wallet balance",
        "insufficient wallet",
        "insufficient fund",
        "recharge",
        "add balance",
        "balance low",
        "no balance",
        "wallet amount",
        "credit limit",
      ];

      const isBalanceError = balanceKeywords.some((keyword) => lowerMsg.includes(keyword));

      if (isBalanceError) {
        return {
          ok: false,
          retryable: false,
          code: "INSUFFICIENT_BALANCE",
          message: rawMsg || "Insufficient balance in carrier account",
        };
      }

      return {
        ok: false,
        retryable: httpRetryable(sr?.status_code),
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

        // Evaluate all responses (both 2xx and non-2xx)
        const verdict = evalShiprocketResp(pickupJson);

        if (!verdict.ok) {
          return {
            success: false,
            error: verdict.message || `HTTP ${pickupResp.status}`,
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
        await db.runTransaction(async (tx: Transaction) => {
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

      // Load order first to check status
      const ordSnap = await orderRef.get();
      if (!ordSnap.exists) throw new Error("ORDER_NOT_FOUND");
      const order = ordSnap.data();

      // Check if order is in correct status for shipping
      if (order?.customStatus !== "Confirmed") {
        const failure = await handleJobFailure({
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

      // --- Start bookkeeping (transaction) -----------------------------------
      await db.runTransaction(async (tx: Transaction) => {
        const snap = await tx.get(jobRef);
        const data = snap.data() || {};
        const prevAttempts = Number(data.attempts || 0);
        const jobStatus = data.status;

        // FIX: Don't decrement queued if this is a fallback attempt
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

      // Carrier token/config
      const accSnap = await accountRef.get();
      const accountData = accSnap.data();

      const shiprocketCfg = accountData?.integrations?.couriers?.shiprocket || {};
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

        const priorityCouriers = accountData?.integrations?.couriers?.priorityList;
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
        const verdict = evalShiprocketResp(orderCreateJson);

        // Handle both HTTP errors and business logic errors
        if (!verdict.ok) {
          const errorCode = verdict.code;
          const errorMessage = verdict.message;
          const isRetryable = verdict.retryable;

          const failure = await handleJobFailure({
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
          // This shouldn't happen with successful verdict, but handle gracefully
          const failure = await handleJobFailure({
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
      const awbVerdict = evalShiprocketResp(awbJson);

      // Handle both HTTP errors and business logic errors
      if (!awbVerdict.ok) {
        const errorCode = awbVerdict.code;
        const errorMessage = awbVerdict.message;
        const isRetryable = awbVerdict.retryable;

        const failure = await handleJobFailure({
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
        // This shouldn't happen with successful verdict, but handle gracefully
        const failure = await handleJobFailure({
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

      // Mark job as success
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

      // Set or delete errorMessage based on pickup result
      if (pickupErrorMessage) {
        jobUpdate.errorMessage = pickupErrorMessage;
      } else {
        jobUpdate.errorMessage = FieldValue.delete();
      }

      await Promise.all([
        jobRef.update(jobUpdate),
        batchRef.update({
          processing: FieldValue.increment(-1),
          success: FieldValue.increment(1),
        }),
        orderRef.set(
          {
            awb: awbCode,
            courier: `Shiprocket: ${courierName ?? "Unknown"}`,
            customStatus: "Ready To Dispatch",
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Ready To Dispatch",
              createdAt: Timestamp.now(),
              remarks: `The order's shipment was successfully made on ${courierName} via Shiprocket (AWB: ${awbCode})`,
            }),
          },
          { merge: true },
        ),
      ]);

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

/** Cloud Tasks → processes exactly ONE Xpressbees shipment job */
export const processShipmentTask3 = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    // --- helpers -------------------------------------------------------------
    const parseJson = (t: string) => {
      try {
        return JSON.parse(t);
      } catch {
        return { raw: t };
      }
    };

    /** Classify Xpressbees shipment response (handles both success and error) */
    function evalXpressbeesResp(xb: any): {
      ok: boolean;
      retryable: boolean;
      code: string;
      message: string;
      awbNumber?: string | null;
      shipmentId?: string | number | null;
      orderId?: string | number | null;
      courierName?: string | null;
    } {
      // Success: { status: true, data: { ... } }
      if (xb?.status === true && xb?.data) {
        const data = xb.data;
        return {
          ok: true,
          retryable: false,
          code: "OK",
          message: "created",
          awbNumber: data?.awb_number ?? null,
          shipmentId: data?.shipment_id ?? null,
          orderId: data?.order_id ?? null,
          courierName: data?.courier_name ?? null,
        };
      }

      // Error: { status: false, message: "..." }
      const errorMessage = xb?.message || "Unknown Xpressbees error";

      // Check for insufficient balance error
      const lowerMsg = String(errorMessage).toLowerCase();
      const balanceKeywords = [
        "insufficient",
        "balance",
        "wallet",
        "recharge",
        "add balance",
        "low balance",
      ];

      const isBalanceError = balanceKeywords.some((keyword) => lowerMsg.includes(keyword));

      if (isBalanceError) {
        return {
          ok: false,
          retryable: false,
          code: "INSUFFICIENT_BALANCE",
          message: errorMessage,
        };
      }

      // Other errors are non-retryable (validation errors, etc.)
      return {
        ok: false,
        retryable: false,
        code: "CARRIER_ERROR",
        message: errorMessage,
      };
    }

    /** Decide if an HTTP failure status is retryable */
    function httpRetryable(status: number) {
      if (status === 429 || status === 408 || status === 409 || status === 425) return true;
      if (status >= 500) return true;
      return false;
    }

    /**
     * Fetch Xpressbees courier list and select appropriate courier based on mode and weight
     */
    async function selectCourier(
      token: string,
      shippingMode: string,
      totalQuantity: number,
    ): Promise<string> {
      try {
        const resp = await fetch("https://shipment.xpressbees.com/api/courier", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!resp.ok) {
          throw new Error(`Failed to fetch couriers: HTTP ${resp.status}`);
        }

        const result = (await resp.json()) as any;
        if (!result?.status || !Array.isArray(result?.data)) {
          throw new Error("Invalid courier list response");
        }

        const couriers = result.data as Array<{ id: string; name: string }>;

        // For Express mode: Select "Air Xpressbees 0.5 K.G"
        if (shippingMode === "Express") {
          const airCourier = couriers.find((c) => c.name.toLowerCase().includes("air"));
          if (airCourier) return airCourier.id;
          throw new Error("No Air courier found for Express mode");
        }

        // For Surface mode: Calculate weight and select based on weight
        const totalWeightGrams = totalQuantity * 250;
        const totalWeightKg = totalWeightGrams / 1000;

        // Extract weight from courier names and sort by weight
        // Expected format: "Surface Xpressbees 0.5 K.G", "Xpressbees 1 K.G", etc.
        const surfaceCouriers = couriers
          .filter((c) => {
            const nameLower = c.name.toLowerCase();
            return (
              (nameLower.includes("surface") || nameLower.includes("xpressbees")) &&
              !nameLower.includes("air") &&
              !nameLower.includes("express") &&
              !nameLower.includes("reverse") &&
              !nameLower.includes("same day") &&
              !nameLower.includes("next day")
            );
          })
          .map((c) => {
            // Extract weight value from name (e.g., "0.5", "1", "2", "5", "10")
            const weightMatch = c.name.match(/(\d+(?:\.\d+)?)\s*k\.?g/i);
            const weight = weightMatch ? parseFloat(weightMatch[1]) : 0;
            return { ...c, weight };
          })
          .filter((c) => c.weight > 0)
          .sort((a, b) => a.weight - b.weight);

        if (surfaceCouriers.length === 0) {
          throw new Error("No Surface couriers found");
        }

        // Select the smallest courier that can handle the weight
        // If weight exceeds all options, select the largest
        let selectedCourier = surfaceCouriers[surfaceCouriers.length - 1]; // default to largest

        for (const courier of surfaceCouriers) {
          if (totalWeightKg <= courier.weight) {
            selectedCourier = courier;
            break;
          }
        }

        return selectedCourier.id;
      } catch (error) {
        console.error("Courier selection error:", error);
        throw new Error(
          `COURIER_SELECTION_FAILED: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
        await db.runTransaction(async (tx: Transaction) => {
          const b = await tx.get(batchRef);
          const d = b.data() || {};
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

      // Load order first to check status
      const ordSnap = await orderRef.get();
      if (!ordSnap.exists) throw new Error("ORDER_NOT_FOUND");
      const order = ordSnap.data();

      // Check if order is in correct status for shipping
      if (order?.customStatus !== "Confirmed") {
        const failure = await handleJobFailure({
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

      // --- Start bookkeeping (transaction) -----------------------------------
      await db.runTransaction(async (tx: Transaction) => {
        const snap = await tx.get(jobRef);
        const data = snap.data() || {};
        const prevAttempts = Number(data.attempts || 0);
        const jobStatus = data.status;

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
      });

      // Get Xpressbees API key
      const accSnap = await accountRef.get();
      const accountData = accSnap.data();
      const xpressbeesCfg = accSnap.data()?.integrations?.couriers?.xpressbees || {};
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

        const priorityCouriers = accountData?.integrations?.couriers?.priorityList;
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
      const verdict = evalXpressbeesResp(carrier);

      // Handle API errors (proper Xpressbees error responses)
      if (!verdict.ok) {
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
      await Promise.all([
        jobRef.update({
          status: "success",
          awb: verdict.awbNumber ?? null,
          carrierShipmentId: verdict.shipmentId ?? null,
          xpressbeesOrderId: verdict.orderId ?? null,
          courierName: verdict.courierName ?? null,
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
            awb: verdict.awbNumber ?? null,
            courier: `Xpressbees: ${verdict.courierName ?? "Unknown"}`,
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
        ),
      ]);

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
        const { shop, batchId, jobId } = (req.body || {}) as {
          shop?: string;
          batchId?: string;
          jobId?: string;
        };

        if (shop && batchId && jobId) {
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

// ============================================================================
// RETURN SHIPMENT ERROR HANDLER (No Priority Fallback)
// ============================================================================

async function handleReturnJobFailure(params: {
  shop: string;
  batchRef: DocumentReference;
  jobRef: DocumentReference;
  jobId: string;
  errorCode: string;
  errorMessage: string;
  isRetryable: boolean;
  apiResp?: any;
}): Promise<{ shouldReturnFailure: boolean; statusCode: number; reason: string }> {
  const { batchRef, jobRef, errorCode, errorMessage, isRetryable, apiResp } = params;

  const jobSnap = await jobRef.get();
  const jobData = jobSnap.data() || {};

  const attempts = Number(jobData.attempts || 0);
  const maxAttempts = Number(process.env.RETURN_SHIPMENT_QUEUE_MAX_ATTEMPTS || 3);
  const attemptsExhausted = attempts >= maxAttempts;

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

/** Called by Vercel API to enqueue return shipment Cloud Tasks (one per jobId) */
export const enqueueReturnShipmentTasks = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [ENQUEUE_FUNCTION_SECRET, TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { shop, orderIds, pickupName, shippingMode, requestedBy } = (req.body || {}) as {
        shop?: string;
        orderIds?: string[];
        pickupName?: string;
        shippingMode?: string;
        requestedBy?: string;
      };

      if (
        !shop ||
        !pickupName ||
        !shippingMode ||
        !Array.isArray(orderIds) ||
        orderIds.length === 0
      ) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      const shopDoc = (await db.collection("accounts").doc(shop).get()).data();
      if (!shopDoc) {
        res.status(400).json({ error: "shop_not_found" });
        return;
      }

      // Validate orders
      const orderRefs = orderIds.map((o) =>
        db.collection("accounts").doc(shop).collection("orders").doc(String(o)),
      );

      const orderSnapshots = await db.getAll(...orderRefs);
      const orderDataMap = new Map<string, any>();

      for (let i = 0; i < orderSnapshots.length; i++) {
        const snap = orderSnapshots[i];
        if (!snap.exists) {
          res.status(400).json({
            error: "order_not_found",
            orderId: orderIds[i],
          });
          return;
        }

        const orderData = snap.data()!;

        // Validate courier exists
        if (!orderData.courier) {
          res.status(400).json({
            error: "order_missing_courier",
            orderId: orderIds[i],
            message: "Cannot create return for order without courier",
          });
          return;
        }

        // Validate customStatus is either "Delivered" or "DTO Requested"
        const status = orderData.customStatus;
        if (status !== "Delivered" && status !== "DTO Requested") {
          res.status(400).json({
            error: "invalid_order_status",
            orderId: orderIds[i],
            currentStatus: status,
            message: 'Order status must be "Delivered" or "DTO Requested" to create return',
          });
          return;
        }

        orderDataMap.set(String(orderIds[i]), orderData);
      }

      // Create batch header
      const batchRef = db.collection("accounts").doc(shop).collection("book_return_batches").doc();

      await batchRef.set({
        shop,
        pickupName,
        shippingMode,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: requestedBy,
        total: orderIds.length,
        queued: orderIds.length,
        status: "queued",
        processing: 0,
        success: 0,
        failed: 0,
      });

      // Create job docs with courier info
      const writer = db.bulkWriter();
      const taskPromises: Promise<any>[] = [];

      for (const o of orderIds) {
        const orderData = orderDataMap.get(String(o))!;
        const courier = orderData.courier;

        const normalizedCourier = courier.split(":")[0].trim();

        // Map courier to return booking URL
        let taskUrl: string;
        try {
          if (normalizedCourier === "Delhivery") {
            taskUrl = String(process.env.RETURN_TASK_TARGET_URL_1);
          } else if (normalizedCourier === "Shiprocket") {
            taskUrl = String(process.env.RETURN_TASK_TARGET_URL_2);
          } else {
            throw new Error(`Unsupported courier for returns: ${normalizedCourier}`);
          }
        } catch (urlError) {
          console.error(`Failed to map courier ${normalizedCourier} for order ${o}:`, urlError);

          writer.set(
            batchRef.collection("jobs").doc(String(o)),
            {
              orderId: String(o),
              orderName: orderData.name,
              courier: normalizedCourier,
              status: "failed",
              errorCode: "UNSUPPORTED_COURIER",
              errorMessage: `Courier ${normalizedCourier} is not supported for returns`,
              attempts: 0,
            },
            { merge: true },
          );

          continue;
        }

        // Create job document
        writer.set(
          batchRef.collection("jobs").doc(String(o)),
          {
            orderId: String(o),
            orderName: orderData.name,
            courier: normalizedCourier,
            status: "queued",
            attempts: 0,
          },
          { merge: true },
        );

        // Queue Cloud Task (NO variantIds in payload)
        taskPromises.push(
          createTask(
            {
              shop,
              batchId: batchRef.id,
              jobId: String(o),
              pickupName,
              shippingMode,
            } as any,
            {
              tasksSecret: TASKS_SECRET.value() || "",
              url: taskUrl,
              queue: String(process.env.RETURN_SHIPMENT_QUEUE_NAME) || "return-shipments-queue",
            },
          ).catch((taskError) => {
            console.error(`Failed to create task for order ${o}:`, taskError);
            return batchRef
              .collection("jobs")
              .doc(String(o))
              .update({
                status: "failed",
                errorCode: "TASK_CREATION_FAILED",
                errorMessage: taskError.message || String(taskError),
              });
          }),
        );
      }

      await writer.close();
      await Promise.allSettled(taskPromises);

      // Recalculate batch counters
      const jobsSnap = await batchRef.collection("jobs").get();
      let queuedCount = 0;
      let failedCount = 0;

      jobsSnap.forEach((jobDoc: QueryDocumentSnapshot) => {
        const jobData = jobDoc.data();
        if (jobData.status === "queued") {
          queuedCount++;
        } else if (jobData.status === "failed") {
          failedCount++;
        }
      });

      await batchRef.update({
        status:
          queuedCount > 0 ? "running" : failedCount === orderIds.length ? "completed" : "running",
        queued: queuedCount,
        failed: failedCount,
      });

      res.status(202).json({
        collectionName: "book_return_batches",
        batchId: batchRef.id,
        queued: queuedCount,
        failed: failedCount,
      });
      return;
    } catch (e: any) {
      console.error("enqueue return error:", e);
      res.status(500).json({
        error: "start_return_batch_failed",
        details: String(e?.message ?? e),
      });
      return;
    }
  },
);

// ============================================================================
// RETURN SHIPMENT TASK PROCESSOR (DELHIVERY)
// ============================================================================

// Non-retryable error codes for returns
const RETURN_NON_RETRYABLE = new Set([
  "CARRIER_KEY_MISSING",
  "ORDER_NOT_FOUND",
  "NO_ITEMS_MATCH_RETURN_VARIANT_IDS",
  "NO_LINE_ITEMS_IN_ORDER",
  "NO_AWB_AVAILABLE",
  "INVALID_ORDER_STATUS",
]);

/** Cloud Tasks → processes exactly ONE return shipment job (Delhivery) */
export const processReturnShipmentTask = onRequest(
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

      const { shop, batchId, jobId, pickupName, shippingMode } = (req.body || {}) as {
        shop?: string;
        batchId?: string;
        jobId?: string;
        pickupName?: string;
        shippingMode?: string;
      };

      if (!shop || !batchId || !jobId || !pickupName) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      const batchRef = db
        .collection("accounts")
        .doc(shop)
        .collection("book_return_batches")
        .doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(String(jobId));
      const orderRef = db.collection("accounts").doc(shop).collection("orders").doc(String(jobId));
      const accountRef = db.collection("accounts").doc(shop);

      // Idempotency: if already success, just ack
      const jSnap = await jobRef.get();
      if (jSnap.exists && jSnap.data()?.status === "success") {
        // Fix any inconsistent batch counters
        await db.runTransaction(async (tx: Transaction) => {
          const b = await tx.get(batchRef);
          const d = b.data() || {};

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
      await db.runTransaction(async (tx: Transaction) => {
        const snap = await tx.get(jobRef);
        const data = snap.data() || {};
        const prevAttempts = Number(data.attempts || 0);
        const firstAttempt = prevAttempts === 0 || !data.status || data.status === "queued";

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

      // ✅ Validate order status before processing
      const status = order?.customStatus;
      if (status !== "Delivered" && status !== "DTO Requested") {
        throw new Error("INVALID_ORDER_STATUS");
      }

      // Build payload for Delhivery return
      const payload = buildDelhiveryReturnPayload({
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
            await releaseAwb(shop, awb);
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

        res.status(failure.statusCode).json({
          ok: false,
          reason: failure.reason,
          code: `HTTP_${resp.status}`,
        });
        return;
      }

      // Parse and evaluate carrier JSON
      const carrier = parseJson(text);
      const verdict = evalDelhiveryReturnResp(carrier);

      if (!verdict.ok) {
        if (awb && !awbReleased) {
          try {
            await releaseAwb(shop, awb);
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

        res.status(failure.statusCode).json({
          ok: false,
          reason: failure.reason,
          code: verdict.code,
        });
        return;
      }

      // --- Success path ------------------------------------------------------
      awbReleased = true; // guard: DO NOT release a used AWB

      await Promise.all([
        jobRef.update({
          status: "success",
          awb,
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
            awb_reverse: awb,
            customStatus: "DTO Booked",
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "DTO Booked",
              createdAt: Timestamp.now(),
              remarks: `Return shipment was successfully booked on Delhivery (AWB: ${awb})`,
            }),
          },
          { merge: true },
        ),
      ]);

      await maybeCompleteBatch(batchRef);

      res.json({ ok: true, awb });
      return;
    } catch (e: any) {
      // Generic failure (network/bug/etc.)
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.split(/\s/)[0];
      const isRetryable = !RETURN_NON_RETRYABLE.has(code);

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

          res.status(failure.statusCode).json({
            error: isRetryable ? "job_failed_transient" : "job_failed_permanent",
            code,
            message: msg,
          });
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
              lastStatusUpdate: FieldValue.serverTimestamp(),
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
  await db.runTransaction(async (tx: Transaction) => {
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
function determineNewDelhiveryStatus(status: any): string | null {
  const { Status, StatusType } = status;

  const statusMap: Record<string, Record<string, string>> = {
    "In Transit": { UD: "In Transit", RT: "RTO In Transit", PU: "DTO In Transit" },
    Pending: { UD: "In Transit", RT: "RTO In Transit", PU: "DTO In Transit" },
    Dispatched: { UD: "Out For Delivery" },
    Delivered: { DL: "Delivered" },
    RTO: { DL: "RTO Delivered" },
    DTO: { DL: "DTO Delivered" },
    Lost: { LT: "Lost" },
    Closed: { CN: "Closed/Cancelled Conditional" },
    Cancelled: { CN: "Closed/Cancelled Conditional" },
    Canceled: { CN: "Closed/Cancelled Conditional" },
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
// SCHEDULED DELHIVERY STATUS UPDATES
// ============================================================================

// 1. SCHEDULER - Enqueues initial tasks (one per account)
export const enqueueDelhiveryStatusUpdateTasksScheduled = onSchedule(
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

        await db.runTransaction(async (tx: Transaction) => {
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
      const result = await processDelhiveryOrderChunk(accountId, apiKey, cursor);

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

async function processDelhiveryOrderChunk(
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
    .map((doc: QueryDocumentSnapshot) => ({ id: doc.id, ref: doc.ref, ...doc.data() }))
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
    const updates = await fetchAndProcessDelhiveryBatch(batch, apiKey);

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

async function fetchAndProcessDelhiveryBatch(
  orders: any[],
  apiKey: string,
): Promise<OrderUpdate[]> {
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

    return prepareDelhiveryOrderUpdates(orders, shipments);
  } catch (error: any) {
    console.error("Batch processing error:", error);
    if (error.message.startsWith("HTTP_")) {
      throw error;
    }
    return [];
  }
}

// 5. UPDATE PREPARATION - Maps API responses to Firestore updates
function prepareDelhiveryOrderUpdates(orders: any[], shipments: any[]): OrderUpdate[] {
  const updates: OrderUpdate[] = [];
  const ordersByName = new Map(orders.map((o) => [o.name, o]));

  for (const shipmentWrapper of shipments) {
    const shipment = shipmentWrapper.Shipment;
    if (!shipment?.ReferenceNo || !shipment.Status) continue;

    const order = ordersByName.get(shipment.ReferenceNo);
    if (!order) continue;

    const newStatus = determineNewDelhiveryStatus(shipment.Status);
    if (!newStatus) continue;
    if (newStatus === order.customStatus) continue;
    if (newStatus === "Closed/Cancelled Conditional") {
      if (order.customStatus === "DTO Booked") {
        updates.push({
          ref: order.ref,
          data: {
            customStatus: "Delivered",
            awb_reverse: FieldValue.delete(),
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Delivered",
              createdAt: Timestamp.now(),
              remarks: "This order was Cancelled on DTO, and was changed to 'Delivered' again.",
            }),
          },
        });
      }
      if (order.customStatus === "Ready To Dispatch") {
        updates.push({
          ref: order.ref,
          data: {
            customStatus: "Confirmed",
            courier: FieldValue.delete(),
            awb: FieldValue.delete(),
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Confirmed",
              createdAt: Timestamp.now(),
              remarks:
                "This order was Cancelled on by Delhivery, and was changed to 'Confirmed' again.",
            }),
          },
        });
      }
      continue;
    }
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
// SHARED UTILITIES - Used by both scheduled and manual updates
// ============================================================================
// function determineNewShiprocketStatus(currentStatus: string): string | null {
//   const statusMap: Record<string, string> = {
//     "In Transit": "In Transit",
//     "Out For Delivery": "Out For Delivery",
//     "Delivered": "Delivered",
//   };

//   return statusMap[currentStatus] || null;
// }

// // ============================================================================
// // SCHEDULED SHIPROCKET STATUS UPDATES
// // ============================================================================

// // 1. SCHEDULER - Enqueues initial tasks (one per account)
// export const enqueueShiprocketStatusUpdateTasksScheduled = onSchedule(
//   {
//     schedule: "0 0,4,8,12,16,20 * * *", // 6 times daily
//     timeZone: "Asia/Kolkata",
//     region: process.env.LOCATION || "asia-south1",
//     memory: "512MiB",
//     timeoutSeconds: 540,
//     secrets: [TASKS_SECRET],
//   },
//   async (event) => {
//     console.log(`Starting scheduled Shiprocket status update batch processing...${event ? "" : ""}`);

//     try {
//       const usersSnapshot = await db.collection("users").where("activeAccountId", "!=", null).get();

//       if (usersSnapshot.empty) {
//         console.log("No users with active accounts found");
//         return;
//       }

//       // Group users by account and filter for Shiprocket integration
//       const accountToUsers = new Map<string, string[]>();
//       let totalUsersCount = 0;

//       for (const userDoc of usersSnapshot.docs) {
//         const userId = userDoc.id;
//         const activeAccountId = userDoc.get("activeAccountId");
//         if (!activeAccountId) continue;

//         try {
//           const accountDoc = await db.collection("accounts").doc(activeAccountId).get();
//           if (!accountDoc.exists) continue;

//           const apiKey = accountDoc.data()?.integrations?.couriers?.shiprocket?.apiKey;
//           if (apiKey) {
//             if (!accountToUsers.has(activeAccountId)) {
//               accountToUsers.set(activeAccountId, []);
//             }
//             accountToUsers.get(activeAccountId)!.push(userId);
//             totalUsersCount++;
//           }
//         } catch (error) {
//           console.error(`Error checking account ${activeAccountId}:`, error);
//         }
//       }

//       if (accountToUsers.size === 0) {
//         console.log("No accounts with Shiprocket integration found");
//         return;
//       }

//       console.log(
//         `Found ${accountToUsers.size} accounts with Shiprocket (${totalUsersCount} users)`,
//       );

//       // Create batch header
//       const batchRef = db.collection("status_update_batches").doc();
//       const batchId = batchRef.id;

//       await batchRef.set({
//         createdAt: FieldValue.serverTimestamp(),
//         createdBy: "system-scheduled",
//         total: accountToUsers.size,
//         totalUsers: totalUsersCount,
//         queued: accountToUsers.size,
//         status: "running",
//         processing: 0,
//         success: 0,
//         failed: 0,
//         type: "status_update",
//         schedule: "6x_daily",
//         courier: "shiprocket",
//       });

//       // Create job documents (one per account)
//       const writer = db.bulkWriter();
//       for (const [accountId, userIds] of accountToUsers) {
//         writer.set(
//           batchRef.collection("jobs").doc(accountId),
//           {
//             accountId,
//             userIds,
//             userCount: userIds.length,
//             status: "queued",
//             attempts: 0,
//             createdAt: FieldValue.serverTimestamp(),
//             processedOrders: 0,
//             updatedOrders: 0,
//             totalChunks: 0,
//           },
//           { merge: true },
//         );
//       }
//       await writer.close();

//       const targetUrl = process.env.UPDATE_STATUS_TASK_JOB_TARGET_URL_SHIPROCKET;
//       if (!targetUrl) {
//         throw new Error("UPDATE_STATUS_TASK_TARGET_URL_SHIPROCKET not configured");
//       }

//       // Create initial tasks (chunk 0 for each account)
//       const taskPromises = Array.from(accountToUsers.entries()).map(([accountId, userIds], index) =>
//         createTask(
//           {
//             accountId,
//             userIds,
//             batchId,
//             jobId: accountId,
//             chunkIndex: 0,
//             cursor: null,
//           } as any,
//           {
//             tasksSecret: TASKS_SECRET.value() || "",
//             url: targetUrl,
//             queue: process.env.STATUS_UPDATE_QUEUE_NAME_SHIPROCKET || "shiprocket-status-update-queue",
//             delaySeconds: Math.floor(index * 2),
//           },
//         ),
//       );

//       await Promise.all(taskPromises);

//       console.log(`Enqueued ${accountToUsers.size} initial tasks for batch ${batchId}`);
//     } catch (error) {
//       console.error("enqueueShiprocketStatusUpdateTasks failed:", error);
//       throw error;
//     }
//   },
// );

// // 2. MAIN TASK HANDLER - Processes one chunk and queues next if needed
// export const updateShiprocketStatusesJob = onRequest(
//   { cors: true, timeoutSeconds: 540, secrets: [TASKS_SECRET], memory: "512MiB" },
//   async (req: Request, res: Response): Promise<void> => {
//     try {
//       requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");

//       if (req.method !== "POST") {
//         res.status(405).json({ error: "method_not_allowed" });
//         return;
//       }

//       const {
//         accountId,
//         userIds,
//         batchId,
//         jobId,
//         cursor = null,
//         chunkIndex = 0,
//       } = req.body as {
//         accountId?: string;
//         userIds?: string[];
//         batchId?: string;
//         jobId?: string;
//         cursor?: string | null;
//         chunkIndex?: number;
//       };

//       if (!accountId || !userIds?.length || !batchId || !jobId) {
//         res.status(400).json({ error: "missing_required_params" });
//         return;
//       }

//       const batchRef = db.collection("status_update_batches").doc(batchId);
//       const jobRef = batchRef.collection("jobs").doc(jobId);

//       // Idempotency check
//       const jSnap = await jobRef.get();
//       if (jSnap.exists && jSnap.data()?.status === "success") {
//         res.json({ ok: true, dedup: true });
//         return;
//       }

//       // Initialize job on first chunk
//       if (chunkIndex === 0) {
//         const validUserIds = await validateUsers(accountId, userIds);
//         if (validUserIds.length === 0) {
//           throw new Error("NO_VALID_USERS_FOR_ACCOUNT");
//         }

//         await db.runTransaction(async (tx: Transaction) => {
//           const snap = await tx.get(jobRef);
//           const data = snap.data() || {};
//           const prevAttempts = Number(data.attempts || 0);
//           const firstAttempt = prevAttempts === 0 || data.status === "queued";

//           tx.set(
//             jobRef,
//             {
//               status: "processing",
//               attempts: (prevAttempts || 0) + 1,
//               lastAttemptAt: FieldValue.serverTimestamp(),
//               accountId,
//               userIds: validUserIds,
//               userCount: validUserIds.length,
//               processedOrders: 0,
//               updatedOrders: 0,
//               totalChunks: 0,
//             },
//             { merge: true },
//           );

//           const inc: any = { processing: FieldValue.increment(1) };
//           if (firstAttempt) inc.queued = FieldValue.increment(-1);
//           tx.update(batchRef, inc);
//         });
//       }

//       // Verify account and get API key
//       const accountDoc = await db.collection("accounts").doc(accountId).get();
//       if (!accountDoc.exists) throw new Error("ACCOUNT_NOT_FOUND");

//       const apiKey = accountDoc.data()?.integrations?.couriers?.shiprocket?.apiKey;
//       if (!apiKey) throw new Error("API_KEY_MISSING");

//       // Process one chunk of orders
//       const result = await processShiprocketOrderChunk(accountId, apiKey, cursor);

//       // Update job progress
//       await jobRef.update({
//         processedOrders: FieldValue.increment(result.processed),
//         updatedOrders: FieldValue.increment(result.updated),
//         totalChunks: FieldValue.increment(1),
//         lastChunkAt: FieldValue.serverTimestamp(),
//         lastCursor: result.nextCursor || FieldValue.delete(),
//       });

//       // If more work remains, queue next chunk
//       if (result.hasMore && result.nextCursor) {
//         await queueNextChunk(TASKS_SECRET.value() || "", {
//           accountId,
//           userIds,
//           batchId,
//           jobId,
//           cursor: result.nextCursor,
//           chunkIndex: chunkIndex + 1,
//         });

//         res.json({
//           ok: true,
//           status: "chunk_completed",
//           chunkIndex,
//           processed: result.processed,
//           updated: result.updated,
//           hasMore: true,
//         });
//         return;
//       }

//       // Job complete
//       const jobData = (await jobRef.get()).data() || {};
//       await Promise.all([
//         jobRef.update({
//           status: "success",
//           message: "status_update_completed",
//           completedAt: FieldValue.serverTimestamp(),
//         }),
//         batchRef.update({
//           processing: FieldValue.increment(-1),
//           success: FieldValue.increment(1),
//         }),
//       ]);

//       await maybeCompleteBatch(batchRef);

//       res.json({
//         ok: true,
//         status: "job_completed",
//         totalProcessed: jobData.processedOrders || 0,
//         totalUpdated: jobData.updatedOrders || 0,
//         totalChunks: jobData.totalChunks || 0,
//       });
//     } catch (error: any) {
//       await handleJobError(error, req.body);
//       const msg = error.message || String(error);
//       const code = msg.split(/\s/)[0];
//       const NON_RETRYABLE = ["ACCOUNT_NOT_FOUND", "API_KEY_MISSING", "NO_VALID_USERS_FOR_ACCOUNT"];
//       const isRetryable = !NON_RETRYABLE.includes(code);

//       res.status(isRetryable ? 503 : 200).json({
//         ok: false,
//         error: isRetryable ? "job_failed_transient" : "job_failed_permanent",
//         code,
//         message: msg,
//       });
//     }
//   },
// );

// // 3. CHUNK PROCESSOR - Fetches and processes one page of orders
// interface ChunkResult {
//   processed: number;
//   updated: number;
//   hasMore: boolean;
//   nextCursor?: string;
// }

// async function processShiprocketOrderChunk(
//   accountId: string,
//   apiKey: string,
//   cursor: string | null,
// ): Promise<ChunkResult> {
//   const excludedStatuses = new Set([
//     "New",
//     "Confirmed",
//     "Ready To Dispatch",
//     "Delivered",
//   ]);

//   // Build paginated query - using array-contains to match couriers that include "Shiprocket"
//   let query = db
//     .collection("accounts")
//     .doc(accountId)
//     .collection("orders")
//     .where("courier", ">=", "Shiprocket")
//     .where("courier", "<=", "Shiprocket\uf8ff")
//     .orderBy("courier")
//     .orderBy("__name__")
//     .limit(CHUNK_SIZE);

//   if (cursor) {
//     // Cursor should be in format "courier|docId"
//     const [courierCursor, docIdCursor] = cursor.split("|");
//     query = query.startAfter(courierCursor, docIdCursor);
//   }

//   const snapshot = await query.get();

//   if (snapshot.empty) {
//     return { processed: 0, updated: 0, hasMore: false };
//   }

//   const eligibleOrders = snapshot.docs
//     .map((doc: QueryDocumentSnapshot) => ({ id: doc.id, ref: doc.ref, ...doc.data() }))
//     .filter(
//       (order: any) =>
//         order.awb &&
//         order.customStatus &&
//         !excludedStatuses.has(order.customStatus) &&
//         order.courier?.includes("Shiprocket")
//     );

//   if (eligibleOrders.length === 0) {
//     const lastDoc = snapshot.docs[snapshot.docs.length - 1];
//     const lastCourier = lastDoc.get("courier");
//     return {
//       processed: snapshot.size,
//       updated: 0,
//       hasMore: snapshot.size === CHUNK_SIZE,
//       nextCursor: `${lastCourier}|${lastDoc.id}`,
//     };
//   }

//   console.log(`Processing ${eligibleOrders.length} eligible Shiprocket orders for account ${accountId}`);

//   // Process in API batches
//   let totalUpdated = 0;

//   for (let i = 0; i < eligibleOrders.length; i += API_BATCH_SIZE) {
//     const batch = eligibleOrders.slice(i, Math.min(i + API_BATCH_SIZE, eligibleOrders.length));
//     const updates = await fetchAndProcessShiprocketBatch(batch, apiKey);

//     // Apply updates using Firestore batch writes
//     if (updates.length > 0) {
//       const writeBatch = db.batch();
//       updates.forEach((update) => {
//         writeBatch.update(update.ref, update.data);
//       });
//       await writeBatch.commit();
//       totalUpdated += updates.length;
//       console.log(`Updated ${updates.length} orders in API batch ${i / API_BATCH_SIZE + 1}`);
//     }

//     // Rate limiting between API calls
//     if (i + API_BATCH_SIZE < eligibleOrders.length) {
//       await sleep(150);
//     }
//   }

//   const lastDoc = snapshot.docs[snapshot.docs.length - 1];
//   const hasMore = snapshot.size === CHUNK_SIZE;
//   const lastCourier = lastDoc.get("courier");

//   return {
//     processed: eligibleOrders.length,
//     updated: totalUpdated,
//     hasMore,
//     nextCursor: hasMore ? `${lastCourier}|${lastDoc.id}` : undefined,
//   };
// }

// // 4. API PROCESSOR - Calls Shiprocket and prepares updates
// interface OrderUpdate {
//   ref: DocumentReference;
//   data: any;
// }

// async function fetchAndProcessShiprocketBatch(orders: any[], apiKey: string): Promise<OrderUpdate[]> {
//   const awbs = orders.map((order) => order.awb).filter(Boolean);

//   if (awbs.length === 0) return [];

//   try {
//     const trackingUrl = "https://apiv2.shiprocket.in/v1/external/courier/track/awbs";
//     const response = await fetch(trackingUrl, {
//       method: "POST",
//       headers: {
//         "Authorization": `Bearer ${apiKey}`,
//         "Content-Type": "application/json",
//         "Accept": "application/json",
//       },
//       body: JSON.stringify({ awbs }),
//     });

//     if (!response.ok) {
//       if (response.status >= 500 || response.status === 429) {
//         throw new Error(`HTTP_${response.status}`);
//       }
//       console.error(`Shiprocket API error: ${response.status}`);
//       return [];
//     }

//     const trackingData = (await response.json()) as any;

//     return prepareShiprocketOrderUpdates(orders, trackingData);
//   } catch (error: any) {
//     console.error("Batch processing error:", error);
//     if (error.message.startsWith("HTTP_")) {
//       throw error;
//     }
//     return [];
//   }
// }

// // 5. UPDATE PREPARATION - Maps API responses to Firestore updates
// function prepareShiprocketOrderUpdates(orders: any[], trackingData: any): OrderUpdate[] {
//   const updates: OrderUpdate[] = [];
//   const ordersByAwb = new Map(orders.map((o) => [o.awb, o]));

//   for (const [awb, shipmentData] of Object.entries(trackingData)) {
//     const order = ordersByAwb.get(awb);
//     if (!order) continue;

//     const shipmentInfo = shipmentData as any;
//     const trackingDataObj = shipmentInfo?.tracking_data;
//     if (!trackingDataObj) continue;

//     const shipmentTrack = trackingDataObj.shipment_track;
//     if (!Array.isArray(shipmentTrack) || shipmentTrack.length === 0) continue;

//     const currentStatus = shipmentTrack[0]?.current_status;
//     if (!currentStatus) continue;

//     const newStatus = determineNewShiprocketStatus(currentStatus);
//     if (!newStatus) continue;
//     if (newStatus === order.customStatus) continue;

//     updates.push({
//       ref: order.ref,
//       data: {
//         customStatus: newStatus,
//         lastStatusUpdate: FieldValue.serverTimestamp(),
//         customStatusesLogs: FieldValue.arrayUnion({
//           status: newStatus,
//           createdAt: Timestamp.now(),
//           remarks: getStatusRemarks(newStatus),
//         }),
//       },
//     });
//   }

//   return updates;
// }

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

    const _360HrsInMs = 360 * 60 * 60 * 1000;
    const cutoffTime = new Date(Date.now() - _360HrsInMs);

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
        ordersToClose.docs.forEach((doc: QueryDocumentSnapshot) => {
          batch.update(doc.ref, {
            customStatus: "Closed",
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Closed",
              createdAt: Timestamp.now(),
              remarks: "This order Closed after approximately 15 days of being Delivered.",
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
      await db.runTransaction(async (tx: Transaction) => {
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

    const newStatus = determineNewDelhiveryStatus(shipment.Status);
    if (!newStatus) continue;
    if (newStatus === order.customStatus) continue;
    if (newStatus === "Closed/Cancelled Conditional") {
      if (order.customStatus === "DTO Booked") {
        updates.push({
          ref: order.ref,
          data: {
            customStatus: "Delivered",
            awb_reverse: FieldValue.delete(),
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Delivered",
              createdAt: Timestamp.now(),
              remarks: "This order was Cancelled on DTO, and was changed to 'Delivered' again.",
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
      if (order.customStatus === "Ready To Dispatch") {
        updates.push({
          ref: order.ref,
          data: {
            customStatus: "Confirmed",
            courier: FieldValue.delete(),
            awb: FieldValue.delete(),
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Confirmed",
              createdAt: Timestamp.now(),
              remarks:
                "This order was Cancelled on by Delhivery, and was changed to 'Confirmed' again.",
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
      continue;
    }

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

// // ============================================================================
// // AI CONFIGURATION - Using Vertex AI
// // ============================================================================
// const ai = genkit({
//   plugins: [
//     vertexAI({
//       projectId: process.env.GOOGLE_CLOUD_PROJECT ||
//                  process.env.GCLOUD_PROJECT ||
//                  process.env.GCP_PROJECT ||
//                  'orderflow-jnig7', // Fallback
//       location: 'asia-southeast1', // Singapore - closest to asia-south1
//     })
//   ],
//   model: 'vertexai/gemini-2.0-flash-exp',
// });

// // Cache for AI results to reduce API calls
// const addressCache = new Map<string, boolean>();

// // ============================================================================
// // CONFIGURATION
// // ============================================================================
// const GOOD_ADDRESS_KEYWORDS = [
//   'apartment', 'apt', 'suite', 'unit', 'floor', 'building', 'tower',
//   'block', 'flat', 'room', '#', 'house', 'street', 'road', 'avenue', 'nagar', 'chowk', 'shop'
// ];

// // ============================================================================
// // TYPES
// // ============================================================================
// interface OrderData {
//   customStatus: string;
//   tags_new?: string[];
//   raw: {
//     id: string | number;
//     total_price: string | number;
//     total_outstanding: string | number;
//     customer?: {
//       id?: string | number;
//       email?: string;
//       phone?: string;
//     };
//     shipping_address?: {
//       address1?: string;
//       address2?: string;
//     };
//     line_items?: Array<{
//       variant_id?: string | number;
//     }>;
//   };
// }

// interface GroupedOrders {
//   goodAddress: QueryDocumentSnapshot[];
//   badAddress: QueryDocumentSnapshot[];
// }

// // ============================================================================
// // MAIN SCHEDULED FUNCTION
// // ============================================================================
// export const processNewOrdersScheduled = onSchedule(
//   {
//     schedule: "0 0 * * *", // Daily at 12 AM IST
//     timeZone: "Asia/Kolkata",
//     region: process.env.LOCATION || "asia-south1",
//     memory: "1GiB",
//     timeoutSeconds: 540,
//     // No secrets needed - Vertex AI uses Application Default Credentials
//   },
//   async () => {
//     console.log("Starting processNewOrders job");

//     try {
//       // Process orders for each account
//       const accountsSnapshot = await db.collection("accounts").get();

//       for (const accountDoc of accountsSnapshot.docs) {
//         const accountId = accountDoc.id;
//         console.log(`Processing account: ${accountId}`);

//         try {
//           await processAccountOrders(accountId);
//         } catch (error) {
//           console.error(`Error processing account ${accountId}:`, error);
//           // Continue with other accounts
//         }
//       }

//       console.log("Job completed successfully");
//     } catch (error) {
//       console.error("processNewOrders job failed:", error);
//       throw error;
//     }
//   }
// );

// // ============================================================================
// // PROCESS ORDERS FOR A SINGLE ACCOUNT
// // ============================================================================
// async function processAccountOrders(accountId: string): Promise<void> {
//   // 1. Fetch eligible orders for this account
//   const eligibleOrders = await fetchEligibleOrders(accountId);

//   if (eligibleOrders.length === 0) {
//     console.log(`No eligible orders found for account ${accountId}`);
//     return;
//   }

//   console.log(`Found ${eligibleOrders.length} eligible orders for account ${accountId}`);

//   // 2. Split by address quality
//   const { goodAddress, badAddress } = await splitByAddressQuality(eligibleOrders);
//   console.log(`Account ${accountId} - Good addresses: ${goodAddress.length}, Bad addresses: ${badAddress.length}`);

//   // 3. Process good address orders
//   await processGoodAddressOrders(goodAddress, accountId);

//   // 4. Process bad address orders
//   await processBadAddressOrders(badAddress, accountId);
// }

// // ============================================================================
// // STEP 1: FETCH ELIGIBLE ORDERS
// // ============================================================================
// async function fetchEligibleOrders(accountId: string): Promise<QueryDocumentSnapshot[]> {
//   try {
//     const snapshot = await db
//       .collection("accounts")
//       .doc(accountId)
//       .collection("orders")
//       .where("customStatus", "==", "New")
//       .get();

//     // Filter for total_price == total_outstanding
//     const eligible = snapshot.docs.filter((doc: QueryDocumentSnapshot) => {
//       try {
//         const data = doc.data() as OrderData;
//         const totalPrice = parseFloat(String(data.raw?.total_price || 0));
//         const totalOutstanding = parseFloat(String(data.raw?.total_outstanding || 0));
//         return totalPrice === totalOutstanding && totalPrice > 0;
//       } catch (error) {
//         console.error(`Error parsing prices for order ${doc.id}:`, error);
//         return false;
//       }
//     });

//     return eligible;
//   } catch (error) {
//     console.error(`Error fetching orders for account ${accountId}:`, error);
//     throw new Error(`Failed to fetch orders: ${error}`);
//   }
// }

// // ============================================================================
// // STEP 2: SPLIT BY ADDRESS QUALITY (AI-POWERED)
// // ============================================================================
// async function splitByAddressQuality(orders: QueryDocumentSnapshot[]): Promise<GroupedOrders> {
//   const goodAddress: QueryDocumentSnapshot[] = [];
//   const badAddress: QueryDocumentSnapshot[] = [];

//   // Process addresses with some concurrency control
//   const BATCH_SIZE = 10; // Process 10 addresses at a time to avoid rate limits

//   for (let i = 0; i < orders.length; i += BATCH_SIZE) {
//     const batch = orders.slice(i, i + BATCH_SIZE);

//     await Promise.all(
//       batch.map(async (doc: QueryDocumentSnapshot) => {
//         try {
//           const data = doc.data() as OrderData;
//           const address1 = data.raw?.shipping_address?.address1?.toLowerCase() || "";
//           const address2 = data.raw?.shipping_address?.address2?.toLowerCase() || "";
//           const fullAddress = `${address1} ${address2}`.trim();

//           const isGood = await isGoodAddress(fullAddress);

//           if (isGood) {
//             goodAddress.push(doc);
//           } else {
//             badAddress.push(doc);
//           }
//         } catch (error) {
//           console.error(`Error evaluating address for order ${doc.id}:`, error);
//           badAddress.push(doc); // Default to bad address on error
//         }
//       })
//     );
//   }

//   return { goodAddress, badAddress };
// }

// // Helper function to get customer identifier
// function getCustomerIdentifier(data: OrderData): string {
//   // Try customer ID first (most reliable)
//   if (data.raw?.customer?.id) {
//     return `customer_${data.raw.customer.id}`;
//   }

//   // Fallback to email
//   if (data.raw?.customer?.email) {
//     return `email_${data.raw.customer.email.toLowerCase()}`;
//   }

//   // Fallback to phone (normalize it)
//   if (data.raw?.customer?.phone) {
//     const phone = data.raw.customer.phone.replace(/\D/g, ''); // Remove non-digits
//     return `phone_${phone}`;
//   }

//   // No customer info - treat each order as unique customer
//   return `unknown_${data.raw.id}`;
// }

// async function isGoodAddress(address: string): Promise<boolean> {
//   if (!address || address.length < 10) return false;

//   // Check cache first
//   if (addressCache.has(address)) {
//     return addressCache.get(address)!;
//   }

//   try {
//     // Use Vertex AI to evaluate address quality
//     const { text } = await ai.generate({
//       model: 'vertexai/gemini-2.0-flash-exp',
//       prompt: `You are an address quality evaluator for an e-commerce fulfillment system.

// Analyze this shipping address and determine if it's sufficiently detailed for delivery:

// Address: "${address}"

// A GOOD address should have:
// - Specific building/house number
// - Clear location identifiers (apartment, suite, floor, etc.)
// - Street/road name
// - Enough detail for a delivery person to find the location

// A BAD address is:
// - Vague or incomplete
// - Missing building/house numbers
// - Only has area/locality without specific location
// - Too short or generic

// Respond with ONLY one word: "GOOD" or "BAD"`,
//     });

//     const result = text.trim().toUpperCase();
//     const isGood = result === "GOOD";

//     // Cache the result
//     addressCache.set(address, isGood);

//     return isGood;
//   } catch (error) {
//     console.error(`AI address evaluation failed for "${address}":`, error);

//     // Fallback to keyword-based logic if AI fails
//     return fallbackAddressCheck(address);
//   }
// }

// // Fallback function if AI fails
// function fallbackAddressCheck(address: string): boolean {
//   if (!address || address.length < 10) return false;

//   // Check for good address indicators
//   const hasGoodKeyword = GOOD_ADDRESS_KEYWORDS.some((keyword) =>
//     address.includes(keyword.toLowerCase())
//   );

//   // Check for numbers (house/building numbers)
//   const hasNumbers = /\d/.test(address);

//   // Check minimum length and structure
//   const hasMinimumWords = address.split(/\s+/).length >= 3;

//   return hasGoodKeyword && hasNumbers && hasMinimumWords;
// }

// // ============================================================================
// // STEP 3: PROCESS GOOD ADDRESS ORDERS
// // ============================================================================
// async function processGoodAddressOrders(
//   orders: QueryDocumentSnapshot[],
//   accountId: string
// ): Promise<void> {
//   if (orders.length === 0) return;

//   console.log(`Processing ${orders.length} good address orders for account ${accountId}`);

//   try {
//     const groups = groupOrdersByVariantId(orders);
//     console.log(`Good address: Created ${groups.length} groups`);

//     for (const group of groups) {
//       try {
//         if (group.length === 1) {
//           // Single order: Confirm it
//           await updateOrderStatus(group[0], "Confirmed");
//           console.log(`Confirmed single order: ${group[0].id}`);
//         } else {
//           // Multiple orders: Keep latest, cancel rest
//           const sorted = sortByOrderId(group);
//           const latest = sorted[0];
//           const toCancel = sorted.slice(1);

//           await updateOrderStatus(latest, "Confirmed");
//           console.log(`Confirmed latest order: ${latest.id}`);

//           await cancelOrdersOnShopify(toCancel, accountId);
//         }
//       } catch (error) {
//         console.error(`Error processing good address group:`, error);
//       }
//     }
//   } catch (error) {
//     console.error("Error in processGoodAddressOrders:", error);
//     throw error;
//   }
// }

// // ============================================================================
// // STEP 4: PROCESS BAD ADDRESS ORDERS
// // ============================================================================
// async function processBadAddressOrders(
//   orders: QueryDocumentSnapshot[],
//   accountId: string
// ): Promise<void> {
//   if (orders.length === 0) return;

//   console.log(`Processing ${orders.length} bad address orders for account ${accountId}`);

//   try {
//     const groups = groupOrdersByVariantId(orders);
//     console.log(`Bad address: Created ${groups.length} groups`);

//     for (const group of groups) {
//       try {
//         if (group.length === 1) {
//           // Single order: Add L3 tag
//           await addTagToOrder(group[0], "L3");
//           console.log(`Added L3 tag to order: ${group[0].id}`);
//         } else {
//           // Multiple orders: Add L1 to latest, cancel rest
//           const sorted = sortByOrderId(group);
//           const latest = sorted[0];
//           const toCancel = sorted.slice(1);

//           await addTagToOrder(latest, "L1");
//           console.log(`Added L1 tag to order: ${latest.id}`);

//           await cancelOrdersOnShopify(toCancel, accountId);
//         }
//       } catch (error) {
//         console.error(`Error processing bad address group:`, error);
//       }
//     }
//   } catch (error) {
//     console.error("Error in processBadAddressOrders:", error);
//     throw error;
//   }
// }

// // ============================================================================
// // UTILITY: GROUP BY CUSTOMER, THEN BY VARIANT_ID (UNION-FIND)
// // ============================================================================
// function groupOrdersByVariantId(orders: QueryDocumentSnapshot[]): QueryDocumentSnapshot[][] {
//   if (orders.length === 0) return [];

//   // STEP 1: Group orders by customer first
//   const ordersByCustomer = new Map<string, QueryDocumentSnapshot[]>();

//   orders.forEach((doc: QueryDocumentSnapshot) => {
//     const data = doc.data() as OrderData;
//     const customerId = getCustomerIdentifier(data);

//     if (!ordersByCustomer.has(customerId)) {
//       ordersByCustomer.set(customerId, []);
//     }
//     ordersByCustomer.get(customerId)!.push(doc);
//   });

//   console.log(`Found ${ordersByCustomer.size} unique customers in ${orders.length} orders`);

//   // STEP 2: For each customer, group their orders by shared variants
//   const allGroups: QueryDocumentSnapshot[][] = [];

//   ordersByCustomer.forEach((customerOrders: QueryDocumentSnapshot[], customerId: string) => {
//     if (customerOrders.length === 1) {
//       // Single order for this customer - no grouping needed
//       allGroups.push(customerOrders);
//       return;
//     }

//     console.log(`Customer ${customerId} has ${customerOrders.length} orders - checking for duplicates`);

//     // Group this customer's orders by variant_id
//     const customerGroups = groupCustomerOrdersByVariants(customerOrders);
//     allGroups.push(...customerGroups);
//   });

//   return allGroups;
// }

// // Helper function to group a single customer's orders by shared variants
// function groupCustomerOrdersByVariants(orders: QueryDocumentSnapshot[]): QueryDocumentSnapshot[][] {
//   if (orders.length === 0) return [];
//   if (orders.length === 1) return [orders];

//   const variantToIndices = new Map<string, number[]>();

//   orders.forEach((doc: QueryDocumentSnapshot, idx: number) => {
//     try {
//       const data = doc.data() as OrderData;
//       const lineItems = data.raw?.line_items || [];

//       lineItems.forEach((item) => {
//         const variantId = item.variant_id;
//         if (variantId) {
//           const key = String(variantId);
//           if (!variantToIndices.has(key)) {
//             variantToIndices.set(key, []);
//           }
//           variantToIndices.get(key)!.push(idx);
//         }
//       });
//     } catch (error) {
//       console.error(`Error processing line items for order ${doc.id}:`, error);
//     }
//   });

//   // Union-Find to group orders with shared variants
//   const parent = Array.from({ length: orders.length }, (_: any, i: number) => i);

//   function find(x: number): number {
//     if (parent[x] !== x) {
//       parent[x] = find(parent[x]);
//     }
//     return parent[x];
//   }

//   function union(x: number, y: number): void {
//     const rootX = find(x);
//     const rootY = find(y);
//     if (rootX !== rootY) {
//       parent[rootY] = rootX;
//     }
//   }

//   variantToIndices.forEach((indices: number[]) => {
//     for (let i = 1; i < indices.length; i++) {
//       union(indices[0], indices[i]);
//     }
//   });

//   // Group by root
//   const groups = new Map<number, QueryDocumentSnapshot[]>();
//   orders.forEach((doc: QueryDocumentSnapshot, idx: number) => {
//     const root = find(idx);
//     if (!groups.has(root)) {
//       groups.set(root, []);
//     }
//     groups.get(root)!.push(doc);
//   });

//   return Array.from(groups.values());
// }

// // ============================================================================
// // UTILITY: SORT BY ORDER ID (LATEST FIRST)
// // ============================================================================
// function sortByOrderId(orders: QueryDocumentSnapshot[]): QueryDocumentSnapshot[] {
//   return [...orders].sort((a: QueryDocumentSnapshot, b: QueryDocumentSnapshot) => {
//     try {
//       const aId = (a.data() as OrderData).raw.id;
//       const bId = (b.data() as OrderData).raw.id;
//       return Number(bId) - Number(aId); // Descending (latest first)
//     } catch (error) {
//       console.error("Error sorting orders:", error);
//       return 0;
//     }
//   });
// }

// // ============================================================================
// // UTILITY: UPDATE ORDER STATUS
// // ============================================================================
// async function updateOrderStatus(
//   doc: QueryDocumentSnapshot,
//   newStatus: string
// ): Promise<void> {
//   try {
//     await doc.ref.update({
//       customStatus: newStatus,
//       lastStatusUpdate: FieldValue.serverTimestamp(),
//       customStatusesLogs: FieldValue.arrayUnion({
//         status: newStatus,
//         createdAt: Timestamp.now(),
//         remarks: `Status changed to ${newStatus} by automated grouping`,
//       }),
//     });
//   } catch (error) {
//     console.error(`Failed to update status for order ${doc.id}:`, error);
//     throw error;
//   }
// }

// // ============================================================================
// // UTILITY: ADD TAG TO ORDER
// // ============================================================================
// async function addTagToOrder(
//   doc: QueryDocumentSnapshot,
//   tag: string
// ): Promise<void> {
//   try {
//     const data = doc.data() as OrderData;
//     const existingTags = data.tags_new || [];

//     if (!existingTags.includes(tag)) {
//       await doc.ref.update({
//         tags_new: FieldValue.arrayUnion(tag),
//         lastTagUpdate: FieldValue.serverTimestamp(),
//       });
//     }
//   } catch (error) {
//     console.error(`Failed to add tag to order ${doc.id}:`, error);
//     throw error;
//   }
// }

// // ============================================================================
// // UTILITY: CANCEL ORDERS ON SHOPIFY
// // ============================================================================
// async function cancelOrdersOnShopify(
//   orders: QueryDocumentSnapshot[],
//   accountId: string
// ): Promise<void> {
//   if (orders.length === 0) return;

//   console.log(`Cancelling ${orders.length} orders on Shopify`);

//   try {
//     // Get account credentials once for all orders
//     const accountDoc = await db.collection("accounts").doc(accountId).get();

//     if (!accountDoc.exists) {
//       throw new Error(`Account ${accountId} not found`);
//     }

//     const accountData = accountDoc.data();
//     const accessToken = accountData?.accessToken;
//     const shop = accountId; // The accountId is typically the shop domain

//     if (!accessToken || !shop) {
//       throw new Error(`Shopify not configured for account ${accountId}`);
//     }

//     // Cancel each order
//     for (const doc of orders) {
//       try {
//         const data = doc.data() as OrderData;
//         const shopifyOrderId = data.raw.id;

//         // Cancel order via Shopify API using fetch
//         const response = await fetch(
//           `https://${shop}/admin/api/2024-10/orders/${shopifyOrderId}/cancel.json`,
//           {
//             method: 'POST',
//             headers: {
//               'X-Shopify-Access-Token': accessToken,
//               'Content-Type': 'application/json',
//             },
//             body: JSON.stringify({
//               reason: 'fraud',
//               email: false,
//               refund: false,
//             }),
//           }
//         );

//         if (!response.ok) {
//           const errorText = await response.text();
//           throw new Error(`Shopify API error ${response.status}: ${errorText}`);
//         }

//         // Update Firestore
//         await doc.ref.update({
//           customStatus: "Cancelled",
//           cancelledAt: FieldValue.serverTimestamp(),
//           cancelReason: "Duplicate order - automated cancellation",
//           lastStatusUpdate: FieldValue.serverTimestamp(),
//           customStatusesLogs: FieldValue.arrayUnion({
//             status: "Cancelled",
//             createdAt: Timestamp.now(),
//             remarks: "Duplicate order - automated cancellation",
//           }),
//         });

//         console.log(`Cancelled order ${doc.id} (Shopify ID: ${shopifyOrderId})`);
//       } catch (error) {
//         console.error(`Failed to cancel order ${doc.id}:`, error);
//         // Continue with other orders even if one fails
//       }
//     }
//   } catch (error) {
//     console.error(`Error getting account credentials for ${accountId}:`, error);
//     throw error;
//   }
// }
