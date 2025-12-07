// ============================================================================
// MIGRATION: ADD VENDORS ARRAY FIELD
// ============================================================================

import { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { ENQUEUE_FUNCTION_SECRET } from "../config";
import { requireHeaderSecret, sleep } from "../helpers";
import { MigrationStats } from "./commons";

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
    secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req, res) => {
    try {
      // Validate secret
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      console.log("🚀 Starting Vendors Field Migration...\n");

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
