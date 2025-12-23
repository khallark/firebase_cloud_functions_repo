import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";

/**
 * Migration function to backfill refundedAmount for each line item
 * in orders with "DTO Refunded" status.
 *
 * Distribution logic:
 * 1. Distribute order.refundedAmount proportionately among line_items with qc_status == "QC Pass"
 * 2. Proportion = line_item.price / (sum of QC Pass line_items prices)
 * 3. If no items are QC Pass but refundedAmount exists, distribute among all line_items
 */
async function migrateRefundedAmountsHandler(storeId: string): Promise<{
  total: number;
  updated: number;
  skipped: number;
  noRefundAmount: number;
}> {
  console.log(`🔄 Starting refunded amounts migration for store: ${storeId}`);

  // Fetch all orders with "DTO Refunded" status
  const ordersSnapshot = await db
    .collection("accounts")
    .doc(storeId)
    .collection("orders")
    .where("customStatus", "==", "DTO Refunded")
    .get();

  console.log(`Found ${ordersSnapshot.size} orders with "DTO Refunded" status`);

  let updated = 0;
  let skipped = 0;
  let noRefundAmount = 0;
  const MAX_BATCH_SIZE = 500;
  let batch = db.batch();
  let batchCount = 0;

  for (const orderDoc of ordersSnapshot.docs) {
    const order = orderDoc.data();
    const refundedAmount = order.refundedAmount;
    const lineItems = order.raw?.line_items || [];

    // Skip if no refundedAmount
    if (!refundedAmount || refundedAmount <= 0) {
      noRefundAmount++;
      continue;
    }

    // Check if any line item already has refundedAmount set
    const hasExistingRefundAmounts = lineItems.some(
      (item: any) => item.refundedAmount !== undefined && item.refundedAmount > 0,
    );

    if (hasExistingRefundAmounts) {
      skipped++;
      continue;
    }

    // Find QC Pass items
    const qcPassItems = lineItems.filter((item: any) => item.qc_status === "QC Pass");

    // Determine which items to distribute among
    const itemsToDistribute = qcPassItems.length > 0 ? qcPassItems : lineItems;

    if (itemsToDistribute.length === 0) {
      console.warn(`Order ${orderDoc.id} has no line items to distribute refund to`);
      skipped++;
      continue;
    }

    // Calculate total price of items to distribute among
    const totalPrice = itemsToDistribute.reduce((sum: number, item: any) => {
      const itemPrice = parseFloat(item.price) * (item.quantity || 1);
      return sum + itemPrice;
    }, 0);

    if (totalPrice <= 0) {
      console.warn(`Order ${orderDoc.id} has zero total price for distribution`);
      skipped++;
      continue;
    }

    // Create a set of item IDs that should receive refund
    const itemsToDistributeIds = new Set(
      itemsToDistribute.map((item: any) => item.variant_id || item.id),
    );

    // Update line items with proportionate refundedAmount
    const updatedLineItems = lineItems.map((item: any) => {
      const itemId = item.variant_id || item.id;

      if (itemsToDistributeIds.has(itemId)) {
        const itemPrice = parseFloat(item.price) * (item.quantity || 1);
        const proportion = itemPrice / totalPrice;
        const itemRefundAmount = Math.round(refundedAmount * proportion * 100) / 100; // Round to 2 decimals

        return {
          ...item,
          refundedAmount: itemRefundAmount,
        };
      } else {
        // Item not in distribution set, set refundedAmount to 0
        return {
          ...item,
          refundedAmount: 0,
        };
      }
    });

    // Add to batch
    batch.update(orderDoc.ref, {
      "raw.line_items": updatedLineItems,
    });

    updated++;
    batchCount++;

    // Commit batch if we hit the limit
    if (batchCount >= MAX_BATCH_SIZE) {
      await batch.commit();
      console.log(`Committed batch of ${batchCount} updates`);
      batch = db.batch();
      batchCount = 0;
    }
  }

  // Commit remaining updates
  if (batchCount > 0) {
    await batch.commit();
    console.log(`Committed final batch of ${batchCount} updates`);
  }

  console.log(
    `✅ Migration complete: ${updated} updated, ${skipped} skipped, ${noRefundAmount} had no refund amount`,
  );

  return {
    total: ordersSnapshot.size,
    updated,
    skipped,
    noRefundAmount,
  };
}

/**
 * HTTP Cloud Function to trigger the migration via Postman
 *
 * Usage:
 * POST /migrateRefundedAmounts
 * Body: { "storeId": "your-store-id" }
 *
 * Or:
 * GET /migrateRefundedAmounts?storeId=your-store-id
 */
export const migrateRefundedAmounts = onRequest(
  { timeoutSeconds: 540, memory: "1GiB" },
  async (req, res) => {
    try {
      // Get storeId from query params or body
      const storeId = req.query.storeId || req.body?.storeId;

      if (!storeId || typeof storeId !== "string") {
        res.status(400).json({
          success: false,
          error: "Missing required parameter: storeId",
        });
        return;
      }

      // Verify the store exists
      const storeDoc = await db.collection("accounts").doc(storeId).get();
      if (!storeDoc.exists) {
        res.status(404).json({
          success: false,
          error: `Store not found: ${storeId}`,
        });
        return;
      }

      console.log(`🚀 Migration triggered for store: ${storeId}`);

      const result = await migrateRefundedAmountsHandler(storeId);

      res.status(200).json({
        success: true,
        message: "Migration completed successfully",
        data: result,
      });
    } catch (error) {
      console.error("Migration failed:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  },
);
