import { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { db } from "../firebaseAdmin";
import { ENQUEUE_FUNCTION_SECRET } from "../config";
import { onRequest } from "firebase-functions/v2/https";
import { MigrationStats } from "./commons";
import { requireHeaderSecret, sleep } from "../helpers";

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
    secrets: [ENQUEUE_FUNCTION_SECRET], // Add secret protection
  },
  async (req, res) => {
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
