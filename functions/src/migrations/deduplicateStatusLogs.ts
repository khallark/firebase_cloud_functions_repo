import { onRequest } from "firebase-functions/v2/https";
import { DocumentReference, Timestamp } from "firebase-admin/firestore";
import { SHARED_STORE_IDS } from "../config";
import { db } from "../firebaseAdmin";

export const deduplicateStatusLogs = onRequest(
  { cors: true, memory: "4GiB", timeoutSeconds: 540 },
  async (req, res) => {
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;

    const allOrders: any[] = [];
    const seenIds = new Set<string>();

    await Promise.all(
      SHARED_STORE_IDS.map(async (storeId) => {
        const snap = await db.collection("accounts").doc(storeId).collection("orders").get();
        snap.forEach((doc) => {
          if (seenIds.has(doc.id)) return;
          seenIds.add(doc.id);
          allOrders.push({ id: doc.id, ref: doc.ref, storeId, ...doc.data() });
        });
      }),
    );

    const results: {
      orderId: string;
      orderName: string;
      storeId: string;
      duplicateStatuses: { status: string; count: number }[];
    }[] = [];

    const updates: { ref: DocumentReference; dedupedLogs: any[] }[] = [];

    for (const order of allOrders) {
      const logs: any[] = order.customStatusesLogs || [];
      if (logs.length === 0) continue;

      // Count occurrences of each status
      const statusCounts = new Map<string, number>();
      for (const log of logs) {
        if (!log.status) continue;
        if (log.status === "Updated By Shopify") continue;
        statusCounts.set(log.status, (statusCounts.get(log.status) || 0) + 1);
      }

      const duplicateStatuses = [...statusCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([status, count]) => ({ status, count }));

      if (duplicateStatuses.length === 0) continue;

      results.push({
        orderId: order.id,
        orderName: order.name ?? order.id,
        storeId: order.storeId,
        duplicateStatuses,
      });

      // For each status, keep only the log with the latest createdAt
      const latestByStatus = new Map<string, any>();
      for (const log of logs) {
        if (!log.status) continue;
        if (log.status === "Updated By Shopify") continue; // ignore
        const existing = latestByStatus.get(log.status);
        if (!existing) {
          latestByStatus.set(log.status, log);
          continue;
        }
        // Compare createdAt — both should be Timestamps
        const existingMs =
          existing.createdAt instanceof Timestamp ? existing.createdAt.toMillis() : 0;
        const currentMs = log.createdAt instanceof Timestamp ? log.createdAt.toMillis() : 0;
        if (currentMs > existingMs) {
          latestByStatus.set(log.status, log);
        }
      }

      // One entry per status (latest) + all Updated By Shopify/no-status logs, sorted by createdAt asc
      const dedupedLogs: any[] = [...latestByStatus.values()];

      for (const log of logs) {
        if (!log.status || log.status === "Updated By Shopify") {
          dedupedLogs.push(log);
        }
      }

      dedupedLogs.sort((a, b) => {
        const aMs = a.createdAt instanceof Timestamp ? a.createdAt.toMillis() : 0;
        const bMs = b.createdAt instanceof Timestamp ? b.createdAt.toMillis() : 0;
        return aMs - bMs;
      });

      updates.push({ ref: order.ref, dedupedLogs });
    }

    // Write in 499-op chunks
    if (!dryRun) {
      const CHUNK_SIZE = 499;
      for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
        const chunk = updates.slice(i, i + CHUNK_SIZE);
        const batch = db.batch();
        for (const update of chunk) {
          batch.update(update.ref, { customStatusesLogs: update.dedupedLogs });
        }
        await batch.commit();
        console.log(`💾 Committed batch ${Math.floor(i / CHUNK_SIZE) + 1}`);
      }
    }

    res.status(200).json({
      dryRun,
      totalAffected: results.length,
      updatedCount: updates.length,
      orders: results,
    });
  },
);
