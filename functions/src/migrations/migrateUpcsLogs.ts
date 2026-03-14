import { onRequest } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firebaseAdmin";
import type { UPC } from "../config/types";

export const migrateUpcsLogs = onRequest(
  { cors: true, memory: "4GiB", timeoutSeconds: 3600 },
  async (req, res) => {
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;
    const { businessId } = req.body;

    if (!businessId) {
      res.status(400).json({ error: "businessId is required" });
      return;
    }

    const upcsRef = db.collection(`users/${businessId}/upcs`);
    const upcsSnap = await upcsRef.get();

    console.log(`📦 Total UPCs: ${upcsSnap.size}`);

    let totalLogs = 0;
    let totalWritten = 0;
    let totalSkipped = 0;

    // Process UPCs in chunks to avoid memory pressure
    const UPCBATCH_SIZE = 100;
    const upcDocs = upcsSnap.docs;

    for (let i = 0; i < upcDocs.length; i += UPCBATCH_SIZE) {
      const chunk = upcDocs.slice(i, i + UPCBATCH_SIZE);

      // Fetch all logs subcollections in parallel for this chunk
      const logsPerUpc = await Promise.all(
        chunk.map(async (upcDoc) => {
          const upc = upcDoc.data() as UPC;
          const logsSnap = await upcDoc.ref.collection("logs").get();
          return {
            upcId: upcDoc.id,
            productId: upc.productId,
            grnRef: upc.grnRef,
            logs: logsSnap.docs,
          };
        }),
      );

      // Collect all flat log writes
      const writes: { docId: string; data: Record<string, any> }[] = [];

      for (const { upcId, grnRef, logs, productId } of logsPerUpc) {
        totalLogs += logs.length;
        for (const logDoc of logs) {
          const logData = logDoc.data() as { timestamp: Timestamp; snapshot: any };
          writes.push({
            docId: logDoc.id,
            data: {
              ...logData,
              upcId,
              productId,
              grnRef,
            },
          });
        }
      }

      // Write to flat upcsLogs collection in 499-op batches
      if (!dryRun) {
        const CHUNK_SIZE = 499;
        const flatLogsRef = db.collection(`users/${businessId}/upcsLogs`);

        for (let j = 0; j < writes.length; j += CHUNK_SIZE) {
          const writeChunk = writes.slice(j, j + CHUNK_SIZE);
          const batch = db.batch();
          for (const write of writeChunk) {
            // Use the original log doc ID as the flat log doc ID to make this idempotent
            batch.set(flatLogsRef.doc(write.docId), write.data);
          }
          await batch.commit();
          totalWritten += writeChunk.length;
        }
      } else {
        totalSkipped += writes.length;
      }

      console.log(
        `✅ Processed UPC chunk ${Math.floor(i / UPCBATCH_SIZE) + 1}/${Math.ceil(upcDocs.length / UPCBATCH_SIZE)}`,
      );
    }

    res.status(200).json({
      success: true,
      dryRun,
      totalUpcs: upcsSnap.size,
      totalLogs,
      totalWritten: dryRun ? 0 : totalWritten,
      totalWouldWrite: dryRun ? totalSkipped : undefined,
    });
  },
);
