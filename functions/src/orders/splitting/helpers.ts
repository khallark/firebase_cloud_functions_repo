import { DocumentReference, FieldValue, Transaction } from "firebase-admin/firestore";
import { db } from "../../firebaseAdmin";

/**
 * Check if order has multiple vendors
 */
export function hasMultipleVendors(lineItems: any[]): boolean {
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
export interface VendorGroup {
  vendor: string;
  lineItems: any[];
  subtotal: number;
  tax: number;
  total: number;
  totalWeight: number;
}

export function groupLineItemsByVendor(lineItems: any[]): VendorGroup[] {
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
export function calculateProportionalDiscount(
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
export async function maybeCompleteSplitBatch(batchRef: DocumentReference): Promise<void> {
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
export async function handleSplitJobFailure(params: {
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
