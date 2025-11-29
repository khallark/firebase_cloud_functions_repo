// functions/src/index.ts
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/scheduler";
import type { Request, Response } from "express";
import fetch from "node-fetch";
import { db, storage } from "./firebaseAdmin";
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
import {
  DocumentReference,
  FieldValue,
  Filter,
  Timestamp,
  Transaction,
} from "firebase-admin/firestore";
// import { genkit } from 'genkit';
// import vertexAI from "@genkit-ai/vertexai";
import { onDocumentWritten, QueryDocumentSnapshot } from "firebase-functions/firestore";
import {
  sendConfirmedDelayedLvl1WhatsAppMessage,
  sendConfirmedDelayedLvl2WhatsAppMessage,
  sendConfirmedDelayedLvl3WhatsAppMessage,
  sendConfirmedDelayedOrdersPDFWhatsAppMessage,
  sendDeliveredOrderWhatsAppMessage,
  sendDispatchedOrderWhatsAppMessage,
  sendDTOBookedOrderWhatsAppMessage,
  sendDTODeliveredOrderWhatsAppMessage,
  sendDTOInTransitOrderWhatsAppMessage,
  sendInTransitOrderWhatsAppMessage,
  sendLostOrderWhatsAppMessage,
  sendOutForDeliveryOrderWhatsAppMessage,
  sendRTODeliveredOrderWhatsAppMessage,
  sendRTOInTransitOrderWhatsAppMessage,
  sendSharedStoreOrdersExcelWhatsAppMessage,
  sendSplitOrdersWhatsAppMessage,
} from "./whatsappMessagesSendingFuncs";
import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";

setGlobalOptions({ region: process.env.LOCATION || "asia-south1" });

const TASKS_SECRET = defineSecret("TASKS_SECRET");
const ENQUEUE_FUNCTION_SECRET = defineSecret("ENQUEUE_FUNCTION_SECRET");
const SHARED_STORE_ID = "nfkjgp-sv.myshopify.com";

/** Small helper to require a shared secret header */
function requireHeaderSecret(req: Request, header: string, expected: string) {
  const got = (req.get(header) || "").trim();
  if (!got || got !== (expected || "").trim()) throw new Error(`UNAUTH_${header}`);
}

/** For onTaskDispatched functions */
export function requireTaskHeaderSecret(
  req: Request, // ✅ Use TaskRequest type
  header: string,
  expected: string,
) {
  const headerValue = req.headers[header.toLowerCase()];
  const got = (headerValue || "").toString().trim();
  if (!got || got !== (expected || "").trim()) {
    throw new Error(`UNAUTH_${header}`);
  }
}

// // Add this helper function at the top with other helpers
// const cleanForFirestore = (obj: any): any => {
//   if (obj === null || obj === undefined) return null;
//   if (typeof obj !== "object") return obj;

//   if (Array.isArray(obj)) {
//     return obj.map(cleanForFirestore);
//   }

//   const cleaned: any = {};
//   for (const [key, value] of Object.entries(obj)) {
//     if (value !== undefined) {
//       cleaned[key] = cleanForFirestore(value);
//     }
//   }
//   return cleaned;
// };

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

const SUPER_ADMIN_ID = "vD8UJMLtHNefUfkMgbcF605SNAm2";

function BusinessIsAuthorisedToProcessThisOrder(
  businessId: string,
  vendorName: string,
  vendors: any,
) {
  try {
    if (businessId === SUPER_ADMIN_ID) {
      return {
        authorised: true,
      };
    }
    if (!vendorName) {
      return {
        authorised: false,
        error: "No vendorName provided",
        status: 400,
      };
    }
    if (!vendors || !Array.isArray(vendors) || !vendors.length) {
      return {
        authorised: false,
        error: "Invalid vendors array",
        status: 400,
      };
    }

    const isAuthorized =
      vendorName !== "OWR"
        ? vendors.includes(vendorName)
        : (vendors.includes(vendorName) ||
            vendors.includes("Ghamand") ||
            vendors.includes("BBB")) &&
          !vendors.includes("ENDORA") &&
          !vendors.includes("STYLE 05");

    if (!isAuthorized) {
      return {
        authorised: false,
        error: "Not authorised to process this order",
        status: 403,
      };
    }

    return {
      authorised: true,
    };
  } catch (error: any) {
    return {
      authorised: false,
      error: error?.message ?? "Unknown error occurred",
      status: 500,
    };
  }
}

async function handleJobFailure(params: {
  businessId: string;
  shop: string;
  batchRef: DocumentReference;
  jobRef: DocumentReference;
  jobId: string;
  errorCode: string;
  errorMessage: string;
  isRetryable: boolean;
  apiResp?: any;
}): Promise<{ shouldReturnFailure: boolean; statusCode: number; reason: string }> {
  const {
    businessId,
    shop,
    batchRef,
    jobRef,
    jobId,
    errorCode,
    errorMessage,
    isRetryable,
    apiResp,
  } = params;

  // FIX: Use transaction for atomic updates
  const result = await db.runTransaction(async (tx: Transaction) => {
    const jobSnap = await tx.get(jobRef);
    const batchSnap = await tx.get(batchRef);
    const jobData = jobSnap.data() || {};
    const batchData = batchSnap.data() || {};

    // FIX: Check if already in terminal state
    if (jobData.status === "success" || jobData.status === "failed") {
      return { alreadyTerminal: true };
    }

    const attempts = Number(jobData.attempts || 0);
    const maxAttempts = Number(process.env.SHIPMENT_QUEUE_MAX_ATTEMPTS || 3);
    const attemptsExhausted = attempts >= maxAttempts;
    const isPriority = batchData.courier === "Priority";

    const isExceptionError =
      errorCode === "INSUFFICIENT_BALANCE" ||
      errorCode === "ORDER_ALREADY_SHIPPED" ||
      errorCode === "NOT_AUTHORIZED_TO_PROCESS_THIS_ORDER" ||
      errorCode === "ORDER_NOT_FOUND" ||
      errorCode === "COURIER_SELECTION_FAILED";

    const shouldAttemptFallback =
      isPriority && (attemptsExhausted || !isRetryable) && !isExceptionError;
    const fallbackUrl = process.env.PRIORITY_FALLBACK_HANDLER_URL;

    if (shouldAttemptFallback && fallbackUrl) {
      tx.update(jobRef, {
        status: "attempting_fallback",
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage.slice(0, 400),
        lastFailedAt: FieldValue.serverTimestamp(),
        ...(apiResp && { lastApiResp: apiResp }),
      });
      tx.update(batchRef, {
        processing: FieldValue.increment(-1),
      });
      return { shouldAttemptFallback: true };
    }

    // Normal failure handling
    const updateData: any = {
      status: isRetryable ? (attemptsExhausted ? "failed" : "retrying") : "failed",
      errorCode: isRetryable ? "EXCEPTION" : errorCode,
      errorMessage: errorMessage.slice(0, 400),
    };
    if (apiResp) updateData.apiResp = apiResp;

    tx.set(jobRef, updateData, { merge: true });

    if (isRetryable && !attemptsExhausted) {
      tx.update(batchRef, { processing: FieldValue.increment(-1) });
    } else {
      tx.update(batchRef, {
        processing: FieldValue.increment(-1),
        failed: FieldValue.increment(1),
      });
    }

    return {
      shouldAttemptFallback: false,
      isRetryable,
      attemptsExhausted,
      isPermanent: !isRetryable || attemptsExhausted,
    };
  });

  // Handle transaction results
  if (result.alreadyTerminal) {
    return { shouldReturnFailure: false, statusCode: 200, reason: "already_terminal" };
  }

  if (result.shouldAttemptFallback) {
    try {
      const fallbackUrl = process.env.PRIORITY_FALLBACK_HANDLER_URL!;
      await createTask(
        { businessId, shop, batchId: batchRef.id, jobId },
        {
          tasksSecret: TASKS_SECRET.value() || "",
          url: fallbackUrl,
          queue: String(process.env.SHIPMENT_QUEUE_NAME) || "shipments-queue",
          delaySeconds: 2,
        },
      );
      return { shouldReturnFailure: false, statusCode: 200, reason: "fallback_queued" };
    } catch (fallbackError) {
      console.error("Failed to queue fallback:", fallbackError);
    }
  }

  if (result.isPermanent) {
    await maybeCompleteBatch(batchRef);
  }

  return {
    shouldReturnFailure: true,
    statusCode: result.isRetryable && !result.attemptsExhausted ? 503 : 200,
    reason: result.isRetryable ? "retryable_error" : "permanent_error",
  };
}

/**
 * Check if order has multiple vendors
 */
function hasMultipleVendors(lineItems: any[]): boolean {
  const vendors = new Set<string>();
  for (const item of lineItems) {
    const vendor = item.vendor || "default";
    vendors.add(vendor);
  }
  return vendors.size > 1;
}

/**
 * Group line items by vendor and calculate totals
 */
interface VendorGroup {
  vendor: string;
  lineItems: any[];
  subtotal: number;
  tax: number;
  total: number;
  totalWeight: number;
}

function groupLineItemsByVendor(lineItems: any[]): VendorGroup[] {
  const groupsMap = new Map<string, VendorGroup>();

  for (const item of lineItems) {
    const vendor = item.vendor || "default";

    if (!groupsMap.has(vendor)) {
      groupsMap.set(vendor, {
        vendor,
        lineItems: [],
        subtotal: 0,
        tax: 0,
        total: 0,
        totalWeight: 0,
      });
    }

    const group = groupsMap.get(vendor)!;
    group.lineItems.push(item);

    // Calculate subtotal
    const itemSubtotal = parseFloat(item.price) * item.quantity;
    group.subtotal += itemSubtotal;

    // Calculate tax
    const itemTax = (item.tax_lines || []).reduce((sum: number, taxLine: any) => {
      return sum + parseFloat(taxLine.price);
    }, 0);
    group.tax += itemTax;

    // Calculate weight
    group.totalWeight += (item.grams || 0) * item.quantity;
  }

  // Calculate totals
  for (const group of groupsMap.values()) {
    group.total = group.subtotal + group.tax;
  }

  return Array.from(groupsMap.values());
}

/**
 * Calculate proportional discount for a vendor group
 */
function calculateProportionalDiscount(
  originalSubtotal: number,
  originalDiscount: number,
  vendorSubtotal: number,
): number {
  if (originalDiscount === 0 || originalSubtotal === 0) return 0;

  const proportion = vendorSubtotal / originalSubtotal;
  const proportionalDiscount = originalDiscount * proportion;

  // Round to 2 decimals
  return Math.round(proportionalDiscount * 100) / 100;
}

/**
 * Mark batch as completed if all jobs are done
 */
async function maybeCompleteSplitBatch(batchRef: DocumentReference): Promise<void> {
  await db.runTransaction(async (tx: Transaction) => {
    const b = await tx.get(batchRef);
    const d = b.data() || {};
    const total = Number(d.totalJobs || 0);
    const success = Number(d.successJobs || 0);
    const failed = Number(d.failedJobs || 0);
    const processing = Number(d.processingJobs || 0);

    if (total && success + failed === total && processing === 0) {
      tx.update(batchRef, {
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}

/**
 * Handle job failure with retry logic
 */
async function handleSplitJobFailure(params: {
  batchRef: DocumentReference;
  jobRef: DocumentReference;
  jobId: string;
  errorCode: string;
  errorMessage: string;
  isRetryable: boolean;
}): Promise<{ shouldReturnFailure: boolean; statusCode: number }> {
  const { batchRef, jobRef, errorCode, errorMessage, isRetryable } = params;

  const result = await db.runTransaction(async (tx: Transaction) => {
    const jobSnap = await tx.get(jobRef);
    const jobData = jobSnap.data() || {};

    // Check if already in terminal state
    if (jobData.status === "success" || jobData.status === "failed") {
      return { alreadyTerminal: true };
    }

    const attempts = Number(jobData.attempts || 0);
    const maxAttempts = Number(process.env.ORDER_SPLIT_QUEUE_MAX_ATTEMPTS || 3);
    const attemptsExhausted = attempts >= maxAttempts;

    // Update job
    const updateData: any = {
      status: isRetryable ? (attemptsExhausted ? "failed" : "retrying") : "failed",
      errorCode: errorCode,
      errorMessage: errorMessage.slice(0, 400),
      lastFailedAt: FieldValue.serverTimestamp(),
    };

    tx.set(jobRef, updateData, { merge: true });

    // Update batch counters
    if (isRetryable && !attemptsExhausted) {
      tx.update(batchRef, { processingJobs: FieldValue.increment(-1) });
    } else {
      tx.update(batchRef, {
        processingJobs: FieldValue.increment(-1),
        failedJobs: FieldValue.increment(1),
      });
    }

    return {
      isRetryable,
      attemptsExhausted,
      isPermanent: !isRetryable || attemptsExhausted,
    };
  });

  if (result.alreadyTerminal) {
    return { shouldReturnFailure: false, statusCode: 200 };
  }

  if (result.isPermanent) {
    await maybeCompleteSplitBatch(batchRef);
  }

  return {
    shouldReturnFailure: true,
    statusCode: result.isRetryable && !result.attemptsExhausted ? 503 : 200,
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

      const { businessId, shop, orders, courier, pickupName, shippingMode, requestedBy } =
        (req.body || {}) as {
          businessId?: string;
          shop?: string;
          orders?: string;
          courier?: string;
          pickupName?: string;
          shippingMode?: string;
          requestedBy?: string;
        };

      if (
        !businessId ||
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

      const businessRef = await db.collection("users").doc(businessId).get();
      if (!businessRef.exists) {
        res.status(400).json({ error: "business_not_found" });
        return;
      }
      const businessDoc = businessRef.data();

      const priorityCourier =
        courier === "Priority"
          ? businessDoc?.integrations?.couriers?.priorityList?.[0]?.name.toLowerCase()
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
      const batchRef = businessRef.ref.collection("shipment_batches").doc();

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
          createTask(
            { businessId, shop, batchId, courier, jobId, pickupName, shippingMode } as any,
            {
              tasksSecret: TASKS_SECRET.value() || "",
              url,
              queue: String(process.env.SHIPMENT_QUEUE_NAME) || "shipments-queue",
            },
          ),
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

      // Carrier API key
      const businessDoc = await businessRef.get();

      // Cache data to avoid repeated lookups
      const batchData = (await batchRef.get()).data();
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

      // Allocate AWB
      awb = await allocateAwb(businessId);

      // Determine if this is a priority shipment
      const isPriority = batchData?.courier === "Priority";

      // Get shipping mode
      const payloadShippingMode = (() => {
        if (!isPriority) return shippingMode; // Use default shipping mode

        const priorityCouriers = businessData?.integrations?.couriers?.priorityList;
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

      const apiKey = businessDoc.data()?.integrations?.couriers?.delhivery?.apiKey as
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
            await releaseAwb(businessId, awb);
            awbReleased = true;
          } catch (e) {
            console.error("Failed to release AWB:", e);
          }
        }

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
      const verdict = evalDelhiveryResp(carrier);

      if (!verdict.ok) {
        if (awb && !awbReleased) {
          try {
            await releaseAwb(businessId, awb);
            awbReleased = true;
          } catch (e) {
            console.error("Failed to release AWB:", e);
          }
        }

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
            awb,
            courier: "Delhivery", // Change to "Shiprocket" or "Xpressbees" as appropriate
            courierProvider: "Delhivery",
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
        );
      });

      await maybeCompleteBatch(batchRef);

      res.json({ ok: true, awb, carrierShipmentId: verdict.carrierShipmentId ?? null });
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
        const verdict = evalShiprocketResp(orderCreateJson);

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
      const awbVerdict = evalShiprocketResp(awbJson);

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
      const verdict = evalXpressbeesResp(carrier);

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

/**
 * ENQUEUE: Called from webhook to create batch + jobs for order splitting
 *
 * CRITICAL: Cancels the original order BEFORE creating any jobs to prevent
 * race conditions where split orders are created but original isn't cancelled.
 */
export const enqueueOrderSplitBatch = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [ENQUEUE_FUNCTION_SECRET, TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { shop, orderId, requestedBy } = (req.body || {}) as {
        shop?: string;
        orderId?: string;
        requestedBy?: string;
      };

      if (!shop || !orderId || !requestedBy) {
        console.error("missing_shop_or_orderId");
        res.status(400).json({ error: "missing_shop_or_orderId" });
        return;
      }

      if (shop !== SHARED_STORE_ID) {
        console.error("invalid_shop_order_for_splitting");
        res.status(403).json({ error: "invalid_shop_order_for_splitting" });
        return;
      }

      console.log(`\n========== ORDER SPLIT ENQUEUE START ==========`);
      console.log(`Shop: ${shop} | Order: ${orderId}`);

      // Get order from Firestore
      const orderRef = db.collection("accounts").doc(shop).collection("orders").doc(orderId);
      const orderSnap = await orderRef.get();

      if (!orderSnap.exists) {
        console.error(`Order not found: ${orderId}`);
        res.status(404).json({ error: "order_not_found" });
        return;
      }

      const orderData = orderSnap.data()!;
      const originalOrder = orderData.raw;

      if (orderData.customStatus !== "New") {
        console.log("cannot_perform_splitting_on_any_status_but_new");
        res.status(403).json({ error: "cannot_perform_splitting_on_any_status_but_new" });
        return;
      }

      if (!originalOrder || !originalOrder.line_items) {
        console.error(`Invalid order data for: ${orderId}`);
        res.status(400).json({ error: "invalid_order_data" });
        return;
      }

      // Check if order needs splitting
      if (!hasMultipleVendors(originalOrder.line_items)) {
        console.log(`Order ${orderId} is single vendor - no split needed`);
        res.status(400).json({ error: "order_is_single_vendor" });
        return;
      }

      // Check if already being processed
      if (
        orderData.splitProcessing?.status === "processing" ||
        orderData.splitProcessing?.status === "completed"
      ) {
        console.log(`Order ${orderId} already processing or completed`);
        res.status(200).json({ message: "already_processing_or_completed" });
        return;
      }

      // Get account for API access
      const accountSnap = await db.collection("accounts").doc(shop).get();
      if (!accountSnap.exists) {
        console.error(`Account not found: ${shop}`);
        res.status(500).json({ error: "account_not_found" });
        return;
      }

      const accessToken = accountSnap.data()?.accessToken;
      if (!accessToken) {
        console.error(`Access token not found for: ${shop}`);
        res.status(500).json({ error: "access_token_missing" });
        return;
      }

      // ============================================
      // ✅ STEP 1: CANCEL ORDER FIRST (CRITICAL!)
      // ============================================
      console.log(`\n--- Cancelling original order ${orderId} ---`);
      const cancelUrl = `https://${shop}/admin/api/2025-01/orders/${orderId}/cancel.json`;

      try {
        const cancelResp = await fetch(cancelUrl, {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            reason: "other",
            email: false,
            restock: true,
          }),
        });

        if (!cancelResp.ok) {
          const errorText = await cancelResp.text();
          console.error(`❌ Cancel failed: ${cancelResp.status} - ${errorText}`);

          // Mark order as failed to split
          await orderRef.update({
            "splitProcessing.status": "failed",
            "splitProcessing.error": `Cancel failed: ${cancelResp.status} - ${errorText}`,
            "splitProcessing.failedAt": FieldValue.serverTimestamp(),
            "splitProcessing.cancelAttempted": true,
            "splitProcessing.cancelFailed": true,
          });

          res.status(500).json({
            error: "cancel_failed",
            details: errorText,
            statusCode: cancelResp.status,
            message: "Original order could not be cancelled. No split orders were created.",
          });
          return; // ← STOP HERE - Don't create batch or jobs
        }

        console.log(`✅ Original order cancelled successfully`);
      } catch (cancelError) {
        const errorMsg = cancelError instanceof Error ? cancelError.message : "Cancel failed";
        console.error(`❌ Cancel error:`, cancelError);

        await orderRef.update({
          "splitProcessing.status": "failed",
          "splitProcessing.error": errorMsg,
          "splitProcessing.failedAt": FieldValue.serverTimestamp(),
          "splitProcessing.cancelAttempted": true,
          "splitProcessing.cancelFailed": true,
        });

        res.status(500).json({
          error: "cancel_failed",
          details: errorMsg,
          message: "Original order could not be cancelled. No split orders were created.",
        });
        return; // ← STOP HERE
      }

      // ============================================
      // ✅ STEP 2: Cancel succeeded, create batch
      // ============================================
      console.log(`\n--- Creating batch and jobs ---`);

      const vendorGroups = groupLineItemsByVendor(originalOrder.line_items);
      console.log(`Found ${vendorGroups.length} vendor groups`);

      // Calculate total discount if any
      const originalTotalDiscount = parseFloat(originalOrder.total_discounts || "0");
      const originalSubtotal = parseFloat(originalOrder.subtotal_price || "0");
      const hasDiscount = originalTotalDiscount > 0;

      if (hasDiscount) {
        console.log(`\n💰 Original order has discount: ₹${originalTotalDiscount.toFixed(2)}`);
      }

      // Create batch
      const batchRef = db.collection("accounts").doc(shop).collection("order_split_batches").doc();

      const batchData = {
        requestedBy,
        originalOrderId: orderId,
        originalOrderName: originalOrder.name,
        originalFinancialStatus: originalOrder.financial_status,
        originalTotal: parseFloat(originalOrder.total_price || "0"),
        originalOutstanding: parseFloat(originalOrder.total_outstanding || "0"),
        originalGateway:
          originalOrder.gateway || originalOrder.payment_gateway_names?.[0] || "manual",
        status: "pending",
        totalJobs: vendorGroups.length,
        processingJobs: 0,
        successJobs: 0,
        failedJobs: 0,
        createdAt: FieldValue.serverTimestamp(),
        vendorCount: vendorGroups.length,
        originalCancelled: true, // ← Flag that original was cancelled
        cancelledAt: FieldValue.serverTimestamp(),
      };

      await batchRef.set(batchData);
      console.log(`✓ Created batch: ${batchRef.id}`);

      // Create jobs for each vendor
      const jobPromises = vendorGroups.map(async (group, index) => {
        const jobRef = batchRef.collection("jobs").doc();

        let proportionalDiscount = 0;

        if (hasDiscount) {
          if (index === vendorGroups.length - 1) {
            // LAST SPLIT: Gets remainder to ensure exact sum
            const sumOfPreviousDiscounts = vendorGroups.slice(0, index).reduce((sum, g) => {
              const d = calculateProportionalDiscount(
                originalSubtotal,
                originalTotalDiscount,
                g.subtotal,
              );
              return sum + d;
            }, 0);

            proportionalDiscount = originalTotalDiscount - sumOfPreviousDiscounts;
            console.log(
              `  💰 Last split gets remainder discount: ₹${proportionalDiscount.toFixed(2)}`,
            );
          } else {
            // FIRST/MIDDLE SPLITS: Calculate and round normally
            proportionalDiscount = calculateProportionalDiscount(
              originalSubtotal,
              originalTotalDiscount,
              group.subtotal,
            );
          }
        }

        const jobData = {
          vendorName: group.vendor,
          status: "pending",
          splitIndex: index + 1,
          totalSplits: vendorGroups.length,
          lineItems: group.lineItems,
          subtotal: group.subtotal,
          tax: group.tax,
          total: group.total,
          totalWeight: group.totalWeight,
          proportionalDiscount, // ← Now guaranteed to sum exactly
          attempts: 0,
          createdAt: FieldValue.serverTimestamp(),
        };
        await jobRef.set(jobData);
        console.log(
          `  ✓ Job ${index + 1}/${vendorGroups.length}: ${group.vendor} (₹${group.total.toFixed(2)}, discount: ₹${proportionalDiscount.toFixed(2)})`,
        );
        return jobRef.id;
      });

      const jobIds = await Promise.all(jobPromises);

      // Update order with batch reference
      await orderRef.update({
        "splitProcessing.status": "pending",
        "splitProcessing.batchId": batchRef.id,
        "splitProcessing.detectedAt": FieldValue.serverTimestamp(),
        "splitProcessing.vendorCount": vendorGroups.length,
        "splitProcessing.originalCancelled": true, // ← Confirm original was cancelled
        "splitProcessing.cancelledAt": FieldValue.serverTimestamp(),
      });

      // Enqueue tasks for each job
      console.log(`\n--- Queueing ${jobIds.length} tasks ---`);
      const workerUrl = process.env.ORDER_SPLIT_TARGET_URL || "";
      const queueName = process.env.ORDER_SPLIT_QUEUE_NAME || "order-splits-queue";

      if (!workerUrl) {
        throw new Error("ORDER_SPLIT_WORKER_URL not configured");
      }

      const taskPromises = jobIds.map((jobId) =>
        createTask(
          { shop, batchId: batchRef.id, jobId },
          {
            tasksSecret: TASKS_SECRET.value() || "",
            url: workerUrl,
            queue: queueName,
            delaySeconds: 0,
          },
        ),
      );

      await Promise.all(taskPromises);

      console.log(`✅ Enqueued ${jobIds.length} split jobs for order ${orderId}`);
      console.log(`========== ORDER SPLIT ENQUEUE COMPLETE ==========\n`);

      res.status(200).json({
        success: true,
        batchId: batchRef.id,
        jobCount: jobIds.length,
        jobIds,
        originalCancelled: true, // ← Confirm to caller
        message: `Original order cancelled and ${jobIds.length} split jobs queued`,
      });
    } catch (error) {
      console.error("\n========== ORDER SPLIT ENQUEUE ERROR ==========");
      console.error(error);
      const errorMsg = error instanceof Error ? error.message : "unknown_error";
      res.status(500).json({ error: "enqueue_failed", details: errorMsg });
    }
  },
);

/**
 * WORKER: Process individual split job
 *
 * NOTE: Original order cancellation is handled in enqueue function.
 * This worker only creates the split order and handles payment.
 */
export const processOrderSplitJob = onRequest(
  { timeoutSeconds: 300, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");

      const { shop, batchId, jobId } = (req.body || {}) as {
        shop?: string;
        batchId?: string;
        jobId?: string;
      };

      if (!shop || !batchId || !jobId) {
        console.log("missing_params");
        res.status(400).json({ error: "missing_params" });
        return;
      }

      console.log(`\n========== SPLIT JOB START ==========`);
      console.log(`Shop: ${shop} | Batch: ${batchId} | Job: ${jobId}`);

      const batchRef = db
        .collection("accounts")
        .doc(shop)
        .collection("order_split_batches")
        .doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(jobId);

      // Get batch and job data
      const [batchSnap, jobSnap] = await Promise.all([batchRef.get(), jobRef.get()]);

      if (!batchSnap.exists) {
        console.error(`Batch not found: ${batchId}`);
        res.status(404).json({ error: "batch_not_found" });
        return;
      }

      if (!jobSnap.exists) {
        console.error(`Job not found: ${jobId}`);
        res.status(404).json({ error: "job_not_found" });
        return;
      }

      const batchData = batchSnap.data()!;
      const jobData = jobSnap.data()!;

      // Check if already processed
      if (jobData.status === "success") {
        console.log(`Job already processed successfully`);
        res.status(200).json({ message: "already_processed" });
        return;
      }

      // Increment attempts and mark as processing
      await db.runTransaction(async (tx: Transaction) => {
        const j = await tx.get(jobRef);
        const jd = j.data() || {};
        if (jd.status === "success" || jd.status === "failed") return;

        tx.update(jobRef, {
          status: "processing",
          attempts: FieldValue.increment(1),
          lastAttemptAt: FieldValue.serverTimestamp(),
        });
        tx.update(batchRef, { processingJobs: FieldValue.increment(1) });
      });

      console.log(
        `Processing job ${jobData.splitIndex}/${jobData.totalSplits} for vendor: ${jobData.vendorName}`,
      );

      // Get original order
      const shopRef = db.collection("accounts").doc(shop);
      const originalOrderRef = shopRef.collection("orders").doc(batchData.originalOrderId);
      const originalOrderSnap = await originalOrderRef.get();

      if (!originalOrderSnap.exists) {
        console.error(`Original order not found: ${batchData.originalOrderId}`);
        await handleSplitJobFailure({
          batchRef,
          jobRef,
          jobId,
          errorCode: "ORIGINAL_ORDER_NOT_FOUND",
          errorMessage: "Original order not found in Firestore",
          isRetryable: false,
        });
        res.status(200).json({ error: "original_order_not_found" });
        return;
      }

      const originalOrderData = originalOrderSnap.data()!;
      const originalOrder = originalOrderData.raw;

      // Get account for API access
      const accountSnap = await db.collection("accounts").doc(shop).get();
      if (!accountSnap.exists) {
        console.error(`Account not found: ${shop}`);
        await handleSplitJobFailure({
          batchRef,
          jobRef,
          jobId,
          errorCode: "ACCOUNT_NOT_FOUND",
          errorMessage: "Account not found",
          isRetryable: false,
        });
        res.status(500).json({ error: "account_not_found" });
        return;
      }

      const accessToken = accountSnap.data()?.accessToken;
      if (!accessToken) {
        console.error(`Access token missing for: ${shop}`);
        await handleSplitJobFailure({
          batchRef,
          jobRef,
          jobId,
          errorCode: "ACCESS_TOKEN_MISSING",
          errorMessage: "Access token not found",
          isRetryable: false,
        });
        res.status(500).json({ error: "access_token_missing" });
        return;
      }

      // ============================================
      // NOTE: Original order already cancelled in enqueue function
      // No need to cancel here - just create split order
      // ============================================

      // Step 1: Create DRAFT order payload (instead of direct order)
      const includeShipping = jobData.splitIndex === 1;

      const lineItems = jobData.lineItems.map((item: any) => ({
        variant_id: item.variant_id,
        quantity: item.quantity,
        // Note: Draft orders use 'original_unit_price' instead of 'price'
        original_unit_price: item.price,
        properties: item.properties || [],
        taxable: item.taxable !== false,
        requires_shipping: item.requires_shipping !== false,
      }));

      const originalGateway = batchData.originalGateway;

      // Draft order payload structure
      const draftPayload: any = {
        draft_order: {
          line_items: lineItems,
          email: originalOrder.email,
          phone: originalOrder.phone,
          currency: originalOrder.currency,
          note: `Split ${jobData.splitIndex}/${jobData.totalSplits} from order ${batchData.originalOrderName} | Vendor: ${jobData.vendorName}`,
          note_attributes: [
            { name: "_original_order_id", value: String(batchData.originalOrderId) },
            { name: "_original_order_name", value: batchData.originalOrderName },
            { name: "_split_vendor", value: jobData.vendorName },
            { name: "_split_index", value: String(jobData.splitIndex) },
            { name: "_total_splits", value: String(jobData.totalSplits) },
            { name: "_original_financial_status", value: batchData.originalFinancialStatus },
            { name: "_original_payment_gateway", value: originalGateway },
            { name: "_proportional_discount", value: jobData.proportionalDiscount.toFixed(2) },
            { name: "_discount_applied", value: "true" },
          ],
          tags: `split-order,original-${batchData.originalOrderName},vendor-${jobData.vendorName}`,
          tax_exempt: originalOrder.tax_exempt || false,
          taxes_included: originalOrder.taxes_included || false,
          use_customer_default_address: false,
        },
      };

      // Add customer
      if (originalOrder.customer?.id) {
        draftPayload.draft_order.customer = { id: originalOrder.customer.id };
      }

      // Add addresses
      if (originalOrder.billing_address) {
        draftPayload.draft_order.billing_address = originalOrder.billing_address;
      }
      if (originalOrder.shipping_address) {
        draftPayload.draft_order.shipping_address = originalOrder.shipping_address;
      }

      // Add shipping lines (only first split)
      if (includeShipping && originalOrder.shipping_lines?.length > 0) {
        draftPayload.draft_order.shipping_line = {
          title: originalOrder.shipping_lines[0].title,
          price: originalOrder.shipping_lines[0].price,
          custom: true,
        };
      }

      // ✅ CRITICAL: Apply discount using Draft Order's applied_discount field
      if (jobData.proportionalDiscount > 0) {
        const discountTitle = originalOrder.discount_codes?.[0]?.code
          ? `Split discount (${originalOrder.discount_codes[0].code})`
          : `Split from ${batchData.originalOrderName}`;

        // Draft orders support applied_discount properly!
        draftPayload.draft_order.applied_discount = {
          description: `Proportional discount from split order`,
          value_type: "fixed_amount",
          value: jobData.proportionalDiscount.toFixed(2),
          title: discountTitle,
        };

        console.log(
          `💰 Applying proportional discount: ${discountTitle} - ₹${jobData.proportionalDiscount.toFixed(2)}`,
        );
      }

      // Step 2: Create DRAFT order
      console.log(`\n--- Creating DRAFT order for vendor: ${jobData.vendorName} ---`);
      const draftUrl = `https://${shop}/admin/api/2025-01/draft_orders.json`;

      let draftOrder: any;
      try {
        const draftResp = await fetch(draftUrl, {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(draftPayload),
        });

        if (!draftResp.ok) {
          const errorText = await draftResp.text();

          // Check for rate limit
          if (draftResp.status === 429) {
            console.error(`⚠ Shopify rate limit hit`);
            await handleSplitJobFailure({
              batchRef,
              jobRef,
              jobId,
              errorCode: "SHOPIFY_RATE_LIMIT",
              errorMessage: "Shopify API rate limit exceeded",
              isRetryable: true,
            });
            res.status(503).json({ error: "rate_limited" });
            return;
          }

          throw new Error(`Draft creation failed: ${draftResp.status} - ${errorText}`);
        }

        const result = (await draftResp.json()) as any;
        draftOrder = result.draft_order;
        console.log(`✓ Created draft order (ID: ${draftOrder.id})`);
        console.log(`  Subtotal: ₹${draftOrder.subtotal_price}`);
        console.log(`  Total Tax: ₹${draftOrder.total_tax}`);
        console.log(`  Total Price: ₹${draftOrder.total_price}`);

        // Verify discount was applied
        if (jobData.proportionalDiscount > 0) {
          const appliedDiscount = parseFloat(draftOrder.total_discounts || "0");
          console.log(`  Applied Discount: ₹${appliedDiscount.toFixed(2)}`);

          if (Math.abs(appliedDiscount - jobData.proportionalDiscount) > 0.01) {
            console.warn(
              `⚠ Discount mismatch! Expected: ₹${jobData.proportionalDiscount.toFixed(2)}, Got: ₹${appliedDiscount.toFixed(2)}`,
            );
          }
        }
      } catch (createError) {
        const errorMsg =
          createError instanceof Error ? createError.message : "Draft creation failed";
        console.error(`❌ Draft creation failed:`, createError);
        await handleSplitJobFailure({
          batchRef,
          jobRef,
          jobId,
          errorCode: "DRAFT_CREATE_FAILED",
          errorMessage: errorMsg,
          isRetryable: true,
        });
        res.status(500).json({ error: "draft_create_failed", details: errorMsg });
        return;
      }

      // Step 3: Complete the draft order to convert it to a regular order
      console.log(`\n--- Completing draft order ---`);
      const completeUrl = `https://${shop}/admin/api/2025-01/draft_orders/${draftOrder.id}/complete.json`;

      let newOrder: any;
      try {
        // Determine payment_pending based on original order's financial status
        const paymentPending = batchData.originalFinancialStatus !== "paid";

        const completeResp = await fetch(completeUrl, {
          method: "PUT",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            payment_pending: paymentPending, // false = mark as paid, true = mark as pending
          }),
        });

        if (!completeResp.ok) {
          const errorText = await completeResp.text();

          // Check for rate limit
          if (completeResp.status === 429) {
            console.error(`⚠ Shopify rate limit hit`);
            await handleSplitJobFailure({
              batchRef,
              jobRef,
              jobId,
              errorCode: "SHOPIFY_RATE_LIMIT",
              errorMessage: "Shopify API rate limit exceeded",
              isRetryable: true,
            });
            res.status(503).json({ error: "rate_limited" });
            return;
          }

          throw new Error(`Draft completion failed: ${completeResp.status} - ${errorText}`);
        }

        const result = (await completeResp.json()) as any;
        newOrder = result.draft_order;
        console.log(`✓ Completed draft order → Order ${newOrder.name} (ID: ${newOrder.order_id})`);
        console.log(`  Financial Status: ${newOrder.status}`);
        console.log(`  Total: ₹${newOrder.total_price}`);
        console.log(`  Discount: ₹${newOrder.total_discounts || "0.00"}`);

        const actualTotal = parseFloat(newOrder.total_price);
        const actualDiscount = parseFloat(newOrder.total_discounts || "0");

        console.log(`\n🔍 VERIFICATION:`);
        console.log(`  Expected total: ₹${jobData.total.toFixed(2)}`);
        console.log(`  Expected discount: ₹${jobData.proportionalDiscount.toFixed(2)}`);
        console.log(`  Shopify actual total: ₹${actualTotal.toFixed(2)}`);
        console.log(`  Shopify actual discount: ₹${actualDiscount.toFixed(2)}`);
        console.log(
          `  Difference: ₹${Math.abs(jobData.total - jobData.proportionalDiscount - actualTotal).toFixed(2)}`,
        );
      } catch (completeError) {
        const errorMsg =
          completeError instanceof Error ? completeError.message : "Draft completion failed";
        console.error(`❌ Draft completion failed:`, completeError);
        await handleSplitJobFailure({
          batchRef,
          jobRef,
          jobId,
          errorCode: "DRAFT_COMPLETE_FAILED",
          errorMessage: errorMsg,
          isRetryable: true,
        });
        res.status(500).json({ error: "draft_complete_failed", details: errorMsg });
        return;
      }

      // Get the actual order ID (draft_order.order_id is the real order ID after completion)
      const actualOrderId = newOrder.order_id;

      // Step 4: Handle payment based on original order status
      console.log(`\n--- Handling payment ---`);
      let splitPaidAmount = 0;
      let splitOutstanding = parseFloat(newOrder.total_price);
      const orderTotal = parseFloat(newOrder.total_price);

      if (batchData.originalFinancialStatus === "paid") {
        // ✅ FULLY PAID - Draft was completed with payment_pending: false
        // Shopify automatically creates a transaction, so we DON'T create another one
        console.log(`💰 Original fully paid - draft auto-marked as paid by Shopify`);
        splitPaidAmount = orderTotal;
        splitOutstanding = 0;
        console.log(`✓ Split marked as paid (₹${orderTotal.toFixed(2)})`);
      } else if (batchData.originalFinancialStatus === "partially_paid") {
        // PARTIALLY PAID - Distribute proportionally
        console.log(`⚖️ Original partially paid - distributing proportionally`);

        const originalPaid = batchData.originalTotal - batchData.originalOutstanding;
        const splitProportion = orderTotal / batchData.originalTotal;
        splitPaidAmount = originalPaid * splitProportion;
        splitOutstanding = orderTotal - splitPaidAmount;

        // Round to 2 decimals
        splitPaidAmount = Math.ceil(splitPaidAmount * 100) / 100;
        splitOutstanding = Math.ceil(splitOutstanding * 100) / 100;

        console.log(`📊 Proportion: ${(splitProportion * 100).toFixed(2)}%`);
        console.log(`💵 Paid: ₹${splitPaidAmount.toFixed(2)}`);
        console.log(`💰 Outstanding (COD): ₹${splitOutstanding.toFixed(2)}`);

        // Create partial transaction (draft was completed with payment_pending: true)
        if (splitPaidAmount > 0) {
          try {
            const txUrl = `https://${shop}/admin/api/2025-01/orders/${actualOrderId}/transactions.json`;
            const txResp = await fetch(txUrl, {
              method: "POST",
              headers: {
                "X-Shopify-Access-Token": accessToken,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                transaction: {
                  kind: "sale",
                  status: "success",
                  amount: splitPaidAmount.toFixed(2),
                  gateway: originalGateway,
                  source: "external",
                },
              }),
            });

            if (!txResp.ok) {
              const errorText = await txResp.text();
              console.error(`⚠ Failed to create partial transaction: ${errorText}`);
            } else {
              console.log(`✓ Partial payment recorded`);
            }
          } catch (txError) {
            console.error(`⚠ Partial transaction error:`, txError);
          }
        }
      } else {
        // PENDING/COD - Leave as pending (draft completed with payment_pending: true)
        console.log(`💵 Original unpaid/COD - split left as pending (₹${orderTotal.toFixed(2)})`);
        splitPaidAmount = 0;
        splitOutstanding = orderTotal;
      }

      // Step 5: Mark job as success
      const finalFinancialStatus =
        splitPaidAmount >= parseFloat(newOrder.total_price)
          ? "paid"
          : splitPaidAmount > 0
            ? "partially_paid"
            : "pending";

      await db.runTransaction(async (tx: Transaction) => {
        tx.update(jobRef, {
          status: "success",
          newOrderName: newOrder.name,
          product_name: newOrder?.line_items?.[0]?.name ?? "---",
          product_quantity: newOrder?.line_items?.[0]?.quantity ?? "---",
          draftOrderId: String(draftOrder.id),
          splitOrderId: String(actualOrderId),
          splitOrderName: newOrder.name,
          paidAmount: splitPaidAmount,
          outstandingAmount: splitOutstanding,
          financialStatus: finalFinancialStatus,
          actualTotal: parseFloat(newOrder.total_price),
          actualDiscount: parseFloat(newOrder.total_discounts || "0"),
          completedAt: FieldValue.serverTimestamp(),
        });

        tx.update(batchRef, {
          processingJobs: FieldValue.increment(-1),
          successJobs: FieldValue.increment(1),
        });
      });

      console.log(`✓ Job marked as success`);
      console.log(`  Order ID: ${actualOrderId}`);
      console.log(`  Order Name: ${newOrder.name}`);
      console.log(`  Financial Status: ${finalFinancialStatus}`);

      // Check if batch complete
      await maybeCompleteSplitBatch(batchRef);

      // If last job, update original order
      const allJobsSnap = await batchRef.collection("jobs").get();
      const allJobsSuccess = allJobsSnap.docs.every((doc) => doc.data().status === "success");

      if (allJobsSuccess) {
        console.log(`\n--- All jobs complete, updating original order ---`);

        const splitOrders = allJobsSnap.docs.map((doc) => ({
          orderId: doc.data().splitOrderId,
          orderName: doc.data().splitOrderName,
          vendor: doc.data().vendorName,
          total: doc.data().actualTotal,
          paidAmount: doc.data().paidAmount,
          outstandingAmount: doc.data().outstandingAmount,
          financialStatus: doc.data().financialStatus,
        }));

        // After all splits complete, verify total
        const totalOfAllSplits = splitOrders.reduce((sum, o) => sum + o.total, 0);
        console.log(`Original: ₹${batchData.originalTotal}, Splits: ₹${totalOfAllSplits}`);

        await originalOrderRef.update({
          "splitProcessing.status": "completed",
          "splitProcessing.completedAt": FieldValue.serverTimestamp(),
          "splitProcessing.splitOrders": splitOrders,
        });
        const shopDoc = (await shopRef.get()).data() as any;
        const oldOrder = originalOrderSnap.data() as any;
        const newOrders = allJobsSnap.docs.map((doc) => {
          const jobData = doc.data();
          return {
            name: jobData.newOrderName,
            product_name: jobData.product_name,
            quantity: jobData.product_quantity,
          };
        });
        await sendSplitOrdersWhatsAppMessage(shopDoc, oldOrder, newOrders);

        console.log(`✓ Original order updated with split results`);
      }

      console.log(`========== SPLIT JOB COMPLETE ==========\n`);

      res.status(200).json({
        success: true,
        splitOrderId: newOrder.id,
        splitOrderName: newOrder.name,
        vendor: jobData.vendorName,
        paidAmount: splitPaidAmount,
        outstandingAmount: splitOutstanding,
        total: parseFloat(newOrder.total_price),
      });
    } catch (error) {
      console.error("\n========== SPLIT JOB ERROR ==========");
      console.error(error);
      const errorMsg = error instanceof Error ? error.message : "unknown_error";
      res.status(500).json({ error: "job_failed", details: errorMsg });
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

  // FIX: Use transaction for atomic failure handling
  const result = await db.runTransaction(async (tx: Transaction) => {
    const job = await tx.get(jobRef);
    const jobData = job.data() || {};

    // Check if already in terminal state
    if (jobData.status === "success" || jobData.status === "failed") {
      return { alreadyTerminal: true, wasSuccess: jobData.status === "success" };
    }

    const attempts = Number(jobData.attempts || 0);
    const maxAttempts = Number(process.env.RETURN_SHIPMENT_QUEUE_MAX_ATTEMPTS || 3);
    const attemptsExhausted = attempts >= maxAttempts;

    const shouldFail = !isRetryable || attemptsExhausted;
    const newStatus = shouldFail ? "failed" : "retrying";

    const updateData: any = {
      status: newStatus,
      errorCode: isRetryable ? "EXCEPTION" : errorCode,
      errorMessage: errorMessage.slice(0, 400),
    };

    if (apiResp) {
      updateData.apiResp = apiResp;
    }

    // Update job atomically
    tx.set(jobRef, updateData, { merge: true });

    // Update batch counters atomically
    const batchUpdate: any = { processing: FieldValue.increment(-1) };
    if (shouldFail) {
      batchUpdate.failed = FieldValue.increment(1);
    }
    tx.update(batchRef, batchUpdate);

    return {
      alreadyTerminal: false,
      shouldFail,
      isRetryable,
      attemptsExhausted,
    };
  });

  // Handle already terminal case
  if (result.alreadyTerminal) {
    if (result.wasSuccess) {
      await maybeCompleteBatch(batchRef);
    }
    return {
      shouldReturnFailure: false,
      statusCode: 200,
      reason: "already_processed",
    };
  }

  // Complete batch if permanently failed
  if (result.shouldFail) {
    await maybeCompleteBatch(batchRef);
  }

  return {
    shouldReturnFailure: true,
    statusCode: result.isRetryable && !result.attemptsExhausted ? 503 : 200,
    reason: result.isRetryable && !result.attemptsExhausted ? "retryable_error" : "permanent_error",
  };
}

/* 
============================================================================
 RETURN SHIPMENT TASK ENQUEUER
============================================================================
*/
export const enqueueReturnShipmentTasks = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [ENQUEUE_FUNCTION_SECRET, TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { businessId, shop, orderIds, pickupName, shippingMode, requestedBy } = (req.body ||
        {}) as {
        businessId?: string;
        shop?: string;
        orderIds?: string[];
        pickupName?: string;
        shippingMode?: string;
        requestedBy?: string;
      };

      if (
        !businessId ||
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
      const batchRef = db
        .collection("users")
        .doc(businessId)
        .collection("book_return_batches")
        .doc();

      await batchRef.set({
        shop,
        pickupName,
        shippingMode,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: requestedBy || "system",
        total: orderIds.length,
        queued: orderIds.length,
        status: "queued",
        processing: 0,
        success: 0,
        failed: 0,
      });

      // Create job docs and enqueue tasks
      const writer = db.bulkWriter();
      const taskPromises: Promise<any>[] = [];

      const taskUrl = process.env.RETURN_TASK_TARGET_URL_1;
      if (!taskUrl) {
        throw new Error("RETURN_TASK_TARGET_URL_1 not configured");
      }

      for (const o of orderIds) {
        const orderData = orderDataMap.get(String(o))!;
        const courier = orderData.courier;
        const normalizedCourier = courier.split(":")[0].trim();

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

        // Queue Cloud Task
        taskPromises.push(
          createTask(
            {
              businessId,
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

      // Recalculate batch counters after task creation
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

      const { businessId, shop, orderIds, requestedBy } = (req.body || {}) as {
        businessId?: string;
        shop?: string;
        orderIds?: Array<string | number>;
        requestedBy?: string;
      };

      if (!businessId || !shop || !Array.isArray(orderIds) || orderIds.length === 0) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      // Validate account + token
      const businessRef = db.collection("users").doc(businessId);
      const businessDoc = await businessRef.get();
      if (!businessDoc.exists) {
        res.status(404).json({ error: "shop_not_found" });
        return;
      }
      const shopDoc = await db.collection("accounts").doc(shop).get();
      if (!shopDoc.exists) {
        res.status(404).json({ error: "shop_not_found" });
        return;
      }
      const accessToken = shopDoc.get("accessToken");
      if (!accessToken) {
        res.status(500).json({ error: "missing_access_token" });
        return;
      }

      // Create summary doc
      const summaryRef = businessRef.collection("orders_fulfillment_summary").doc();
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
              businessId,
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

/* Fulfill ONE Shopify order (handles on_hold/scheduled → open) */
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

  // If no FOs are visible, it's almost always a scope issue
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

  // 4) Group fulfillment orders by assigned location
  const fosByLocation = new Map<string, any[]>();

  for (const fo of fulfillableFOs) {
    const locationId = fo.assigned_location_id?.toString() || "unknown";
    if (!fosByLocation.has(locationId)) {
      fosByLocation.set(locationId, []);
    }
    fosByLocation.get(locationId)!.push(fo);
  }

  // 5) Create separate fulfillments for each location
  const fulfillmentIds: string[] = [];

  for (const [locationId, locationFOs] of fosByLocation.entries()) {
    const lineItemsByFO = locationFOs.map((fo: any) => ({
      fulfillment_order_id: fo.id,
      fulfillment_order_line_items: fo.line_items
        .filter((li: any) => li.fulfillable_quantity > 0) // Only unfulfilled items
        .map((li: any) => ({
          id: li.id,
          quantity: li.fulfillable_quantity,
        })),
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
            url:
              String(courier) === "Delhivery"
                ? `https://www.delhivery.com/track-v2/package/${awb}`
                : String(courier) === "Shiprocket"
                  ? `https://shiprocket.co/tracking/${awb}`
                  : `https://www.xpressbees.com/shipment/tracking?awbNo=${awb}`,
          },
          notify_customer: false,
        },
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`Fulfillment create failed for location ${locationId}:`, text);
      // Continue with other locations instead of throwing
      continue;
    }

    const json: any = await resp.json();
    console.log(`Fulfillment response for location ${locationId}:`, JSON.stringify(json)); // 👈 ADD THIS

    if (json?.fulfillment?.id) {
      fulfillmentIds.push(json.fulfillment.id);
    } else {
      console.error(`No fulfillment ID in response for location ${locationId}`, json); // 👈 ADD THIS
    }
  }

  // Return the first fulfillment ID (or undefined if all failed)
  return {
    fulfillmentId: fulfillmentIds[0],
    // You could also return all IDs if needed: fulfillmentIds
  };
}

/** Cloud Tasks → fulfills exactly ONE order and updates the summary */
export const processFulfillmentTask = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");
      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { businessId, shop, summaryId, jobId, orderId } = (req.body || {}) as {
        businessId?: string;
        shop?: string;
        summaryId?: string;
        jobId?: string;
        orderId?: string;
      };

      if (!businessId || !shop || !summaryId || !jobId || !orderId) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      const summaryRef = db
        .collection("users")
        .doc(businessId)
        .collection("orders_fulfillment_summary")
        .doc(summaryId);
      const jobRef = summaryRef.collection("jobs").doc(jobId);

      // ✅ Get job first to see if we need cleanup
      const jobSnap = await jobRef.get();

      if (!jobSnap.exists) {
        // Idempotency: job was deleted or never created
        res.json({ noop: true });
        return;
      }

      const job = jobSnap.data()!;

      if (job.status === "success") {
        res.json({ alreadyDone: true });
        return;
      }

      function httpRetryable(status: number): boolean {
        return status === 408 || status === 429 || (status >= 500 && status <= 599);
      }

      // ✅ Helper function to mark job as failed and update summary
      const markJobFailed = async (errorCode: string, errorMessage: string) => {
        await Promise.all([
          jobRef.set(
            {
              status: "failed",
              errorCode,
              errorMessage: errorMessage.slice(0, 400),
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
      };

      // ✅ Now wrap all validation in try-catch
      try {
        const shopRef = db.collection("accounts").doc(shop);
        const orderRef = shopRef.collection("orders").doc(String(jobId));

        const shopDoc = await shopRef.get();
        if (!shopDoc.exists) {
          await markJobFailed("shop_not_found", `Shop ${shop} not found`);
          res.status(404).json({ error: "shop_not_found" });
          return;
        }

        const shopData = shopDoc.data() as any;

        const businessDoc = await db.collection("users").doc(businessId).get();
        if (!businessDoc.exists) {
          await markJobFailed("business_not_found", `Business ${businessId} not found`);
          res.status(404).json({ error: "business_not_found" });
          return;
        }

        const order = await orderRef.get();
        if (!order.exists) {
          await markJobFailed("order_not_found", `Order ${orderId} not found`);
          res.status(404).json({ error: "order_not_found" });
          return;
        }

        const orderData = order.data() as any;

        // ✅ NEW: Check if order is already fulfilled
        const fulfillmentStatus =
          orderData?.raw?.fulfillment_status || orderData?.fulfillmentStatus;
        if (fulfillmentStatus === "fulfilled" || fulfillmentStatus === "partial") {
          // Order already fulfilled - mark job as success with nothingToDo flag
          await Promise.all([
            jobRef.set(
              {
                status: "success",
                fulfillmentId: null,
                nothingToDo: true,
                skipReason: "already_fulfilled",
                errorCode: FieldValue.delete(),
                errorMessage: FieldValue.delete(),
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true },
            ),
            summaryRef.update({
              success: FieldValue.increment(1),
            }),
            orderRef.set(
              {
                customStatus: "Dispatched",
                lastStatusUpdate: FieldValue.serverTimestamp(),
                customStatusesLogs: FieldValue.arrayUnion({
                  status: "Dispatched",
                  createdAt: Timestamp.now(),
                  remarks: `The order's shipment was dispatched from the warehouse.`,
                }),
              },
              { merge: true },
            ),
          ]);

          await maybeCompleteSummary(summaryRef);

          res.json({
            ok: true,
            alreadyFulfilled: true,
            message: "Order already fulfilled on Shopify",
          });
          return;
        }

        // Check if the shop is exceptional one
        if (shop === SHARED_STORE_ID) {
          const businessData = businessDoc.data();
          const vendorName = businessData?.vendorName;
          const vendors = orderData?.vendors;
          const canProcess = BusinessIsAuthorisedToProcessThisOrder(
            businessId,
            vendorName,
            vendors,
          );
          if (!canProcess.authorised) {
            await markJobFailed("not_authorized", `Business not authorized to process this order`);
            res.status(403).json({ error: "not_authorized_to_process" });
            return;
          }
        }

        const accessToken = shopDoc.get("accessToken");
        if (!accessToken) {
          await markJobFailed("missing_access_token", `Access token missing for shop ${shop}`);
          res.status(500).json({ error: "missing_access_token" });
          return;
        }

        let awb = order.get("awb") || "";
        let courier = order.get("courierProvider") || "";

        const MAX_ATTEMPTS = Number(process.env.FULFILLMENT_QUEUE_MAX_ATTEMPTS || 3);

        // ✅ Mark processing + attempt++
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

        // ✅ Try fulfillment
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
                  remarks: `The order's shipment was dispatched from the warehouse.`,
                }),
              },
              { merge: true },
            ),
          ]);

          await maybeCompleteSummary(summaryRef);
          await sendDispatchedOrderWhatsAppMessage(shopData, orderData);

          res.json({ ok: true });
          return;
        } catch (err: any) {
          // ✅ Fulfillment failure handling
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
      } catch (validationError: any) {
        // ✅ Catch any unexpected validation errors
        console.error("Validation error:", validationError);
        await markJobFailed("validation_error", validationError.message || "Validation failed");
        res.status(500).json({ error: "validation_failed", details: validationError.message });
        return;
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
    LOST: { LT: "Lost" },
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

async function queueNextChunk(tasksSecret: string, targetUrl: string, params: any): Promise<void> {
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
// CONFIGURATION
// ============================================================================
const CHUNK_SIZE = 200; // Orders processed per scheduled task
const MANUAL_CHUNK_SIZE = 100; // Order IDs processed per manual task
const API_BATCH_SIZE = 50; // Orders per Delhivery API call

// CHUNK PROCESSOR - Fetches and processes one page of orders
interface ChunkResult {
  processed: number;
  updated: number;
  hasMore: boolean;
  nextCursor?: string;
}

// API PROCESSOR - Calls Delhivery and prepares updates
interface OrderUpdate {
  ref: DocumentReference;
  data: any;
}

// Status-wise message sending functions
const messageActionFor = new Map<string, any>([
  ["In Transit", sendInTransitOrderWhatsAppMessage],
  ["Out For Delivery", sendOutForDeliveryOrderWhatsAppMessage],
  ["Delivered", sendDeliveredOrderWhatsAppMessage],
  ["RTO In Transit", sendRTOInTransitOrderWhatsAppMessage],
  ["RTO Delivered", sendRTODeliveredOrderWhatsAppMessage],
  ["DTO In Transit", sendDTOInTransitOrderWhatsAppMessage],
  ["DTO Delivered", sendDTODeliveredOrderWhatsAppMessage],
  ["Lost", sendLostOrderWhatsAppMessage],
]);

// Function to handle message sending
async function sendStatusChangeMessages(updates: OrderUpdate[], shop: any): Promise<void> {
  const messagePromises = updates.map(async (update) => {
    try {
      const newStatus = update.data.customStatus;

      if (!shop) {
        console.warn(`Shop data not found for order ${update.ref.id}, skipping message.`);
        return;
      }

      // Check if this status has a message function
      const messageFn = messageActionFor.get(newStatus);
      if (!messageFn) {
        return; // No message configured for this status
      }

      // Get the full order data (we need this for the message)
      const orderDoc = await update.ref.get();
      if (!orderDoc.exists) return;

      const order = orderDoc.data() as any;

      // Send the message
      await messageFn(shop, order);

      console.log(`Sent ${newStatus} message for order ${orderDoc.id}`);
    } catch (error) {
      // Log but don't fail the whole process if message sending fails
      console.error(`Failed to send message for order ${update.ref.id}:`, error);
    }
  });

  // Send all messages in parallel, but don't block on failures
  await Promise.allSettled(messagePromises);
}

async function hasActiveShipments(stores: string[]): Promise<boolean> {
  for (const store of stores) {
    const snapshot = await db
      .collection("accounts")
      .doc(store)
      .collection("orders")
      .where("customStatus", "in", [
        "Dispatched",
        "In Transit",
        "Out For Delivery",
        "RTO In Transit",
      ])
      .limit(1)
      .get();

    if (!snapshot.empty) return true;
  }
  return false;
}

interface BusinessData {
  stores: string[];
}

/*
============================================================================
SCHEDULED DELHIVERY STATUS UPDATES
============================================================================
*/

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
      console.log("Looking for active businesses, so that redundant updates can be avoided...");
      // Get all the Business (User) docs
      const businessesSnapshot = await db.collection("users").get();

      if (businessesSnapshot.empty) {
        console.log("No users with business found");
        return;
      }

      // Only process businesses that have orders in active shipping states
      const activeBusinesses = [];
      for (const doc of businessesSnapshot.docs) {
        const data = doc.data() as BusinessData;
        if (data.stores?.length && (await hasActiveShipments(data.stores))) {
          activeBusinesses.push(doc);
        }
      }

      console.log(`Found ${activeBusinesses.length} businesses`);
      console.log(
        "Creating the individual batches of the shops, which are within these active businesses...",
      );

      let allShopIds = new Set<{ accountId: string; businessId: string }>();
      activeBusinesses.forEach((doc) => {
        if (!doc.id) {
          console.error("⚠️ Found document without ID in activeBusinesses:", doc.ref.path);
          return; // Skip this document
        }

        const data = doc.data() as BusinessData;
        data.stores.forEach((acc) => {
          if (!acc) {
            console.error(`⚠️ Found undefined store in business ${doc.id}`);
            return;
          }

          if (acc === SHARED_STORE_ID) {
            if (doc.id === SUPER_ADMIN_ID) {
              allShopIds.add({ accountId: acc, businessId: doc.id });
            }
          } else {
            allShopIds.add({ accountId: acc, businessId: doc.id });
          }
        });
      });

      console.log(`Found ${allShopIds.size} shops to process.`);
      console.log("Proceeding to create a batch and enqueueing all the shops as batch's jobs");

      // Create batch header
      const batchRef = db.collection("status_update_batches").doc();
      const batchId = batchRef.id;

      await batchRef.set({
        createdAt: FieldValue.serverTimestamp(),
        createdBy: "system-scheduled",
        queued: allShopIds.size,
        status: "running",
        processing: 0,
        success: 0,
        failed: 0,
        type: "status_update",
        schedule: "6x_daily",
        courier: "Delhivery",
      });

      // Create job documents (one per account)
      const writer = db.bulkWriter();
      for (const { accountId, businessId } of allShopIds) {
        writer.set(
          batchRef.collection("jobs").doc(accountId),
          {
            accountId,
            businessId,
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
      const taskPromises = Array.from(allShopIds).map(({ accountId, businessId }, index) =>
        createTask(
          {
            accountId,
            businessId,
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

      console.log(`Enqueued ${allShopIds.size} initial tasks for batch ${batchId}`);
    } catch (error) {
      console.error("enqueueStatusUpdateTasks failed:", error);
      throw error;
    }
  },
);

/* 2. MAIN TASK HANDLER - Processes one chunk and queues next if needed */
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
        businessId,
        batchId,
        jobId,
        cursor = null,
        chunkIndex = 0,
      } = req.body as {
        accountId?: string;
        businessId?: string;
        batchId?: string;
        jobId?: string;
        cursor?: string | null;
        chunkIndex?: number;
      };

      if (!accountId || !businessId || !batchId || !jobId) {
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
              businessId,
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
      const businessDoc = await db.collection("users").doc(businessId).get();
      if (!businessDoc.exists) throw new Error("ACCOUNT_NOT_FOUND");

      const apiKey = businessDoc.data()?.integrations?.couriers?.delhivery?.apiKey;
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
        await queueNextChunk(
          TASKS_SECRET.value() || "",
          process.env.UPDATE_STATUS_TASK_JOB_TARGET_URL!,
          {
            accountId,
            businessId,
            batchId,
            jobId,
            chunkIndex: chunkIndex + 1,
            cursor: result.nextCursor,
          },
        );

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
    "DTO Delivered",
    "Cancellation Requested",
    "Pending Refunds",
    "DTO Refunded",
  ]);

  const shopRef = db.collection("accounts").doc(accountId);

  const shopDoc = await shopRef.get();
  const shopData = (shopDoc.data() as any) || null;

  // Build paginated query with OR condition for both courier and courier_reverse
  let query = db
    .collection("accounts")
    .doc(accountId)
    .collection("orders")
    .where(
      Filter.or(
        Filter.where("courier", "==", "Delhivery"),
        Filter.where("courier_reverse", "==", "Delhivery"),
      ),
    )
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
    .filter((order: any) => {
      // Check courier conditions: (courier == Delhivery AND no courier_reverse) OR (courier_reverse == Delhivery)
      const hasDelhiveryCourier = order.courier === "Delhivery";
      const hasNoCourierReverse = !order.courier_reverse;
      const hasDelhiveryCourierReverse = order.courier_reverse === "Delhivery";

      const meetsCourierCondition =
        (hasDelhiveryCourier && hasNoCourierReverse) || hasDelhiveryCourierReverse;

      // Check status condition
      const meetsStatusCondition =
        order.awb && order.customStatus && !excludedStatuses.has(order.customStatus);

      return meetsCourierCondition && meetsStatusCondition;
    });

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

      // ✅ ADD MESSAGE SENDING HERE - After successful commit
      await sendStatusChangeMessages(updates, shopData);
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

// ============================================================================
// SHARED UTILITIES - Used by both scheduled and manual updates
// ============================================================================
function determineNewShiprocketStatus(currentStatus: string): string | null {
  const statusMap: Record<string, string> = {
    "In Transit": "In Transit",
    "In Transit-EN-ROUTE": "In Transit",
    "Out for Delivery": "Out For Delivery",
    Delivered: "Delivered",
    "RTO IN INTRANSIT": "RTO In Transit",
    "RTO Delivered": "RTO Delivered",
  };
  return statusMap[currentStatus] || null;
}

/*
============================================================================
SCHEDULED SHIPROCKET STATUS UPDATES
============================================================================
*/

// 1. SCHEDULER - Enqueues initial tasks (one per account)
export const enqueueShiprocketStatusUpdateTasksScheduled = onSchedule(
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
      console.log("Looking for active businesses, so that redundant updates can be avoided...");
      // Get all the Business (User) docs
      const businessesSnapshot = await db.collection("users").get();

      if (businessesSnapshot.empty) {
        console.log("No users with business found");
        return;
      }

      // Only process businesses that have orders in active shipping states
      const activeBusinesses = [];
      for (const doc of businessesSnapshot.docs) {
        const data = doc.data() as BusinessData;
        if (data.stores?.length && (await hasActiveShipments(data.stores))) {
          activeBusinesses.push(doc);
        }
      }

      console.log(`Found ${activeBusinesses.length} businesses`);
      console.log(
        "Creating the individual batches of the shops, which are within these active businesses...",
      );

      let allShopIds = new Set<{ accountId: string; businessId: string }>();
      activeBusinesses.forEach((doc) => {
        if (!doc.id) {
          console.error("⚠️ Found document without ID in activeBusinesses:", doc.ref.path);
          return; // Skip this document
        }

        const data = doc.data() as BusinessData;
        data.stores.forEach((acc) => {
          if (!acc) {
            console.error(`⚠️ Found undefined store in business ${doc.id}`);
            return;
          }

          if (acc === SHARED_STORE_ID) {
            if (doc.id === SUPER_ADMIN_ID) {
              allShopIds.add({ accountId: acc, businessId: doc.id });
            }
          } else {
            allShopIds.add({ accountId: acc, businessId: doc.id });
          }
        });
      });

      console.log(`Found ${allShopIds.size} shops to process.`);
      console.log("Proceeding to create a batch and enqueueing all the shops as batch's jobs");

      // Create batch header
      const batchRef = db.collection("status_update_batches").doc();
      const batchId = batchRef.id;

      await batchRef.set({
        createdAt: FieldValue.serverTimestamp(),
        createdBy: "system-scheduled",
        queued: allShopIds.size,
        status: "running",
        processing: 0,
        success: 0,
        failed: 0,
        type: "status_update",
        schedule: "6x_daily",
        courier: "Shiprocket",
      });

      // Create job documents (one per account)
      const writer = db.bulkWriter();
      for (const { accountId, businessId } of allShopIds) {
        writer.set(
          batchRef.collection("jobs").doc(accountId),
          {
            accountId,
            businessId,
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

      const targetUrl = process.env.UPDATE_STATUS_TASK_JOB_TARGET_URL_SHIPROCKET;
      if (!targetUrl) {
        throw new Error("UPDATE_STATUS_TASK_TARGET_URL not configured");
      }

      // Create initial tasks (chunk 0 for each account)
      const taskPromises = Array.from(allShopIds).map(({ accountId, businessId }, index) =>
        createTask(
          {
            accountId,
            businessId,
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

      console.log(`Enqueued ${allShopIds.size} initial tasks for batch ${batchId}`);
    } catch (error) {
      console.error("enqueueStatusUpdateTasks failed:", error);
      throw error;
    }
  },
);

// 2. MAIN TASK HANDLER - Processes one chunk and queues next if needed
export const updateShiprocketStatusesJob = onRequest(
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
        businessId,
        batchId,
        jobId,
        cursor = null,
        chunkIndex = 0,
      } = req.body as {
        accountId?: string;
        businessId?: string;
        batchId?: string;
        jobId?: string;
        cursor?: string | null;
        chunkIndex?: number;
      };

      if (!accountId || !businessId || !batchId || !jobId) {
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
              businessId,
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
      const businessDoc = await db.collection("users").doc(businessId).get();
      if (!businessDoc.exists) throw new Error("ACCOUNT_NOT_FOUND");

      const apiKey = businessDoc.data()?.integrations?.couriers?.shiprocket?.apiKey;
      if (!apiKey) throw new Error("API_KEY_MISSING");

      // Process one chunk of orders
      const result = await processShiprocketOrderChunk(accountId, apiKey, cursor);

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
        await queueNextChunk(
          TASKS_SECRET.value() || "",
          process.env.UPDATE_STATUS_TASK_JOB_TARGET_URL_SHIPROCKET!,
          {
            accountId,
            businessId,
            batchId,
            jobId,
            chunkIndex: chunkIndex + 1,
            cursor: result.nextCursor,
          },
        );

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

async function processShiprocketOrderChunk(
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
    "DTO Delivered",
    "Cancellation Requested",
    "Pending Refunds",
    "DTO Refunded",
  ]);

  const shopRef = db.collection("accounts").doc(accountId);

  const shopDoc = await shopRef.get();
  const shopData = (shopDoc.data() as any) || null;

  // Build paginated query with OR condition for both courierProvider and courierReverseProvider
  let query = db
    .collection("accounts")
    .doc(accountId)
    .collection("orders")
    .where(
      Filter.or(
        Filter.where("courierProvider", "==", "Shiprocket"),
        Filter.where("courierReverseProvider", "==", "Shiprocket"),
      ),
    )
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
    .filter((order: any) => {
      // Check courier conditions: (courierProvider is Shiprocket AND no courierReverseProvider) OR (courierReverseProvider is Shiprocket)
      const hasShiprocketCourier = order.courierProvider === "Shiprocket";
      const hasNoCourierReverse = !order.courierReverseProvider;
      const hasShiprocketCourierReverse = order.courierReverseProvider === "Shiprocket";

      const meetsCourierCondition =
        (hasShiprocketCourier && hasNoCourierReverse) || hasShiprocketCourierReverse;

      // Check status condition
      const meetsStatusCondition =
        order.awb && order.customStatus && !excludedStatuses.has(order.customStatus);

      return meetsCourierCondition && meetsStatusCondition;
    });

  if (eligibleOrders.length === 0) {
    const lastDoc = snapshot.docs[snapshot.docs.length - 1];
    return {
      processed: snapshot.size,
      updated: 0,
      hasMore: snapshot.size === CHUNK_SIZE,
      nextCursor: lastDoc.id,
    };
  }

  console.log(
    `Processing ${eligibleOrders.length} eligible Shiprocket orders for account ${accountId}`,
  );

  // Process in API batches
  let totalUpdated = 0;

  for (let i = 0; i < eligibleOrders.length; i += API_BATCH_SIZE) {
    const batch = eligibleOrders.slice(i, Math.min(i + API_BATCH_SIZE, eligibleOrders.length));
    const updates = await fetchAndProcessShiprocketBatch(batch, apiKey);

    // Apply updates using Firestore batch writes
    if (updates.length > 0) {
      const writeBatch = db.batch();
      updates.forEach((update) => {
        writeBatch.update(update.ref, update.data);
      });
      await writeBatch.commit();
      totalUpdated += updates.length;
      console.log(`Updated ${updates.length} orders in API batch ${i / API_BATCH_SIZE + 1}`);

      // ✅ ADD MESSAGE SENDING HERE - After successful commit
      await sendStatusChangeMessages(updates, shopData);
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

async function fetchAndProcessShiprocketBatch(
  orders: any[],
  apiKey: string,
): Promise<OrderUpdate[]> {
  // Select correct AWB based on whether it's a DTO (customer return) order
  const awbs = orders
    .map((order) => (order.customStatus?.includes("DTO") ? order.awb_reverse : order.awb))
    .filter(Boolean);

  if (awbs.length === 0) return [];

  try {
    const trackingUrl = "https://apiv2.shiprocket.in/v1/external/courier/track/awbs";
    const response = await fetch(trackingUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ awbs }),
    });

    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) {
        throw new Error(`HTTP_${response.status}`);
      }
      console.error(`Shiprocket API error: ${response.status}`);
      return [];
    }

    const trackingData = (await response.json()) as any;

    const fieldCount = Object.keys(trackingData).length;
    console.log(fieldCount);

    return prepareShiprocketOrderUpdates(orders, trackingData);
  } catch (error: any) {
    console.error("Batch processing error:", error);
    if (error.message.startsWith("HTTP_")) {
      throw error;
    }
    return [];
  }
}

// 5. UPDATE PREPARATION - Maps API responses to Firestore updates
function prepareShiprocketOrderUpdates(orders: any[], trackingData: any): OrderUpdate[] {
  const updates: OrderUpdate[] = [];

  // Create map with correct AWB (reverse for DTO orders, regular otherwise)
  const ordersByAwb = new Map(
    orders.map((o) => {
      const awb = o.customStatus?.includes("DTO") ? o.awb_reverse : o.awb;
      return [awb, o];
    }),
  );

  for (const [awb, shipmentData] of Object.entries(trackingData)) {
    const order = ordersByAwb.get(awb);
    if (!order) continue;

    const shipmentInfo = shipmentData as any;
    const trackingDataObj = shipmentInfo?.tracking_data;
    if (!trackingDataObj) continue;

    const shipmentTrack = trackingDataObj.shipment_track;
    if (!Array.isArray(shipmentTrack) || shipmentTrack.length === 0) continue;

    const currentStatus = shipmentTrack[0]?.current_status;
    if (!currentStatus) continue;

    const newStatus = determineNewShiprocketStatus(currentStatus);
    if (!newStatus) continue;
    if (newStatus === order.customStatus) continue;

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

// ============================================================================
// SCHEDULED XPRESSBEES STATUS UPDATES
// ============================================================================

// 1. STATUS DETERMINATION FUNCTION
function determineNewXpressbeesStatus(currentStatus: string): string | null {
  const statusMap: Record<string, string> = {
    "in transit": "In Transit",
    "out for delivery": "Out For Delivery",
    delivered: "Delivered",
    "RT-IT": "RTO In Transit",
    "RT-DL": "RTO Delivered",
    lost: "Lost",
  };
  return statusMap[currentStatus] || null;
}

// HELPER: Login to get fresh token
async function getXpressbeesToken(email: string, password: string): Promise<string | null> {
  try {
    const response = await fetch("https://shipment.xpressbees.com/api/users/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      console.error(`Xpressbees login failed: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as any;
    if (data.status && data.data) {
      return data.data; // The JWT token
    }

    return null;
  } catch (error) {
    console.error("Xpressbees login error:", error);
    return null;
  }
}

// 2. SCHEDULER
export const enqueueXpressbeesStatusUpdateTasksScheduled = onSchedule(
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
      console.log("Looking for active businesses, so that redundant updates can be avoided...");
      // Get all the Business (User) docs
      const businessesSnapshot = await db.collection("users").get();

      if (businessesSnapshot.empty) {
        console.log("No users with business found");
        return;
      }

      // Only process businesses that have orders in active shipping states
      const activeBusinesses = [];
      for (const doc of businessesSnapshot.docs) {
        const data = doc.data() as BusinessData;
        if (data.stores?.length && (await hasActiveShipments(data.stores))) {
          activeBusinesses.push(doc);
        }
      }

      console.log(`Found ${activeBusinesses.length} businesses`);
      console.log(
        "Creating the individual batches of the shops, which are within these active businesses...",
      );

      let allShopIds = new Set<{ accountId: string; businessId: string }>();
      activeBusinesses.forEach((doc) => {
        if (!doc.id) {
          console.error("⚠️ Found document without ID in activeBusinesses:", doc.ref.path);
          return; // Skip this document
        }

        const data = doc.data() as BusinessData;
        data.stores.forEach((acc) => {
          if (!acc) {
            console.error(`⚠️ Found undefined store in business ${doc.id}`);
            return;
          }

          if (acc === SHARED_STORE_ID) {
            if (doc.id === SUPER_ADMIN_ID) {
              allShopIds.add({ accountId: acc, businessId: doc.id });
            }
          } else {
            allShopIds.add({ accountId: acc, businessId: doc.id });
          }
        });
      });

      // Option 1: Convert to array and log (most readable)
      console.log("All shop IDs:", JSON.stringify(Array.from(allShopIds.values()), null, 2));

      console.log(`Found ${allShopIds.size} shops to process.`);
      console.log("Proceeding to create a batch and enqueueing all the shops as batch's jobs");

      // Create batch header
      const batchRef = db.collection("status_update_batches").doc();
      const batchId = batchRef.id;

      await batchRef.set({
        createdAt: FieldValue.serverTimestamp(),
        createdBy: "system-scheduled",
        queued: allShopIds.size,
        status: "running",
        processing: 0,
        success: 0,
        failed: 0,
        type: "status_update",
        schedule: "6x_daily",
        courier: "Xpressbees",
      });

      // Create job documents (one per account)
      const writer = db.bulkWriter();
      for (const { accountId, businessId } of allShopIds) {
        writer.set(
          batchRef.collection("jobs").doc(accountId),
          {
            accountId,
            businessId,
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

      const targetUrl = process.env.UPDATE_STATUS_TASK_JOB_TARGET_URL_XPRESSBEES;
      if (!targetUrl) {
        throw new Error("UPDATE_STATUS_TASK_TARGET_URL not configured");
      }

      // Create initial tasks (chunk 0 for each account)
      const taskPromises = Array.from(allShopIds).map(({ accountId, businessId }, index) =>
        createTask(
          {
            accountId,
            businessId,
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

      console.log(`Enqueued ${allShopIds.size} initial tasks for batch ${batchId}`);
    } catch (error) {
      console.error("enqueueStatusUpdateTasks failed:", error);
      throw error;
    }
  },
);

// 3. MAIN TASK HANDLER
export const updateXpressbeesStatusesJob = onRequest(
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
        businessId,
        batchId,
        jobId,
        cursor = null,
        chunkIndex = 0,
      } = req.body as {
        accountId?: string;
        businessId?: string;
        batchId?: string;
        jobId?: string;
        cursor?: string | null;
        chunkIndex?: number;
      };

      console.error(accountId, businessId, batchId, jobId);
      if (!accountId || !businessId || !batchId || !jobId) {
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
              businessId,
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

      // Verify account and get credentials
      const businessDoc = await db.collection("users").doc(businessId).get();
      if (!businessDoc.exists) throw new Error("ACCOUNT_NOT_FOUND");

      const email = businessDoc.data()?.integrations?.couriers?.xpressbees?.email;
      const password = businessDoc.data()?.integrations?.couriers?.xpressbees?.password;

      if (!email || !password) throw new Error("CREDENTIALS_MISSING");

      // Get fresh token for this chunk
      const token = await getXpressbeesToken(email, password);
      if (!token) throw new Error("TOKEN_FETCH_FAILED");

      // Process one chunk of orders
      const result = await processXpressbeesOrderChunk(accountId, token, cursor);

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
        await queueNextChunk(
          TASKS_SECRET.value() || "",
          process.env.UPDATE_STATUS_TASK_JOB_TARGET_URL_XPRESSBEES!,
          {
            accountId,
            businessId,
            batchId,
            jobId,
            chunkIndex: chunkIndex + 1,
            cursor: result.nextCursor,
          },
        );

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
      const NON_RETRYABLE = [
        "ACCOUNT_NOT_FOUND",
        "CREDENTIALS_MISSING",
        "NO_VALID_USERS_FOR_ACCOUNT",
        "TOKEN_FETCH_FAILED",
      ];
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

// 4. CHUNK PROCESSOR

async function processXpressbeesOrderChunk(
  accountId: string,
  token: string,
  cursor: string | null,
): Promise<ChunkResult> {
  const excludedStatuses = new Set([
    "New",
    "Confirmed",
    "Ready To Dispatch",
    "DTO Requested",
    // "Lost",
    "Closed",
    "RTO Closed",
    "DTO Delivered",
    "Cancellation Requested",
    "Pending Refunds",
    "DTO Refunded",
  ]);

  const shopRef = db.collection("accounts").doc(accountId);

  const shopDoc = await shopRef.get();
  const shopData = (shopDoc.data() as any) || null;

  // Build paginated query with OR condition for both courierProvider and courierReverseProvider
  let query = db
    .collection("accounts")
    .doc(accountId)
    .collection("orders")
    .where(
      Filter.or(
        Filter.where("courierProvider", "==", "Xpressbees"),
        Filter.where("courierReverseProvider", "==", "Xpressbees"),
      ),
    )
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
    .filter((order: any) => {
      // Check courier conditions: (courierProvider is Xpressbees AND no courierReverseProvider) OR (courierReverseProvider is Xpressbees)
      const hasXpressbeesCourier = order.courierProvider === "Xpressbees";
      const hasNoCourierReverse = !order.courierReverseProvider;
      const hasXpressbeesCourierReverse = order.courierReverseProvider === "Xpressbees";

      const meetsCourierCondition =
        (hasXpressbeesCourier && hasNoCourierReverse) || hasXpressbeesCourierReverse;

      // Check status condition
      const meetsStatusCondition =
        order.awb && order.customStatus && !excludedStatuses.has(order.customStatus);

      return meetsCourierCondition && meetsStatusCondition;
    });

  if (eligibleOrders.length === 0) {
    const lastDoc = snapshot.docs[snapshot.docs.length - 1];
    return {
      processed: snapshot.size,
      updated: 0,
      hasMore: snapshot.size === CHUNK_SIZE,
      nextCursor: lastDoc.id,
    };
  }

  console.log(
    `Processing ${eligibleOrders.length} eligible Xpressbees orders for account ${accountId}`,
  );

  // Process in API batches (individual calls for each AWB)
  let totalUpdated = 0;

  for (let i = 0; i < eligibleOrders.length; i += API_BATCH_SIZE) {
    const batch = eligibleOrders.slice(i, Math.min(i + API_BATCH_SIZE, eligibleOrders.length));
    const updates = await fetchAndProcessXpressbeesBatch(batch, token);

    // Apply updates using Firestore batch writes
    if (updates.length > 0) {
      const writeBatch = db.batch();
      updates.forEach((update) => {
        writeBatch.update(update.ref, update.data);
      });
      await writeBatch.commit();
      totalUpdated += updates.length;
      console.log(`Updated ${updates.length} orders in API batch ${i / API_BATCH_SIZE + 1}`);

      // ✅ ADD MESSAGE SENDING HERE - After successful commit
      await sendStatusChangeMessages(updates, shopData);
    }

    // Rate limiting between API batches
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

// 5. API BATCH PROCESSOR (collecting all responses first)
async function fetchAndProcessXpressbeesBatch(
  orders: any[],
  token: string,
): Promise<OrderUpdate[]> {
  const trackingResults: any[] = [];

  // Fetch tracking data for all orders
  for (const order of orders) {
    // Select correct AWB based on whether it's a DTO order
    const awb = order.customStatus?.includes("DTO") ? order.awb_reverse : order.awb;

    if (!awb) {
      trackingResults.push(null);
      continue;
    }

    try {
      const trackingUrl = `https://shipment.xpressbees.com/api/shipments2/track/${awb}`;
      const response = await fetch(trackingUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        if (response.status >= 500 || response.status === 429) {
          throw new Error(`HTTP_${response.status}`);
        }
        console.error(`Xpressbees API error for AWB ${awb}: ${response.status}`);
        trackingResults.push(null);
        continue;
      }

      const trackingData = (await response.json()) as any;
      trackingResults.push(trackingData);

      // Small delay between individual calls
      await sleep(50);
    } catch (error: any) {
      console.error(`Error tracking AWB ${awb}:`, error);
      if (error.message.startsWith("HTTP_")) {
        throw error;
      }
      trackingResults.push(null);
      continue;
    }
  }

  // Process all collected tracking data at once
  return prepareXpressbeesOrderUpdates(orders, trackingResults);
}

// 6. UPDATE PREPARATION (batch version)
function prepareXpressbeesOrderUpdates(orders: any[], trackingDataArray: any[]): OrderUpdate[] {
  const updates: OrderUpdate[] = [];

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const trackingData = trackingDataArray[i];

    if (!trackingData || !trackingData.status || !trackingData.data) continue;

    const currentStatus =
      trackingData.data.status !== "rto"
        ? trackingData.data.status
        : trackingData.data.history[0].status_code;
    if (!currentStatus) continue;

    const newStatus = determineNewXpressbeesStatus(currentStatus);
    if (!newStatus) continue;
    if (newStatus === order.customStatus) continue;

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

interface CloseDeliveredOrdersPayload {
  accountId: string;
  cutoffTime: string; // ISO string
}

const CLOSE_AFTER_HOURS = 360; // 15 days

// ============================================================================
// CRON JOB - Enqueue tasks to close delivered orders after 360 hours
// ============================================================================
export const closeDeliveredOrdersJob = onSchedule(
  {
    schedule: "0 3 * * *",
    timeZone: "Asia/Kolkata",
    memory: "256MiB",
    timeoutSeconds: 540,
    secrets: [TASKS_SECRET],
  },
  async () => {
    console.log("🚀 Starting closeDeliveredOrdersJob - Enqueueing tasks");

    const cutoffTimeMs = CLOSE_AFTER_HOURS * 60 * 60 * 1000;
    const cutoffTime = new Date(Date.now() - cutoffTimeMs);

    console.log(`📅 Cutoff time: ${cutoffTime.toISOString()}`);

    const accountsSnapshot = await db.collection("accounts").get();
    console.log(`📊 Found ${accountsSnapshot.size} accounts to check`);

    let tasksEnqueued = 0;
    let tasksFailed = 0;

    const taskPromises: Promise<void>[] = [];

    for (const accountDoc of accountsSnapshot.docs) {
      const payload: CloseDeliveredOrdersPayload = {
        accountId: accountDoc.id,
        cutoffTime: cutoffTime.toISOString(),
      };

      const taskPromise = createTask(payload, {
        tasksSecret: TASKS_SECRET.value() || "",
        queue: process.env.CLOSE_DELIVERED_QUEUE_NAME || "close-delivered-orders-queue",
        url: process.env.CLOSE_DELIVERED_TARGET_URL!,
      })
        .then(() => {
          tasksEnqueued++;
        })
        .catch((error) => {
          tasksFailed++;
          console.error(`❌ Failed to enqueue task for account ${accountDoc.id}:`, error);
        });

      taskPromises.push(taskPromise);
    }

    // Wait for all tasks to be enqueued
    await Promise.allSettled(taskPromises);

    console.log(`✅ Job complete - Tasks enqueued: ${tasksEnqueued}, Failed: ${tasksFailed}`);
  },
);

// ============================================================================
// HTTP ENDPOINT - Close delivered orders for one account
// ============================================================================
export const closeDeliveredOrdersTask = onRequest(
  {
    cors: true,
    timeoutSeconds: 300,
    secrets: [TASKS_SECRET],
    memory: "512MiB",
  },
  async (req, res) => {
    // ✅ AUTHENTICATION
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");
    } catch (error: any) {
      console.error("❌ Authentication failed:", error);
      res.status(401).json({ error: "Unauthorized", message: error.message });
      return;
    }

    // ✅ METHOD CHECK
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    // ✅ PARSE PAYLOAD
    const payload = req.body as CloseDeliveredOrdersPayload;

    if (!payload || !payload.accountId || !payload.cutoffTime) {
      res.status(400).json({
        error: "invalid_payload",
        message: "Missing required fields: accountId, cutoffTime",
      });
      return;
    }

    const { accountId, cutoffTime } = payload;

    console.log(`🔄 Processing account ${accountId} - closing delivered orders`);

    try {
      const accountDoc = await db.collection("accounts").doc(accountId).get();

      if (!accountDoc.exists) {
        console.warn(`⚠️ Account ${accountId} not found - skipping`);
        res.status(404).json({
          error: "account_not_found",
          accountId,
        });
        return;
      }

      const cutoffDate = new Date(cutoffTime);

      // Query orders that need to be closed
      const ordersToClose = await accountDoc.ref
        .collection("orders")
        .where("customStatus", "==", "Delivered")
        .where("lastStatusUpdate", "<=", cutoffDate)
        .limit(500)
        .get();

      if (ordersToClose.empty) {
        console.log(`✓ No orders to close for account ${accountId}`);
        res.status(200).json({
          success: true,
          message: "No orders to close",
          ordersClosed: 0,
        });
        return;
      }

      console.log(`📦 Found ${ordersToClose.size} orders to close for account ${accountId}`);

      // Process in batches (Firestore batch limit is 500 operations)
      const BATCH_SIZE = 500;
      const orderChunks = chunkArray(ordersToClose.docs, BATCH_SIZE);

      for (const chunk of orderChunks) {
        const batch = db.batch();

        chunk.forEach((doc) => {
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
        console.log(`✅ Closed batch of ${chunk.length} orders`);
      }

      console.log(`✅ Successfully closed ${ordersToClose.size} orders for account ${accountId}`);

      // ✅ SUCCESS RESPONSE
      res.status(200).json({
        success: true,
        accountId,
        ordersClosed: ordersToClose.size,
      });
    } catch (error: any) {
      console.error(`❌ Error closing orders for account ${accountId}:`, error);

      // ✅ ERROR RESPONSE
      res.status(500).json({
        error: "processing_failed",
        accountId,
        message: error.message,
      });
    }
  },
);

const DELAY_LEVELS = [
  { hours: 44, tag: "Delay Level-1", handler: sendConfirmedDelayedLvl1WhatsAppMessage },
  { hours: 96, tag: "Delay Level-2", handler: sendConfirmedDelayedLvl2WhatsAppMessage },
  { hours: 144, tag: "Delay Level-3", handler: sendConfirmedDelayedLvl3WhatsAppMessage },
] as const;

interface ProcessDelayedOrdersPayload {
  accountId: string;
  delayLevel: {
    hours: number;
    tag: string;
    handlerIndex: number; // Index into DELAY_LEVELS array
  };
}

// ============================================================================
// CRON JOB - Enqueue tasks for delayed confirmed orders
// ============================================================================
export const checkDelayedConfirmedOrders = onSchedule(
  {
    schedule: "0 2 * * *",
    timeZone: "Asia/Kolkata",
    memory: "256MiB",
    timeoutSeconds: 540,
    secrets: [TASKS_SECRET],
  },
  async () => {
    console.log("🚀 Starting checkDelayedConfirmedOrders job - Enqueueing tasks");

    const accountsSnapshot = await db.collection("accounts").get();
    console.log(`📊 Found ${accountsSnapshot.size} accounts to check`);

    let tasksEnqueued = 0;
    let tasksFailed = 0;

    // Create a task for each account x delay level combination
    const taskPromises: Promise<void>[] = [];

    for (const accountDoc of accountsSnapshot.docs) {
      for (let i = 0; i < DELAY_LEVELS.length; i++) {
        const level = DELAY_LEVELS[i];

        const payload: ProcessDelayedOrdersPayload = {
          accountId: accountDoc.id,
          delayLevel: {
            hours: level.hours,
            tag: level.tag,
            handlerIndex: i,
          },
        };

        const taskPromise = createTask(payload, {
          tasksSecret: TASKS_SECRET.value() || "",
          url: process.env.CONFIRMED_DELAYED_TARGET_URL!,
          queue: process.env.CONFIRMED_DELAYED_QUEUE_NAME || "confirmed-delayed-orders-queue",
        })
          .then(() => {
            tasksEnqueued++;
          })
          .catch((error) => {
            tasksFailed++;
            console.error(
              `❌ Failed to enqueue task for account ${accountDoc.id}, level ${level.tag}:`,
              error,
            );
          });

        taskPromises.push(taskPromise);
      }
    }

    // Wait for all tasks to be enqueued
    await Promise.allSettled(taskPromises);

    console.log(`✅ Job complete - Tasks enqueued: ${tasksEnqueued}, Failed: ${tasksFailed}`);
  },
);

// ============================================================================
// HTTP ENDPOINT - Process delayed orders for one account and one delay level
// ============================================================================
export const processDelayedOrdersTask = onRequest(
  {
    cors: true,
    timeoutSeconds: 300,
    secrets: [TASKS_SECRET],
    memory: "512MiB",
  },
  async (req, res) => {
    // ✅ AUTHENTICATION
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");
    } catch (error: any) {
      console.error("❌ Authentication failed:", error);
      res.status(401).json({ error: "Unauthorized", message: error.message });
      return;
    }

    // ✅ METHOD CHECK
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    // ✅ PARSE PAYLOAD
    const payload = req.body as ProcessDelayedOrdersPayload;

    if (!payload || !payload.accountId || !payload.delayLevel) {
      res.status(400).json({
        error: "invalid_payload",
        message: "Missing required fields: accountId, delayLevel",
      });
      return;
    }

    const { accountId, delayLevel } = payload;

    console.log(`🔄 Processing account ${accountId} for ${delayLevel.tag} (${delayLevel.hours}h)`);

    try {
      const accountDoc = await db.collection("accounts").doc(accountId).get();

      if (!accountDoc.exists) {
        console.warn(`⚠️ Account ${accountId} not found - skipping`);
        res.status(404).json({
          error: "account_not_found",
          accountId,
        });
        return;
      }

      const shop = accountDoc.data() as any;
      const cutoffTime = new Date(Date.now() - delayLevel.hours * 60 * 60 * 1000);

      // ✅ FIXED: Use dedicated tracking field instead of array check
      const ordersSnapshot = await accountDoc.ref
        .collection("orders")
        .where("customStatus", "==", "Confirmed")
        .where("lastStatusUpdate", "<=", cutoffTime)
        .where(`delayNotified_${delayLevel.hours}h`, "==", null) // ✅ Only get orders NOT yet notified
        .limit(500)
        .get();

      if (ordersSnapshot.empty) {
        console.log(`✓ No orders to process for account ${accountId}, level ${delayLevel.tag}`);
        res.status(200).json({
          success: true,
          message: "No orders to process",
          ordersProcessed: 0,
        });
        return;
      }

      console.log(`📦 Found ${ordersSnapshot.size} orders to process for account ${accountId}`);

      // Process in batches (Firestore batch limit is 500 operations)
      const BATCH_SIZE = 500;
      const orderChunks = chunkArray(ordersSnapshot.docs, BATCH_SIZE);

      for (const chunk of orderChunks) {
        const batch = db.batch();
        const messagePromises: Promise<any>[] = [];

        chunk.forEach((doc) => {
          // Update the order with the delay tag
          batch.update(doc.ref, {
            tags_confirmed: FieldValue.arrayUnion(delayLevel.tag),
            [`delayNotified_${delayLevel.hours}h`]: FieldValue.serverTimestamp(),
            delayNotificationAttempts: FieldValue.increment(1),
          });

          // Queue the message to be sent in parallel
          const order = doc.data() as any;
          const handler = DELAY_LEVELS[delayLevel.handlerIndex].handler;

          messagePromises.push(
            handler(shop, order).catch((error: Error) => {
              console.error(
                `❌ Failed to send ${delayLevel.tag} message for order ${doc.id}:`,
                error.message,
              );
              // Don't throw - we still want to mark the order as processed
            }),
          );
        });

        // Execute batch update and send messages in parallel
        await Promise.all([
          batch.commit(),
          ...messagePromises.map((p) => p.catch((e) => console.error(e))),
        ]);

        console.log(`✅ Processed batch of ${chunk.length} orders`);
      }

      console.log(
        `✅ Completed processing ${ordersSnapshot.size} orders for account ${accountId}, level ${delayLevel.tag}`,
      );

      // ✅ SUCCESS RESPONSE
      res.status(200).json({
        success: true,
        accountId,
        delayLevel: delayLevel.tag,
        ordersProcessed: ordersSnapshot.size,
      });
    } catch (error: any) {
      console.error(`❌ Error processing account ${accountId}, level ${delayLevel.tag}:`, error);

      // ✅ ERROR RESPONSE
      res.status(500).json({
        error: "processing_failed",
        accountId,
        delayLevel: delayLevel.tag,
        message: error.message,
      });
    }
  },
);

// ============================================================================
// Utility Functions
// ============================================================================

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Generates a PDF report of unavailable stock items from confirmed orders
 * Runs daily at 9 AM IST
 */
export const generateUnavailableStockReport = onSchedule(
  {
    schedule: "0 20 * * *",
    timeZone: "Asia/Kolkata",
    memory: "1GiB",
    timeoutSeconds: 540,
  },
  async () => {
    await generatePDFFunc();
  },
);

export const generateUnavailableStockReportOnRequest = onRequest(
  {
    cors: true,
    timeoutSeconds: 300,
    secrets: [ENQUEUE_FUNCTION_SECRET],
    memory: "1GiB",
  },
  async (req, res) => {
    // ✅ AUTHENTICATION
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    } catch (error: any) {
      console.error("❌ Authentication failed:", error);
      res.status(401).json({ error: "Unauthorized", message: error.message });
      return;
    }
    try {
      const { phone } = req.body;
      // ✅ VALIDATE PHONE NUMBER
      if (!phone) {
        res.status(400).json({ error: "Bad Request", message: "phone is required" });
        return;
      }
      await generatePDFFunc(phone);
      res.status(200).json({ success: true, message: "PDF generated and sent" });
    } catch (error: any) {
      console.error("❌ Error in PDF generation:", error);
      res.status(500).json({ error: "Internal server error", message: error.message });
    }
  },
);

async function generatePDFFunc(phone?: string) {
  try {
    console.log("🔄 Starting unavailable stock report generation...");

    // Get all shops
    const shopsSnapshot = await db.collection("accounts").get();

    for (const shopDoc of shopsSnapshot.docs) {
      const shop = shopDoc.id;
      const shopData = shopDoc.data() as any;
      console.log(`Processing shop: ${shop}`);
      // Query confirmed orders with "Unavailable" tag
      const ordersSnapshot = await db
        .collection("accounts")
        .doc(shop)
        .collection("orders")
        .where("customStatus", "==", "Confirmed")
        .where("tags_confirmed", "array-contains", "Unavailable")
        .get();

      if (ordersSnapshot.empty) {
        console.log(`No unavailable orders for shop: ${shop}`);
        continue;
      }

      // Process orders to create summary and detail data
      const itemSummary: Map<string, number> = new Map();
      const orderDetails: Array<{
        itemSku: string;
        itemQty: number;
        vendor: string;
        orderName: string;
      }> = [];

      ordersSnapshot.forEach((orderDoc) => {
        const order = orderDoc.data();
        const items = order.raw?.line_items || [];

        items.forEach((item: any) => {
          // Add to summary (aggregate by SKU)
          const currentQty = itemSummary.get(item.sku) || 0;
          itemSummary.set(item.sku, currentQty + item.quantity);

          // Add to order details (one row per item)
          orderDetails.push({
            itemSku: item.sku,
            itemQty: item.quantity,
            vendor: item.vendor || "N/A",
            orderName: order.name || "N/A",
          });
        });
      });

      // Calculate totals
      const totalQty = Array.from(itemSummary.values()).reduce((a, b) => a + b, 0);
      const totalOrders = ordersSnapshot.size;

      console.log(`📊 Found ${totalOrders} orders with ${totalQty} total items`);

      // Generate PDF
      const pdfBuffer = await generatePDF(itemSummary, orderDetails, totalQty, totalOrders);

      // Upload to Firebase Storage
      const date = new Date().toLocaleDateString("en-GB").replace(/\//g, "-");
      const fileName = `Unavailable_Stock_Summary_${date}.pdf`;
      const filePath = `unavailable_orders_pdf/${shop}/${fileName}`;

      const bucket = storage.bucket();
      const file = bucket.file(filePath);

      await file.save(pdfBuffer, {
        contentType: "application/pdf",
        metadata: {
          metadata: {
            generatedAt: new Date().toISOString(),
            shop: shop,
            totalOrders: totalOrders,
            totalItems: totalQty,
          },
        },
      });

      // Make the file publicly accessible and get download URL
      await file.makePublic();
      const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

      console.log(`✅ PDF generated successfully for shop: ${shop}`);
      console.log(`📊 Total Orders: ${totalOrders}, Total Items: ${totalQty}`);
      console.log(`📄 Download URL: ${downloadUrl}`);

      if (phone) {
        // Send to specific user
        await sendConfirmedDelayedOrdersPDFWhatsAppMessage(shopData, downloadUrl, phone);
      } else {
        // Send to default numbers (scheduled job)
        await Promise.all([
          sendConfirmedDelayedOrdersPDFWhatsAppMessage(shopData, downloadUrl, "8950188819"),
          sendConfirmedDelayedOrdersPDFWhatsAppMessage(shopData, downloadUrl, "9132326000"),
        ]);
      }
    }
  } catch (error) {
    console.error("❌ Error generating unavailable stock report:", error);
    throw error;
  }
}

/**
 * Generates the PDF with two tables: Summary and Order Details
 */
async function generatePDF(
  itemSummary: Map<string, number>,
  orderDetails: Array<{
    itemSku: string;
    itemQty: number;
    vendor: string;
    orderName: string;
  }>,
  totalQty: number,
  totalOrders: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
      bufferPages: true,
    });

    const chunks: Buffer[] = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Title and Summary Header
    const date = new Date().toLocaleDateString("en-GB");
    doc
      .fontSize(16)
      .fillColor("#FFFFFF")
      .rect(40, 40, doc.page.width - 80, 35)
      .fill("#4472C4");

    doc.fillColor("#FFFFFF").text(`SUMMARY OF UNAVAILABLE STOCK (${date})`, 50, 50, {
      align: "center",
    });

    doc.moveDown(0.3);

    // Total summary box
    const summaryY = doc.y + 10;
    doc
      .rect(40, summaryY, doc.page.width - 80, 25)
      .fill("#4472C4")
      .fillColor("#FFFFFF")
      .fontSize(11)
      .text(`Total Qty : ${totalQty}        Orders Delayed : ${totalOrders}`, 50, summaryY + 7, {
        align: "center",
      });

    doc.moveDown(1.5);

    // Table 1: Items Summary
    drawSummaryTable(doc, itemSummary);

    // Add some space before the second table
    if (doc.y > 600) {
      doc.addPage();
    } else {
      doc.moveDown(2);
    }

    // Table 2: Order Details
    drawOrderDetailsTable(doc, orderDetails);

    // Add page numbers
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .fillColor("#666666")
        .text(`Page ${i + 1} of ${pageCount}`, 40, doc.page.height - 30, { align: "center" });
    }

    doc.end();
  });
}

/**
 * Draws the summary table (Items Required with quantities)
 */
function drawSummaryTable(doc: InstanceType<typeof PDFDocument>, itemSummary: Map<string, number>) {
  const startX = 40;
  const startY = doc.y;
  const colWidths = [70, 390, 55];
  const rowHeight = 20;
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);

  // Header
  doc.fontSize(10).fillColor("#FFFFFF").rect(startX, startY, totalWidth, rowHeight).fill("#4472C4");

  doc
    .fillColor("#FFFFFF")
    .text("Serial No.", startX + 5, startY + 5, {
      width: colWidths[0] - 10,
      align: "left",
    })
    .text("Items Required", startX + colWidths[0] + 5, startY + 5, {
      width: colWidths[1] - 10,
      align: "left",
    })
    .text("Qty", startX + colWidths[0] + colWidths[1] + 5, startY + 5, {
      width: colWidths[2] - 10,
      align: "right",
    });

  let currentY = startY + rowHeight;
  let serialNo = 1;

  // Sort items by SKU for consistent ordering
  const sortedItems = Array.from(itemSummary.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  // Data rows
  sortedItems.forEach(([sku, qty]) => {
    // Check if we need a new page
    if (currentY > doc.page.height - 100) {
      doc.addPage();
      currentY = 50;

      // Redraw header on new page
      doc
        .fontSize(10)
        .fillColor("#FFFFFF")
        .rect(startX, currentY, totalWidth, rowHeight)
        .fill("#4472C4");

      doc
        .fillColor("#FFFFFF")
        .text("Serial No.", startX + 5, currentY + 5, {
          width: colWidths[0] - 10,
        })
        .text("Items Required", startX + colWidths[0] + 5, currentY + 5, {
          width: colWidths[1] - 10,
        })
        .text("Qty", startX + colWidths[0] + colWidths[1] + 5, currentY + 5, {
          width: colWidths[2] - 10,
          align: "right",
        });

      currentY += rowHeight;
    }

    // Draw row with border
    doc
      .lineWidth(0.5)
      .strokeColor("#CCCCCC")
      .rect(startX, currentY, totalWidth, rowHeight)
      .stroke();

    // Draw cell content
    doc
      .fillColor("#000000")
      .fontSize(9)
      .text(serialNo.toString(), startX + 5, currentY + 6, {
        width: colWidths[0] - 10,
      })
      .text(sku, startX + colWidths[0] + 5, currentY + 6, {
        width: colWidths[1] - 10,
      })
      .text(qty.toString(), startX + colWidths[0] + colWidths[1] + 5, currentY + 6, {
        width: colWidths[2] - 10,
        align: "right",
      });

    currentY += rowHeight;
    serialNo++;
  });

  doc.y = currentY + 10;
}

/**
 * Draws the order details table (one row per item in each order)
 */
function drawOrderDetailsTable(
  doc: InstanceType<typeof PDFDocument>,
  orderDetails: Array<{
    itemSku: string;
    itemQty: number;
    vendor: string;
    orderName: string;
  }>,
) {
  const startX = 40;
  let startY = doc.y;
  const colWidths = [50, 200, 65, 80, 120];
  const rowHeight = 20;
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);

  // Section header
  doc.fontSize(12).fillColor("#FFFFFF").rect(startX, startY, totalWidth, 25).fill("#4472C4");

  doc.fillColor("#FFFFFF").text("Order Wise Detail", startX + 5, startY + 6, { align: "left" });

  startY += 25;

  // Table header
  doc.fontSize(10).rect(startX, startY, totalWidth, rowHeight).fill("#4472C4");

  let currentX = startX;
  doc.fillColor("#FFFFFF").text("Sr. No.", currentX + 5, startY + 5, { width: colWidths[0] - 10 });
  currentX += colWidths[0];
  doc.text("Item SKU", currentX + 5, startY + 5, { width: colWidths[1] - 10 });
  currentX += colWidths[1];
  doc.text("Item Qty", currentX + 5, startY + 5, { width: colWidths[2] - 10 });
  currentX += colWidths[2];
  doc.text("Vendor", currentX + 5, startY + 5, { width: colWidths[3] - 10 });
  currentX += colWidths[3];
  doc.text("Order Name", currentX + 5, startY + 5, {
    width: colWidths[4] - 10,
  });

  let currentY = startY + rowHeight;
  let serialNo = 1;

  // Data rows
  orderDetails.forEach((detail) => {
    // Check if we need a new page
    if (currentY > doc.page.height - 100) {
      doc.addPage();
      currentY = 50;

      // Redraw header on new page
      doc.fontSize(10).rect(startX, currentY, totalWidth, rowHeight).fill("#4472C4");

      let headerX = startX;
      doc.fillColor("#FFFFFF").text("Sr. No.", headerX + 5, currentY + 5, {
        width: colWidths[0] - 10,
      });
      headerX += colWidths[0];
      doc.text("Item SKU", headerX + 5, currentY + 5, {
        width: colWidths[1] - 10,
      });
      headerX += colWidths[1];
      doc.text("Item Qty", headerX + 5, currentY + 5, {
        width: colWidths[2] - 10,
      });
      headerX += colWidths[2];
      doc.text("Vendor", headerX + 5, currentY + 5, {
        width: colWidths[3] - 10,
      });
      headerX += colWidths[3];
      doc.text("Order Name", headerX + 5, currentY + 5, {
        width: colWidths[4] - 10,
      });

      currentY += rowHeight;
    }

    // Draw row border
    doc
      .lineWidth(0.5)
      .strokeColor("#CCCCCC")
      .rect(startX, currentY, totalWidth, rowHeight)
      .stroke();

    // Draw cell content
    doc.fillColor("#000000").fontSize(9);

    currentX = startX;
    doc.text(serialNo.toString(), currentX + 5, currentY + 6, {
      width: colWidths[0] - 10,
    });
    currentX += colWidths[0];
    doc.text(detail.itemSku, currentX + 5, currentY + 6, {
      width: colWidths[1] - 10,
    });
    currentX += colWidths[1];
    doc.text(detail.itemQty.toString(), currentX + 5, currentY + 6, {
      width: colWidths[2] - 10,
    });
    currentX += colWidths[2];
    doc.text(detail.vendor, currentX + 5, currentY + 6, {
      width: colWidths[3] - 10,
    });
    currentX += colWidths[3];
    doc.text(detail.orderName, currentX + 5, currentY + 6, {
      width: colWidths[4] - 10,
    });

    currentY += rowHeight;
    serialNo++;
  });

  doc.y = currentY;
}

interface GenerateExcelPayload {
  phoneNumbers?: string[];
}

/**
 * Generates Excel file of all orders from shared store and sends download link
 */
export const generateSharedStoreOrdersExcel = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "2GiB",
    secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req: Request, res: Response): Promise<void> => {
    try {
      // Validate secret
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { phoneNumbers = ["8950188819", "9132326000"] } = (req.body ||
        {}) as GenerateExcelPayload;

      console.log("🚀 Starting Excel generation for shared store...");
      console.log(`📱 Will send to: ${phoneNumbers.join(", ")}`);

      // Get shared store data
      const shopDoc = await db.collection("accounts").doc(SHARED_STORE_ID).get();
      if (!shopDoc.exists) {
        res.status(404).json({ error: "shared_store_not_found" });
        return;
      }

      const shopData = shopDoc.data() as any;

      // Fetch all orders from shared store
      console.log("📦 Fetching orders from shared store...");
      const ordersSnapshot = await db
        .collection("accounts")
        .doc(SHARED_STORE_ID)
        .collection("orders")
        .get();

      if (ordersSnapshot.empty) {
        res.status(400).json({ error: "no_orders_found" });
        return;
      }

      console.log(`Found ${ordersSnapshot.size} orders`);

      // Process orders into Excel rows
      const excelData: any[] = [];

      ordersSnapshot.docs.forEach((doc) => {
        const order = doc.data();
        const items = order.raw?.line_items || [];

        // Helper functions
        const formatDate = (timestamp: any) => {
          if (!timestamp) return "N/A";
          const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
          return date.toLocaleDateString("en-GB");
        };

        const formatAddress = (address: any) => {
          if (!address) return "N/A";
          const parts = [
            address.address1,
            address.address2,
            address.city,
            address.province,
            address.zip,
            address.country,
          ].filter(Boolean);
          return parts.join(", ") || "N/A";
        };

        const customerName =
          order.raw.customer?.first_name && order.raw.customer?.last_name
            ? `${order.raw.customer.first_name} ${order.raw.customer.last_name}`
            : order.raw.billing_address?.name || order.raw.shipping_address?.name || "N/A";

        const paymentStatus = order.raw.financial_status;

        // Create a row for each line item
        items.forEach((item: any) => {
          excelData.push({
            "Order name": order.name,
            AWB: order.awb ?? "N/A",
            "Return AWB": order.awb_reverse ?? "N/A",
            Courier: order.courier ?? "N/A",
            "Order date": formatDate(order.createdAt),
            Customer: customerName,
            Email: order.raw.customer?.email || order.raw?.contact_email || "N/A",
            Phone:
              order.raw.customer?.phone ||
              order.raw.billing_address?.phone ||
              order.raw.shipping_address?.phone ||
              "N/A",
            "Item title": item.title,
            "Item SKU": item.sku || "N/A",
            "Item Quantity": item.quantity,
            "Item Price": item.price,
            "Total Order Price": order.totalPrice,
            Discount: order.raw.total_discounts || 0,
            Vendor: item.vendor || "N/A",
            Currency: order.currency,
            "Payment Status": paymentStatus,
            Status: order.customStatus,
            "Billing Address": formatAddress(order.raw.billing_address),
            "Billing City": order.raw.billing_address?.city || "N/A",
            "Billing State": order.raw.billing_address?.province || "N/A",
            "Billing Pincode": order.raw.billing_address?.zip || "N/A",
            "Billing Country": order.raw.billing_address?.country || "N/A",
            "Shipping Address": formatAddress(order.raw.shipping_address),
            "Shipping City": order.raw.shipping_address?.city || "N/A",
            "Shipping State": order.raw.shipping_address?.province || "N/A",
            "Shipping Pincode": order.raw.shipping_address?.zip || "N/A",
            "Shipping Country": order.raw.shipping_address?.country || "N/A",
          });
        });
      });

      console.log(`📊 Generated ${excelData.length} rows (including line items)`);

      // Generate Excel file
      const worksheet = XLSX.utils.json_to_sheet(excelData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Orders");

      // Auto-size columns
      const maxWidth = 50;
      const wscols = Object.keys(excelData[0] || {}).map((key) => {
        const maxLen = Math.max(
          key.length,
          ...excelData.map((row) => String(row[key] || "").length),
        );
        return { wch: Math.min(maxLen + 2, maxWidth) };
      });
      worksheet["!cols"] = wscols;

      // Convert to buffer
      const excelBuffer = XLSX.write(workbook, {
        type: "buffer",
        bookType: "xlsx",
      });

      // Upload to Firebase Storage
      const date = new Date().toLocaleDateString("en-GB").replace(/\//g, "-");
      const fileName = `Shared_Store_Orders_${date}.xlsx`;
      const filePath = `shared_store_orders/${fileName}`;

      const bucket = storage.bucket();
      const file = bucket.file(filePath);

      await file.save(excelBuffer, {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        metadata: {
          metadata: {
            generatedAt: new Date().toISOString(),
            shop: SHARED_STORE_ID,
            totalOrders: ordersSnapshot.size,
            totalRows: excelData.length,
          },
        },
      });

      // Make the file publicly accessible and get download URL
      await file.makePublic();
      const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

      console.log(`✅ Excel file generated successfully`);
      console.log(`📊 Total Orders: ${ordersSnapshot.size}, Total Rows: ${excelData.length}`);
      console.log(`📄 Download URL: ${downloadUrl}`);

      // Send WhatsApp messages to all phone numbers
      const messagePromises = phoneNumbers.map((phone) =>
        sendSharedStoreOrdersExcelWhatsAppMessage(shopData, downloadUrl, phone),
      );

      await Promise.allSettled(messagePromises);

      console.log(`📱 WhatsApp messages sent to ${phoneNumbers.length} numbers`);

      res.json({
        success: true,
        message: "Excel generated and sent successfully",
        downloadUrl,
        stats: {
          totalOrders: ordersSnapshot.size,
          totalRows: excelData.length,
          sentTo: phoneNumbers,
        },
      });
    } catch (error) {
      console.error("❌ Error generating Excel:", error);
      res.status(500).json({
        error: "excel_generation_failed",
        details: error instanceof Error ? error.message : String(error),
      });
    }
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
    "Cancellation Requested",
    "Pending Refunds",
    "DTO Refunded",
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

// ============================================================================
// MIGRATIONS
// ============================================================================

// Extract provider name from courier string
function getCourierProvider(courier: string | undefined | null): string | null {
  if (!courier || typeof courier !== "string") return null;

  // Extract provider from "Provider: Details" format
  const colonIndex = courier.indexOf(":");
  if (colonIndex > 0) {
    return courier.substring(0, colonIndex).trim();
  }

  // If no colon, return the whole string trimmed
  return courier.trim();
}

interface MigrationStats {
  accountsProcessed: number;
  ordersScanned: number;
  ordersUpdated: number;
  ordersSkipped: number;
  errors: number;
}

async function migrateAccountOrders(accountId: string): Promise<{
  scanned: number;
  updated: number;
  skipped: number;
}> {
  const BATCH_SIZE = 500; // Firestore batch write limit
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let lastDoc: QueryDocumentSnapshot | null = null;

  while (true) {
    // Query orders in chunks
    let query = db.collection("accounts").doc(accountId).collection("orders").limit(BATCH_SIZE);

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      break; // No more orders
    }

    // Process this batch
    const batch = db.batch();
    let batchCount = 0;

    for (const doc of snapshot.docs) {
      scanned++;
      const data = doc.data();

      // Check if migration is needed
      const needsUpdate =
        (data.courier && !data.courierProvider) ||
        (data.courier_reverse && !data.courierReverseProvider);

      if (!needsUpdate) {
        skipped++;
        continue;
      }

      // Extract providers
      const courierProvider = getCourierProvider(data.courier);
      const courierReverseProvider = getCourierProvider(data.courier_reverse);

      // Build update object
      const updateData: any = {};

      if (data.courier && !data.courierProvider) {
        updateData.courierProvider = courierProvider;
      }

      if (data.courier_reverse && !data.courierReverseProvider) {
        updateData.courierReverseProvider = courierReverseProvider;
      }

      // Add to batch
      if (Object.keys(updateData).length > 0) {
        batch.update(doc.ref, updateData);
        batchCount++;
        updated++;
      }
    }

    // Commit batch if there are updates
    if (batchCount > 0) {
      await batch.commit();
      console.log(`  💾 Committed batch: ${batchCount} orders updated`);
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];

    // Progress update
    if (scanned % 1000 === 0) {
      console.log(`  📈 Progress: ${scanned} scanned, ${updated} updated`);
    }
  }

  return { scanned, updated, skipped };
}

export const migrateCourierProviders = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "1GiB",
    region: process.env.LOCATION || "asia-south1",
    secrets: [ENQUEUE_FUNCTION_SECRET], // Add secret protection
  },
  async (req: Request, res: Response): Promise<void> => {
    try {
      // Optional: Add secret protection
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      console.log("🚀 Starting Courier Provider Fields Migration...\n");

      const stats: MigrationStats = {
        accountsProcessed: 0,
        ordersScanned: 0,
        ordersUpdated: 0,
        ordersSkipped: 0,
        errors: 0,
      };

      try {
        // Get all accounts
        const accountsSnapshot = await db.collection("accounts").get();
        console.log(`Found ${accountsSnapshot.size} accounts to process\n`);

        // Process each account
        for (const accountDoc of accountsSnapshot.docs) {
          const accountId = accountDoc.id;
          console.log(`\n📦 Processing account: ${accountId}`);

          try {
            const accountStats = await migrateAccountOrders(accountId);
            stats.accountsProcessed++;
            stats.ordersScanned += accountStats.scanned;
            stats.ordersUpdated += accountStats.updated;
            stats.ordersSkipped += accountStats.skipped;

            console.log(
              `  ✅ Account completed: ${accountStats.updated} updated, ${accountStats.skipped} skipped`,
            );
          } catch (error) {
            stats.errors++;
            console.error(`  ❌ Error processing account ${accountId}:`, error);
          }

          // Small delay between accounts to avoid rate limits
          await sleep(100);
        }

        // Print final summary
        console.log("\n" + "=".repeat(60));
        console.log("📊 MIGRATION SUMMARY");
        console.log("=".repeat(60));
        console.log(`Accounts processed: ${stats.accountsProcessed}`);
        console.log(`Orders scanned:     ${stats.ordersScanned}`);
        console.log(`Orders updated:     ${stats.ordersUpdated}`);
        console.log(`Orders skipped:     ${stats.ordersSkipped}`);
        console.log(`Errors:             ${stats.errors}`);
        console.log("=".repeat(60));
        console.log("✨ Migration completed!\n");

        res.json({
          success: true,
          summary: stats,
          message: "Migration completed successfully",
        });
      } catch (error) {
        console.error("\n❌ Migration failed:", error);
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          stats,
        });
      }
    } catch (authError) {
      res.status(401).json({ error: `Unauthorized ${authError}` });
    }
  },
);

async function migrateCancelledOrders(accountId: string): Promise<{
  scanned: number;
  updated: number;
  skipped: number;
}> {
  const BATCH_SIZE = 500; // Firestore batch write limit
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let lastDoc: QueryDocumentSnapshot | null = null;

  while (true) {
    // Query orders in chunks
    let query = db.collection("accounts").doc(accountId).collection("orders").limit(BATCH_SIZE);

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      break; // No more orders
    }

    // Process this batch
    const batch = db.batch();
    let batchCount = 0;

    for (const doc of snapshot.docs) {
      scanned++;
      const data = doc.data();

      // Check if order is cancelled on Shopify
      const isCancelled = data.raw?.cancelled_at !== null && data.raw?.cancelled_at !== undefined;

      // Skip if not cancelled or already has Cancelled status
      if (!isCancelled || data.customStatus === "Cancelled") {
        skipped++;
        continue;
      }

      // Update to Cancelled status
      batch.update(doc.ref, {
        customStatus: "Cancelled",
      });
      batchCount++;
      updated++;
    }

    // Commit batch if there are updates
    if (batchCount > 0) {
      await batch.commit();
      console.log(`  💾 Committed batch: ${batchCount} orders updated to Cancelled`);
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];

    // Progress update
    if (scanned % 1000 === 0) {
      console.log(`  📈 Progress: ${scanned} scanned, ${updated} updated`);
    }
  }

  return { scanned, updated, skipped };
}

export const migrateCancelledOrdersStatus = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "1GiB",
    region: process.env.LOCATION || "asia-south1",
    secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req: Request, res: Response): Promise<void> => {
    try {
      // Add secret protection
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      console.log("🚀 Starting Cancelled Orders Status Migration...\n");

      const stats: MigrationStats = {
        accountsProcessed: 0,
        ordersScanned: 0,
        ordersUpdated: 0,
        ordersSkipped: 0,
        errors: 0,
      };

      try {
        // Get all accounts
        const accountsSnapshot = await db.collection("accounts").get();
        console.log(`Found ${accountsSnapshot.size} accounts to process\n`);

        // Process each account
        for (const accountDoc of accountsSnapshot.docs) {
          const accountId = accountDoc.id;
          console.log(`\n📦 Processing account: ${accountId}`);

          try {
            const accountStats = await migrateCancelledOrders(accountId);
            stats.accountsProcessed++;
            stats.ordersScanned += accountStats.scanned;
            stats.ordersUpdated += accountStats.updated;
            stats.ordersSkipped += accountStats.skipped;

            console.log(
              `  ✅ Account completed: ${accountStats.updated} updated, ${accountStats.skipped} skipped`,
            );
          } catch (error) {
            stats.errors++;
            console.error(`  ❌ Error processing account ${accountId}:`, error);
          }

          // Small delay between accounts to avoid rate limits
          await sleep(100);
        }

        // Print final summary
        console.log("\n" + "=".repeat(60));
        console.log("📊 MIGRATION SUMMARY");
        console.log("=".repeat(60));
        console.log(`Accounts processed: ${stats.accountsProcessed}`);
        console.log(`Orders scanned:     ${stats.ordersScanned}`);
        console.log(`Orders updated:     ${stats.ordersUpdated}`);
        console.log(`Orders skipped:     ${stats.ordersSkipped}`);
        console.log(`Errors:             ${stats.errors}`);
        console.log("=".repeat(60));
        console.log("✨ Migration completed!\n");

        res.json({
          success: true,
          summary: stats,
          message: "Cancelled orders migration completed successfully",
        });
      } catch (error) {
        console.error("\n❌ Migration failed:", error);
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          stats,
        });
      }
    } catch (authError) {
      res.status(401).json({ error: `Unauthorized ${authError}` });
    }
  },
);

// functions/src/index.ts

// ============================================================================
// MIGRATION: ADD VENDORS ARRAY FIELD
// ============================================================================

interface VendorsMigrationStats {
  accountsProcessed: number;
  ordersScanned: number;
  ordersUpdated: number;
  ordersSkipped: number;
  errors: number;
}

async function migrateAccountVendors(accountId: string): Promise<{
  scanned: number;
  updated: number;
  skipped: number;
}> {
  const BATCH_SIZE = 500;
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let lastDoc: QueryDocumentSnapshot | null = null;

  while (true) {
    let query = db.collection("accounts").doc(accountId).collection("orders").limit(BATCH_SIZE);

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      break;
    }

    const batch = db.batch();
    let batchCount = 0;

    for (const doc of snapshot.docs) {
      scanned++;
      batch.update(doc.ref, { storeId: accountId });
      batchCount++;
      updated++;
    }

    // Commit batch if there are updates
    if (batchCount > 0) {
      await batch.commit();
      console.log(`  💾 Committed batch: ${batchCount} orders updated`);
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];

    // Progress update
    if (scanned % 1000 === 0) {
      console.log(`  📈 Progress: ${scanned} scanned, ${updated} updated`);
    }
  }

  return { scanned, updated, skipped };
}

export const migrateVendorsField = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "1GiB",
    region: process.env.LOCATION || "asia-south1",
    secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req: Request, res: Response): Promise<void> => {
    try {
      // Validate secret
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      console.log("🚀 Starting Vendors Field Migration...\n");

      const stats: VendorsMigrationStats = {
        accountsProcessed: 0,
        ordersScanned: 0,
        ordersUpdated: 0,
        ordersSkipped: 0,
        errors: 0,
      };

      try {
        // Get all accounts
        const accountsSnapshot = await db.collection("accounts").get();
        console.log(`Found ${accountsSnapshot.size} accounts to process\n`);

        // Process each account
        for (const accountDoc of accountsSnapshot.docs) {
          const accountId = accountDoc.id;
          console.log(`\n📦 Processing account: ${accountId}`);

          try {
            const accountStats = await migrateAccountVendors(accountId);
            stats.accountsProcessed++;
            stats.ordersScanned += accountStats.scanned;
            stats.ordersUpdated += accountStats.updated;
            stats.ordersSkipped += accountStats.skipped;

            console.log(
              `  ✅ Account completed: ${accountStats.updated} updated, ${accountStats.skipped} skipped`,
            );
          } catch (error) {
            stats.errors++;
            console.error(`  ❌ Error processing account ${accountId}:`, error);
          }

          // Small delay between accounts
          await sleep(100);
        }

        // Print final summary
        console.log("\n" + "=".repeat(60));
        console.log("📊 VENDORS FIELD MIGRATION SUMMARY");
        console.log("=".repeat(60));
        console.log(`Accounts processed: ${stats.accountsProcessed}`);
        console.log(`Orders scanned:     ${stats.ordersScanned}`);
        console.log(`Orders updated:     ${stats.ordersUpdated}`);
        console.log(`Orders skipped:     ${stats.ordersSkipped}`);
        console.log(`Errors:             ${stats.errors}`);
        console.log("=".repeat(60));
        console.log("✨ Migration completed!\n");

        res.json({
          success: true,
          summary: stats,
          message: "Vendors field migration completed successfully",
        });
      } catch (error) {
        console.error("\n❌ Migration failed:", error);
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          stats,
        });
      }
    } catch (authError) {
      res.status(401).json({ error: `Unauthorized ${authError}` });
    }
  },
);

// ============================================================================
// HTTP FUNCTION: Initialize Order Counts Metadata
// ============================================================================

interface InitializeStats {
  accountsProcessed: number;
  totalOrders: number;
  metadataCreated: number;
  errors: number;
}

async function initializeAccountMetadata(accountId: string): Promise<{
  totalOrders: number;
  counts: Record<string, number>;
}> {
  console.log(`  📊 Counting orders for account: ${accountId}`);

  const ordersSnapshot = await db.collection("accounts").doc(accountId).collection("orders").get();

  const counts: Record<string, number> = {
    "All Orders": 0,
    New: 0,
    Confirmed: 0,
    "Ready To Dispatch": 0,
    Dispatched: 0,
    "In Transit": 0,
    "Out For Delivery": 0,
    Delivered: 0,
    "RTO In Transit": 0,
    "RTO Delivered": 0,
    "DTO Requested": 0,
    "DTO Booked": 0,
    "DTO In Transit": 0,
    "DTO Delivered": 0,
    "Pending Refunds": 0,
    Lost: 0,
    Closed: 0,
    "RTO Closed": 0,
    "Cancellation Requested": 0,
    Cancelled: 0,
  };

  let allOrdersCount = 0;

  ordersSnapshot.docs.forEach((doc) => {
    const order = doc.data();
    const isShopifyCancelled = !!order.raw?.cancelled_at && order?.customStatus === "Cancelled";

    allOrdersCount++;
    if (isShopifyCancelled) {
      counts["Cancelled"]++;
    } else {
      const status = order.customStatus || "New";
      if (counts[status] !== undefined) {
        counts[status]++;
      } else {
        console.warn(`  ⚠️ Unknown status found: ${status}`);
      }
    }
  });

  counts["All Orders"] = allOrdersCount;

  // Save to metadata document
  await db.collection("accounts").doc(accountId).collection("metadata").doc("orderCounts").set({
    counts,
    lastUpdated: FieldValue.serverTimestamp(),
  });

  console.log(`  ✅ Metadata created: ${ordersSnapshot.size} orders counted`);

  return {
    totalOrders: ordersSnapshot.size,
    counts,
  };
}

export const initializeMetadata = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "1GiB",
    region: process.env.LOCATION || "asia-south1",
    secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req, res): Promise<void> => {
    try {
      // Validate secret
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      console.log("🚀 Starting Order Counts Metadata Initialization...\n");

      const stats: InitializeStats = {
        accountsProcessed: 0,
        totalOrders: 0,
        metadataCreated: 0,
        errors: 0,
      };

      try {
        // Get all accounts
        const accountsSnapshot = await db.collection("accounts").get();
        console.log(`Found ${accountsSnapshot.size} accounts to process\n`);

        // Process each account
        for (const accountDoc of accountsSnapshot.docs) {
          const accountId = accountDoc.id;
          console.log(`\n📦 Processing account: ${accountId}`);

          try {
            const result = await initializeAccountMetadata(accountId);
            stats.accountsProcessed++;
            stats.totalOrders += result.totalOrders;
            stats.metadataCreated++;

            console.log(`  ✅ Account completed: ${result.totalOrders} orders`);
          } catch (error) {
            stats.errors++;
            console.error(`  ❌ Error processing account ${accountId}:`, error);
          }

          // Small delay between accounts
          await sleep(100);
        }

        // Print final summary
        console.log("\n" + "=".repeat(60));
        console.log("📊 INITIALIZATION SUMMARY");
        console.log("=".repeat(60));
        console.log(`Accounts processed:   ${stats.accountsProcessed}`);
        console.log(`Total orders counted: ${stats.totalOrders}`);
        console.log(`Metadata created:     ${stats.metadataCreated}`);
        console.log(`Errors:               ${stats.errors}`);
        console.log("=".repeat(60));
        console.log("✨ Initialization completed!\n");

        res.json({
          success: true,
          summary: stats,
          message: "Metadata initialization completed successfully",
        });
      } catch (error) {
        console.error("\n❌ Initialization failed:", error);
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          stats,
        });
      }
    } catch (authError) {
      res.status(401).json({ error: `Unauthorized ${authError}` });
    }
  },
);

// ============================================================================
// BACKGROUND FUNCTION: Auto-Update Order Counts
// ============================================================================

export const updateOrderCounts = onDocumentWritten(
  {
    document: "accounts/{storeId}/orders/{orderId}",
    region: process.env.LOCATION || "asia-south1",
    memory: "256MiB",
  },
  async (event) => {
    const storeId = event.params.storeId;
    const orderId = event.params.orderId;

    console.log(`📝 Order ${orderId} changed in store ${storeId}`);

    const metadataRef = db
      .collection("accounts")
      .doc(storeId)
      .collection("metadata")
      .doc("orderCounts");

    try {
      const change = event.data;
      if (!change) return;

      // ============================================================
      // CASE 1: Order Deleted
      // ============================================================
      if (!change.after.exists) {
        const oldOrder = change.before.data();
        if (!oldOrder) return;

        const oldStatus = oldOrder.customStatus || "New";

        await metadataRef.set(
          {
            counts: {
              "All Orders": FieldValue.increment(-1),
              [oldStatus]: FieldValue.increment(-1),
            },
            lastUpdated: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        console.log(`✅ Decremented count for deleted order (${oldStatus})`);
        return;
      }

      // ============================================================
      // CASE 2: New Order Created
      // ============================================================
      if (!change.before.exists) {
        const newOrder = change.after.data();
        if (!newOrder) return;

        const newStatus = newOrder.customStatus || "New";

        await metadataRef.set(
          {
            counts: {
              "All Orders": FieldValue.increment(1),
              [newStatus]: FieldValue.increment(1),
            },
            lastUpdated: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        console.log(`✅ Incremented count for new order (${newStatus})`);
        return;
      }

      // ============================================================
      // CASE 3: Order Updated (Status Changed)
      // ============================================================
      const oldOrder = change.before.data();
      const newOrder = change.after.data();

      if (!oldOrder || !newOrder) return;

      const oldStatus = oldOrder.customStatus || "New";
      const newStatus = newOrder.customStatus || "New";

      // If status hasn't changed, do nothing
      if (oldStatus === newStatus) {
        console.log(`⏭️ No status change for order ${orderId}, skipping`);
        return;
      }

      // Update counts atomically
      const updates: any = {
        lastUpdated: FieldValue.serverTimestamp(),
        [`counts.${oldStatus}`]: FieldValue.increment(-1),
        [`counts.${newStatus}`]: FieldValue.increment(1),
      };

      await metadataRef.update(updates);

      console.log(`✅ Updated counts: ${oldStatus} → ${newStatus}`);
    } catch (error) {
      console.error(`❌ Error updating counts for ${storeId}:`, error);

      // If metadata doesn't exist, log warning
      if ((error as any).code === "not-found") {
        console.error(
          `⚠️ Metadata not found for ${storeId}. Please run initializeMetadata function first.`,
        );
      }
    }
  },
);
