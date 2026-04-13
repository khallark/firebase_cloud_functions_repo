import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { DocumentReference } from "firebase-admin/firestore";

const BATCH_SIZE = 499;

async function flushBatch(
  ops: Array<{ ref: DocumentReference; data: Record<string, any> }>,
  dryRun: boolean,
): Promise<void> {
  if (ops.length === 0) return;
  if (!dryRun) {
    const batch = db.batch();
    for (const { ref, data } of ops) {
      batch.update(ref, data);
    }
    await batch.commit();
  }
}

export const migrateCreditNoteRef = onRequest(
  { cors: true, timeoutSeconds: 3600, memory: "2GiB" },
  async (req, res) => {
    const businessId = (req.query.businessId as string) || req.body?.businessId;
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;

    if (!businessId) {
      res.status(400).json({ error: "businessId is required" });
      return;
    }

    const stats = {
      upcs: { found: 0, updated: 0 },
      upcLogs: { found: 0, updated: 0 },
      upcsLogs: { found: 0, updated: 0 },
    };

    // ── 1. users/{businessId}/upcs ───────────────────────────────────────
    const upcsSnap = await db.collection(`users/${businessId}/upcs`).get();
    stats.upcs.found = upcsSnap.size;

    let batch: Array<{ ref: DocumentReference; data: Record<string, any> }> = [];

    for (const upcDoc of upcsSnap.docs) {
      // Skip if already has the field
      if ("creditNoteRef" in upcDoc.data()) continue;

      batch.push({ ref: upcDoc.ref, data: { creditNoteRef: null } });
      stats.upcs.updated++;

      if (batch.length >= BATCH_SIZE) {
        await flushBatch(batch, dryRun);
        batch = [];
      }

      // ── 2. users/{businessId}/upcs/{upcId}/logs ──────────────────────
      const logsSnap = await upcDoc.ref.collection("logs").get();
      stats.upcLogs.found += logsSnap.size;

      let logBatch: Array<{ ref: DocumentReference; data: Record<string, any> }> = [];

      for (const logDoc of logsSnap.docs) {
        const data = logDoc.data();
        if (data?.snapshot?.creditNoteRef !== undefined) continue;

        logBatch.push({ ref: logDoc.ref, data: { "snapshot.creditNoteRef": null } });
        stats.upcLogs.updated++;

        if (logBatch.length >= BATCH_SIZE) {
          await flushBatch(logBatch, dryRun);
          logBatch = [];
        }
      }

      await flushBatch(logBatch, dryRun);
    }

    await flushBatch(batch, dryRun);

    // ── 3. users/{businessId}/upcsLogs ──────────────────────────────────
    const upcsLogsSnap = await db.collection(`users/${businessId}/upcsLogs`).get();
    stats.upcsLogs.found = upcsLogsSnap.size;

    let upcsLogsBatch: Array<{ ref: DocumentReference; data: Record<string, any> }> = [];

    for (const doc of upcsLogsSnap.docs) {
      const data = doc.data();
      if (data?.snapshot?.creditNoteRef !== undefined) continue;

      upcsLogsBatch.push({ ref: doc.ref, data: { "snapshot.creditNoteRef": null } });
      stats.upcsLogs.updated++;

      if (upcsLogsBatch.length >= BATCH_SIZE) {
        await flushBatch(upcsLogsBatch, dryRun);
        upcsLogsBatch = [];
      }
    }

    await flushBatch(upcsLogsBatch, dryRun);

    res.status(200).json({ dryRun, ...stats });
  },
);