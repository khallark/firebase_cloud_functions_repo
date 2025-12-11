import { DocumentReference, FieldValue, Transaction } from "firebase-admin/firestore";
import { createTask } from "../services";
import { TASKS_SECRET } from "../config";
import { maybeCompleteBatch } from "./maybeCompleteBatch";
import { db } from "../firebaseAdmin";

function safeStringify(obj: any): string | null {
  if (!obj) return null;
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

/**
 * Handles job failure with retry logic and priority fallback
 */
export async function handleJobFailure(params: {
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
        ...(apiResp && { lastApiResp: safeStringify(apiResp) }),
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
    if (apiResp) updateData.apiResp = safeStringify(apiResp);

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
