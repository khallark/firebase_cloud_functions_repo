import { onRequest } from "firebase-functions/v2/https";
import { DocumentReference, Timestamp } from "firebase-admin/firestore";
import { SHARED_STORE_IDS } from "../config";
import { db } from "../firebaseAdmin";

export const deduplicateCancelledLogs = onRequest(
  { cors: true, memory: "4GiB", timeoutSeconds: 540 },
  async (req, res) => {
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;

    // ── 1. Fetch all Cancelled orders across all stores ──────────────────────
    const allOrders: any[] = [];
    const seenIds = new Set<string>();

    await Promise.all(
      SHARED_STORE_IDS.map(async (storeId) => {
        const snap = await db
          .collection("accounts")
          .doc(storeId)
          .collection("orders")
          .where("customStatus", "==", "Cancelled")
          .get();
        snap.forEach((doc) => {
          if (seenIds.has(doc.id)) return;
          seenIds.add(doc.id);
          allOrders.push({ id: doc.id, ref: doc.ref, storeId, ...doc.data() });
        });
      }),
    );

    console.log(`Fetched ${allOrders.length} cancelled orders across ${SHARED_STORE_IDS.length} stores`);

    // ── 2. Identify orders with duplicate Cancelled logs ─────────────────────
    const results: {
      orderId: string;
      orderName: string;
      storeId: string;
      cancelledLogCount: number;
      earliestCancelledAt: string;
    }[] = [];

    const updates: {
      ref: DocumentReference;
      dedupedLogs: any[];
      firstCancelledAt: Timestamp;
    }[] = [];

    for (const order of allOrders) {
      const logs: any[] = order.customStatusesLogs || [];
      if (logs.length === 0) continue;

      // Isolate only the Cancelled logs
      const cancelledLogs = logs.filter((log) => log.status === "Cancelled");

      // Only care about orders with more than one Cancelled log
      if (cancelledLogs.length <= 1) continue;

      // Find the earliest Cancelled log by createdAt
      const sortedCancelledLogs = [...cancelledLogs].sort((a, b) => {
        const aMs = a.createdAt instanceof Timestamp ? a.createdAt.toMillis() : 0;
        const bMs = b.createdAt instanceof Timestamp ? b.createdAt.toMillis() : 0;
        return aMs - bMs; // ascending — first ever comes first
      });

      const firstCancelledLog = sortedCancelledLogs[0];
      const firstCancelledAt =
        firstCancelledLog.createdAt instanceof Timestamp
          ? firstCancelledLog.createdAt
          : Timestamp.now();

      // Build deduped logs: all non-Cancelled logs + only the first Cancelled log
      const nonCancelledLogs = logs.filter((log) => log.status !== "Cancelled");
      const dedupedLogs = [...nonCancelledLogs, firstCancelledLog].sort((a, b) => {
        const aMs = a.createdAt instanceof Timestamp ? a.createdAt.toMillis() : 0;
        const bMs = b.createdAt instanceof Timestamp ? b.createdAt.toMillis() : 0;
        return aMs - bMs;
      });

      results.push({
        orderId: order.id,
        orderName: order.name ?? order.id,
        storeId: order.storeId,
        cancelledLogCount: cancelledLogs.length,
        earliestCancelledAt: firstCancelledAt.toDate().toISOString(),
      });

      updates.push({ ref: order.ref, dedupedLogs, firstCancelledAt });
    }

    // ── 3. Write in 499-op chunks ─────────────────────────────────────────────
    // Each order = 1 update op (logs + lastStatusUpdate written together)
    if (!dryRun) {
      const CHUNK_SIZE = 499;
      for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
        const chunk = updates.slice(i, i + CHUNK_SIZE);
        const batch = db.batch();
        for (const update of chunk) {
          batch.update(update.ref, {
            customStatusesLogs: update.dedupedLogs,
            lastStatusUpdate: update.firstCancelledAt,
          });
        }
        await batch.commit();
        console.log(`Committed batch ${Math.floor(i / CHUNK_SIZE) + 1}`);
      }
    }

    res.status(200).json({
      dryRun,
      totalScanned: allOrders.length,
      totalAffected: results.length,
      orders: results,
    });
  },
);