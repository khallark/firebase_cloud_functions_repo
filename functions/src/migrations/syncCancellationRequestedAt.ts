import { onRequest } from "firebase-functions/v2/https";
import { DocumentReference, Timestamp } from "firebase-admin/firestore";
import { SHARED_STORE_IDS } from "../config";
import { db } from "../firebaseAdmin";

export const syncCancellationRequestedAt = onRequest(
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
          .where("customStatus", "in", ["Cancellation Requested", "Cancelled"])
          .get();

        snap.forEach((doc) => {
          if (seenIds.has(doc.id)) return;
          seenIds.add(doc.id);
          allOrders.push({ id: doc.id, ref: doc.ref, ...doc.data() });
        });
      }),
    );

    console.log(`📦 Total Cancellation Requested / Cancelled orders: ${allOrders.length}`);

    const updates: { ref: DocumentReference; cancellationRequestedAt: Timestamp }[] = [];
    const missingLogOrders: { orderId: string; orderName: string; customStatus: string }[] = [];

    for (const order of allOrders) {
      if (order.cancellationRequestedAt instanceof Timestamp) continue;

      const logs: any[] = order.customStatusesLogs || [];

      const cancellationLog = logs
        .filter(
          (log) => log.status === "Cancellation Requested" && log.createdAt instanceof Timestamp,
        )
        .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())[0];

      if (!cancellationLog) {
        if (order.customStatus === "Cancelled") {
          missingLogOrders.push({
            orderId: order.id,
            orderName: order.name ?? order.id,
            customStatus: order.customStatus,
          });
        }
        continue;
      }

      updates.push({ ref: order.ref, cancellationRequestedAt: cancellationLog.createdAt });
    }

    console.log(`📝 Updates to apply: ${updates.length}`);
    console.log(`⚠️ Orders missing Cancellation Requested log: ${missingLogOrders.length}`);

    if (!dryRun) {
      const CHUNK_SIZE = 499;
      for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
        const chunk = updates.slice(i, i + CHUNK_SIZE);
        const batch = db.batch();
        for (const update of chunk) {
          batch.update(update.ref, { cancellationRequestedAt: update.cancellationRequestedAt });
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
