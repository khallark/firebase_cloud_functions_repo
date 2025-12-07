import { DocumentReference, FieldValue, Transaction } from "firebase-admin/firestore";
import { maybeCompleteBatch } from "../../helpers";
import { db } from "../../firebaseAdmin";

export async function handleReturnJobFailure(params: {
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
