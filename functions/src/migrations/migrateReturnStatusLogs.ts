import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { RETURN_STATUSES } from "../config";
import { Timestamp } from "firebase-admin/firestore";

/**
 * Migration function to backfill customStatusesLogs for orders
 * that reached a return status before the logging system was introduced.
 */
async function migrateReturnStatusLogsHandler(storeId: string): Promise<{
  total: number;
  updated: number;
  skipped: number;
}> {
  console.log(`🔄 Starting return status logs migration for store: ${storeId}`);

  // Fetch all orders with return statuses
  const ordersSnapshot = await db
    .collection("accounts")
    .doc(storeId)
    .collection("orders")
    .where("customStatus", "in", Array.from(RETURN_STATUSES))
    .get();

  console.log(`Found ${ordersSnapshot.size} orders with return statuses`);

  let updated = 0;
  let skipped = 0;
  const MAX_BATCH_SIZE = 500;
  let batch = db.batch();
  let batchCount = 0;

  for (const orderDoc of ordersSnapshot.docs) {
    const order = orderDoc.data();
    const customStatusesLogs = order.customStatusesLogs || [];
    const currentStatus = order.customStatus;

    // Check if there's already a log for the current return status
    const hasLogForStatus = customStatusesLogs.some((log: any) => log.status === currentStatus);

    if (hasLogForStatus) {
      skipped++;
      continue;
    }

    // Calculate T + 7 days from order creation
    const orderCreatedAt = new Date(order.createdAt);
    const estimatedStatusDate = new Date(orderCreatedAt);
    estimatedStatusDate.setDate(estimatedStatusDate.getDate() + 7);

    // Create the new log entry
    const newLog = {
      createdAt: Timestamp.fromDate(estimatedStatusDate),
      status: currentStatus,
      remarks: "Migrated: estimated date (order created + 7 days)",
    };

    // Add to batch
    batch.update(orderDoc.ref, {
      customStatusesLogs: [...customStatusesLogs, newLog],
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

  console.log(`✅ Migration complete: ${updated} updated, ${skipped} skipped`);

  return {
    total: ordersSnapshot.size,
    updated,
    skipped,
  };
}

/**
 * HTTP Cloud Function to trigger the migration via Postman
 *
 * Usage:
 * POST /migrateReturnStatusLogs
 * Body: { "storeId": "your-store-id" }
 *
 * Or:
 * GET /migrateReturnStatusLogs?storeId=your-store-id
 */
export const migrateReturnStatusLogs = onRequest(
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

      const result = await migrateReturnStatusLogsHandler(storeId);

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
