// migrations/migrateCreatedAtToTimestamp.ts

import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { Timestamp } from "firebase-admin/firestore";
import { ENQUEUE_FUNCTION_SECRET, SHARED_STORE_ID } from "../config";
import { requireHeaderSecret } from "../helpers";

/**
 * Migrates createdAt field from ISO string to Firestore Timestamp
 * for all orders in the shared store
 *
 * Usage:
 * POST https://your-function-url/migrateCreatedAtToTimestamp
 * Headers: { "x-migration-key": "your-secret-key" }
 * Body: { "dryRun": true } // Optional: test without writing
 */
export const migrateCreatedAtToTimestamp = onRequest(
  {
    cors: true,
    timeoutSeconds: 540, // 9 minutes (max for Cloud Functions)
    memory: "512MiB",
    secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req, res) => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      const dryRun = req.body?.dryRun === true;

      console.log(`🚀 Starting migration (dryRun: ${dryRun})...`);

      // Fetch all orders from shared store
      const ordersRef = db.collection("accounts").doc(SHARED_STORE_ID).collection("orders");

      const snapshot = await ordersRef.get();
      const totalOrders = snapshot.size;

      console.log(`📦 Found ${totalOrders} total orders`);

      // Statistics
      let needsMigration = 0;
      let alreadyTimestamp = 0;
      let invalidDates = 0;
      let migrated = 0;
      const errors: Array<{ orderId: string; error: string }> = [];

      // Process in batches of 500 (Firestore batch limit)
      const BATCH_SIZE = 500;
      let batch = db.batch();
      let batchCount = 0;
      let totalBatches = 0;

      for (const doc of snapshot.docs) {
        const data = doc.data();
        const orderId = doc.id;
        const orderName = data.name || orderId;

        try {
          // Check if createdAt exists
          if (!data.createdAt) {
            console.warn(`⚠️  Order ${orderName} has no createdAt field`);
            invalidDates++;
            continue;
          }

          // Check if already a Timestamp
          if (data.createdAt?.toDate && typeof data.createdAt.toDate === "function") {
            alreadyTimestamp++;
            continue;
          }

          // Check if it's a string
          if (typeof data.createdAt === "string") {
            needsMigration++;

            // Parse the ISO string
            const date = new Date(data.createdAt);

            // Validate the date
            if (isNaN(date.getTime())) {
              console.error(`❌ Order ${orderName} has invalid date: ${data.createdAt}`);
              invalidDates++;
              errors.push({
                orderId: orderName,
                error: `Invalid date: ${data.createdAt}`,
              });
              continue;
            }

            // Convert to Firestore Timestamp
            const timestamp = Timestamp.fromDate(date);

            if (!dryRun) {
              // Add to batch
              batch.update(doc.ref, {
                createdAt: timestamp,
              });

              batchCount++;
              migrated++;

              // Commit batch when it reaches 500
              if (batchCount >= BATCH_SIZE) {
                await batch.commit();
                totalBatches++;
                console.log(`✅ Committed batch ${totalBatches} (${migrated} orders)`);

                // Create new batch
                batch = db.batch();
                batchCount = 0;
              }
            } else {
              // Dry run: just count
              migrated++;

              // Log sample conversions (first 10)
              if (migrated <= 10) {
                console.log(`🔄 Would migrate ${orderName}:`, {
                  from: data.createdAt,
                  to: timestamp.toDate().toISOString(),
                });
              }
            }
          }
        } catch (error: any) {
          console.error(`❌ Error processing order ${orderName}:`, error);
          errors.push({
            orderId: orderName,
            error: error.message || String(error),
          });
        }
      }

      // Commit remaining batch
      if (!dryRun && batchCount > 0) {
        await batch.commit();
        totalBatches++;
        console.log(`✅ Committed final batch ${totalBatches}`);
      }

      // Summary
      const summary = {
        success: true,
        dryRun,
        totalOrders,
        alreadyTimestamp,
        needsMigration,
        migrated: dryRun ? 0 : migrated,
        wouldMigrate: dryRun ? migrated : 0,
        invalidDates,
        errors: errors.length > 0 ? errors : undefined,
        batchesCommitted: dryRun ? 0 : totalBatches,
      };

      console.log("📊 Migration Summary:", summary);

      res.json(summary);
    } catch (error: any) {
      console.error("💥 Migration failed:", error);
      res.status(500).json({
        success: false,
        error: error.message || String(error),
      });
    }
  },
);
