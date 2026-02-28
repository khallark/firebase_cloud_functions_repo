// import { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { db } from "../firebaseAdmin";
import { SHARED_STORE_ID, SHARED_STORE_ID_2 } from "../config";
import { onRequest } from "firebase-functions/v2/https";
import { QueryDocumentSnapshot, Timestamp } from "firebase-admin/firestore";
// import { requireHeaderSecret, sleep } from "../helpers";
// import { MigrationStats } from "./commons";

interface StatusLog {
  status: string;
  createdAt: Timestamp;
  [key: string]: unknown;
}

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
  },
  async (req, res) => {
    try {
      const [store1snapshot, store2snapshot] = await Promise.all([
        db
          .collection(`accounts/${SHARED_STORE_ID}/orders`)
          .where("customStatus", "==", "Cancelled")
          .get(),
        db
          .collection(`accounts/${SHARED_STORE_ID_2}/orders`)
          .where("customStatus", "==", "Cancelled")
          .get(),
      ]);

      const batch = db.batch();
      const ordersWithNoLog: { name: string; storeId: string }[] = [];
      let batchCount = 0;
      const batches = [batch];

      const processDoc = (
        doc: QueryDocumentSnapshot,
        storeId: string
      ) => {
        const data = doc.data();

        // Already has lastStatusUpdate, nothing to do
        if (data.lastStatusUpdate) return;

        const logs: StatusLog[] = data.customStatusesLogs ?? [];
        const cancelledLog = logs.find((log) => log.status === "Cancelled");

        if (!cancelledLog) {
          // No cancelled log found — collect for reporting
          ordersWithNoLog.push({
            name: data.name ?? doc.id,
            storeId,
          });
          return;
        }

        // Firestore batch has a 500 op limit — create new batch if needed
        if (batchCount > 0 && batchCount % 499 === 0) {
          batches.push(db.batch());
        }

        const currentBatch = batches[batches.length - 1];
        currentBatch.update(doc.ref, {
          lastStatusUpdate: cancelledLog.createdAt,
        });
        batchCount++;
      };

      for (const doc of store1snapshot.docs) processDoc(doc, SHARED_STORE_ID);
      for (const doc of store2snapshot.docs) processDoc(doc, SHARED_STORE_ID_2);

      // Commit all batches sequentially
      for (const b of batches) {
        await b.commit();
      }

      res.status(200).json({
        success: true,
        updatedCount: batchCount,
        ordersWithNoCancelledLog: ordersWithNoLog,
        noLogCount: ordersWithNoLog.length,
      });
    } catch (error: any) {
      console.error("Error:", error.message);
      console.error(error);
      res.status(200).json({
        success: false,
        error: error.message,
      });
    }
  }
);
