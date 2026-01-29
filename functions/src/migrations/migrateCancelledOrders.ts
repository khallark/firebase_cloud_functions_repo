// import { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { db } from "../firebaseAdmin";
import { ENQUEUE_FUNCTION_SECRET } from "../config";
import { onRequest } from "firebase-functions/v2/https";
// import { requireHeaderSecret, sleep } from "../helpers";
// import { MigrationStats } from "./commons";

// async function migrateCancelledOrders(accountId: string): Promise<{
//   scanned: number;
//   updated: number;
//   skipped: number;
// }> {
//   const BATCH_SIZE = 500; // Firestore batch write limit
//   let scanned = 0;
//   let updated = 0;
//   let skipped = 0;
//   let lastDoc: QueryDocumentSnapshot | null = null;

//   while (true) {
//     // Query orders in chunks
//     let query = db.collection("accounts").doc(accountId).collection("orders").limit(BATCH_SIZE);

//     if (lastDoc) {
//       query = query.startAfter(lastDoc);
//     }

//     const snapshot = await query.get();

//     if (snapshot.empty) {
//       break; // No more orders
//     }

//     // Process this batch
//     const batch = db.batch();
//     let batchCount = 0;

//     for (const doc of snapshot.docs) {
//       scanned++;
//       const data = doc.data();

//       // Check if order is cancelled on Shopify
//       const isCancelled = data.raw?.cancelled_at !== null && data.raw?.cancelled_at !== undefined;

//       // Skip if not cancelled or already has Cancelled status
//       if (!isCancelled || data.customStatus === "Cancelled") {
//         skipped++;
//         continue;
//       }

//       // Update to Cancelled status
//       batch.update(doc.ref, {
//         customStatus: "Cancelled",
//       });
//       batchCount++;
//       updated++;
//     }

//     // Commit batch if there are updates
//     if (batchCount > 0) {
//       await batch.commit();
//       console.log(`  💾 Committed batch: ${batchCount} orders updated to Cancelled`);
//     }

//     lastDoc = snapshot.docs[snapshot.docs.length - 1];

//     // Progress update
//     if (scanned % 1000 === 0) {
//       console.log(`  📈 Progress: ${scanned} scanned, ${updated} updated`);
//     }
//   }

//   return { scanned, updated, skipped };
// }

export const migrateCancelledOrdersStatus = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req, res) => {
    // try {
    //   console.log(req);
    //   console.log("Starting order status reset...");

    //   const orders = [
    //     6147352461451, 6239170429067, 6278792577163, 6280347877515, 6280350859403, 6280531804299,
    //     6281932013707, 6285867548811, 6287443918987, 6289033658507, 6289723228299, 6290463195275,
    //     6290724913291, 6290828230795, 6290900287627, 6291694387339,
    //   ];

    //   const orders2 = [
    //     10620372713766, 10620394111270, 10620401844518, 10620404269350, 10620462727462,
    //     10620464365862, 10620466987302, 10620467806502, 10620474065190, 10620478587174,
    //     10620543369510, 10620553003302, 10620575744294, 10620580462886, 10620587376934,
    //     10620589048102, 10620589801766, 10620609757478, 10620644917542, 10620650389798,
    //     10620743450918, 10620754592038, 10620816621862, 10620816654630, 10620862464294,
    //     10620872032550, 10620903981350, 10620904309030, 10620957229350, 10620979282214,
    //     10620997992742, 10620998484262, 10621003268390, 10621023519014, 10621037773094,
    //     10621083353382, 10621086564646, 10621099606310, 10621117038886, 10621119234342,
    //     10621216588070, 10621508190502, 10621726130470, 10621921788198, 10621971726630,
    //     10621985915174, 10621988012326, 10621989749030, 10621995122982, 10621998858534,
    //     10621999087910, 10622037131558,
    //   ];

    //   // Helper function to chunk arrays
    //   const chunkArray = (arr: number[], size: number) => {
    //     const chunks = [];
    //     for (let i = 0; i < arr.length; i += size) {
    //       chunks.push(arr.slice(i, i + size));
    //     }
    //     return chunks;
    //   };

    //   const batch = db.batch();
    //   let nfkjgpCount = 0;
    //   let gj9ejgCount = 0;

    //   // Process shop 1 in chunks of 10
    //   console.log(`Processing ${orders.length} orders for nfkjgp-sv.myshopify.com...`);
    //   const orders1Chunks = chunkArray(orders, 10);

    //   for (const chunk of orders1Chunks) {
    //     const snapshot = await db
    //       .collection("accounts/nfkjgp-sv.myshopify.com/orders")
    //       .where("orderId", "in", chunk)
    //       .get();

    //     console.log(`  Found ${snapshot.size}/${chunk.length} orders in chunk`);

    //     snapshot.docs.forEach((doc) => {
    //       batch.update(doc.ref, {
    //         customStatus: "Dispatched",
    //       });
    //       nfkjgpCount++;
    //     });
    //   }

    //   // Process shop 2 in chunks of 10
    //   console.log(`Processing ${orders2.length} orders for gj9ejg-cu.myshopify.com...`);
    //   const orders2Chunks = chunkArray(orders2, 10);

    //   for (const chunk of orders2Chunks) {
    //     const snapshot = await db
    //       .collection("accounts/gj9ejg-cu.myshopify.com/orders")
    //       .where("orderId", "in", chunk)
    //       .get();

    //     console.log(`  Found ${snapshot.size}/${chunk.length} orders in chunk`);

    //     snapshot.docs.forEach((doc) => {
    //       batch.update(doc.ref, {
    //         customStatus: "Dispatched",
    //       });
    //       gj9ejgCount++;
    //     });
    //   }

    //   const totalUpdates = nfkjgpCount + gj9ejgCount;

    //   if (totalUpdates === 0) {
    //     console.log("⚠️ No orders found to update");
    //     res.status(200).json({
    //       success: false,
    //       message: "No orders found",
    //     });
    //     return;
    //   }

    //   console.log(`Committing batch with ${totalUpdates} updates...`);
    //   await batch.commit();

    //   console.log(`✅ Successfully updated ${totalUpdates} orders to "Dispatched"`);

    //   res.status(200).json({
    //     success: true,
    //     updatedCount: totalUpdates,
    //     nfkjgpCount: nfkjgpCount,
    //     gj9ejgCount: gj9ejgCount,
    //   });
    // } catch (error: any) {
    //   console.error("Error updating orders:", error.message);
    //   console.error(error);
    //   res.status(200).json({
    //     success: false,
    //     error: error.message,
    //   });
    // }
    try {
      console.log(req);
      const productsColl = await db.collection("users/2yEGCC8AffNxDoTZEqhAkCRgxNl2/products").get();
      let resp: any;
      for (const doc of productsColl.docs) {
        const coll = await db
          .collection("users/2yEGCC8AffNxDoTZEqhAkCRgxNl2/upcs")
          .where("productId", "==", doc.data()?.sku)
          .get();
        if (Number(doc.data().inventory.inwardAddition) !== coll.docs.length) {
          resp = {
            ...resp,
            [doc.data()?.sku]: Number(doc.data().inventory.inwardAddition) - coll.docs.length,
          };
        }
      }
      // console.log(coll.docs.length);
      res.status(200).json(resp);
    } catch (error: any) {
      console.error(error.message);
      res.status(200).json({
        success: false,
      });
    }
    // try {
    //   // Add secret protection
    //   requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

    //   console.log("🚀 Starting Cancelled Orders Status Migration...\n");

    //   const stats: MigrationStats = {
    //     accountsProcessed: 0,
    //     ordersScanned: 0,
    //     ordersUpdated: 0,
    //     ordersSkipped: 0,
    //     errors: 0,
    //   };

    //   try {
    //     // Get all accounts
    //     const accountsSnapshot = await db.collection("accounts").get();
    //     console.log(`Found ${accountsSnapshot.size} accounts to process\n`);

    //     // Process each account
    //     for (const accountDoc of accountsSnapshot.docs) {
    //       const accountId = accountDoc.id;
    //       console.log(`\n📦 Processing account: ${accountId}`);

    //       try {
    //         const accountStats = await migrateCancelledOrders(accountId);
    //         stats.accountsProcessed++;
    //         stats.ordersScanned += accountStats.scanned;
    //         stats.ordersUpdated += accountStats.updated;
    //         stats.ordersSkipped += accountStats.skipped;

    //         console.log(
    //           `  ✅ Account completed: ${accountStats.updated} updated, ${accountStats.skipped} skipped`,
    //         );
    //       } catch (error) {
    //         stats.errors++;
    //         console.error(`  ❌ Error processing account ${accountId}:`, error);
    //       }

    //       // Small delay between accounts to avoid rate limits
    //       await sleep(100);
    //     }

    //     // Print final summary
    //     console.log("\n" + "=".repeat(60));
    //     console.log("📊 MIGRATION SUMMARY");
    //     console.log("=".repeat(60));
    //     console.log(`Accounts processed: ${stats.accountsProcessed}`);
    //     console.log(`Orders scanned:     ${stats.ordersScanned}`);
    //     console.log(`Orders updated:     ${stats.ordersUpdated}`);
    //     console.log(`Orders skipped:     ${stats.ordersSkipped}`);
    //     console.log(`Errors:             ${stats.errors}`);
    //     console.log("=".repeat(60));
    //     console.log("✨ Migration completed!\n");

    //     res.json({
    //       success: true,
    //       summary: stats,
    //       message: "Cancelled orders migration completed successfully",
    //     });
    //   } catch (error) {
    //     console.error("\n❌ Migration failed:", error);
    //     res.status(500).json({
    //       success: false,
    //       error: error instanceof Error ? error.message : String(error),
    //       stats,
    //     });
    //   }
    // } catch (authError) {
    //   res.status(401).json({ error: `Unauthorized ${authError}` });
    // }
  },
);
