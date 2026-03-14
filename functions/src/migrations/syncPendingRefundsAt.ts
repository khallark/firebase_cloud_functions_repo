import { onRequest } from "firebase-functions/v2/https";
import { DocumentReference, Timestamp } from "firebase-admin/firestore";
import { SHARED_STORE_IDS } from "../config";
import { db } from "../firebaseAdmin";

export const syncPendingRefundsAt = onRequest(
  { cors: true, timeoutSeconds: 540 },
  async (req, res) => {
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;

    const allOrders: any[] = [];
    const seenIds = new Set<string>();

    await Promise.all(
      SHARED_STORE_IDS.map(async (storeId) => {
        const snap = await db
          .collection("accounts")
          .doc(storeId)
          .collection("orders")
          .where("customStatus", "in", ["Pending Refunds", "DTO Refunded"])
          .get();

        snap.forEach((doc) => {
          if (seenIds.has(doc.id)) return;
          seenIds.add(doc.id);
          allOrders.push({ id: doc.id, ref: doc.ref, ...doc.data() });
        });
      }),
    );

    console.log(`📦 Total Pending Refunds / DTO Refunded orders: ${allOrders.length}`);

    const updates: { ref: DocumentReference; pendingRefundsAt: Timestamp }[] = [];
    const missingLogOrders: { orderId: string; orderName: string; customStatus: string }[] = [];

    for (const order of allOrders) {
      const logs: any[] = order.customStatusesLogs || [];

      const pendingRefundsLog = logs.find(
        (log) => log.status === "Pending Refunds" && log.createdAt instanceof Timestamp,
      );

      if (!pendingRefundsLog) {
        missingLogOrders.push({
          orderId: order.id,
          orderName: order.name ?? order.id,
          customStatus: order.customStatus,
        });
        continue;
      }

      updates.push({ ref: order.ref, pendingRefundsAt: pendingRefundsLog.createdAt });
    }

    console.log(`📝 Updates to apply: ${updates.length}`);
    console.log(`⚠️ Orders missing Pending Refunds log: ${missingLogOrders.length}`);

    if (!dryRun) {
      const CHUNK_SIZE = 499;
      for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
        const chunk = updates.slice(i, i + CHUNK_SIZE);
        const batch = db.batch();
        for (const update of chunk) {
          batch.update(update.ref, { pendingRefundsAt: update.pendingRefundsAt });
        }
        await batch.commit();
        console.log(`💾 Committed batch ${Math.floor(i / CHUNK_SIZE) + 1}`);
      }
    }

    res.status(200).json({
      success: true,
      dryRun,
      totalOrders: allOrders.length,
      updatedCount: updates.length,
      missingLogCount: missingLogOrders.length,
      missingLogOrders,
    });
  },
);
