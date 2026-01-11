// propagationTasks.ts
import { onRequest } from "firebase-functions/v2/https";
import { DocumentReference, FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebaseAdmin";
import { batchedUpdate } from "./helpers";
import type { PropagationTask, PropagationTracker, Shelf, Rack, Zone } from "../../config/types";
import { TASKS_SECRET } from "../../config";
import { requireHeaderSecret } from "../../helpers";

export const processPropagationTask = onRequest(
  {
    timeoutSeconds: 540,
    memory: "512MiB",
    cors: false,
    secrets: [TASKS_SECRET],
  },
  async (req, res) => {
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value()!);

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const task: PropagationTask =
        typeof req.body === "string"
          ? JSON.parse(Buffer.from(req.body, "base64").toString("utf8"))
          : (req.body as PropagationTask);

      console.log(
        `Processing ${task.type} chunk ${task.chunkIndex}/${task.totalChunks} for ${task.entityId}`,
      );

      switch (task.type) {
        case "shelf-location":
          await processShelfLocationChunk(task);
          break;
        case "rack-location":
          await processRackLocationChunk(task);
          break;
        case "zone-location":
          await processZoneLocationChunk(task);
          break;
        default:
          throw new Error(`Unknown task type: ${(task as any).type}`);
      }

      res.status(200).send("OK");
    } catch (error: any) {
      console.error("Task processing failed:", error);
      res.status(500).send(`Task failed: ${error.message}`);
    }
  },
);

// ============================================================================
// HELPERS
// ============================================================================

async function completeChunkTransaction(trackerRef: DocumentReference, processedDocs: number) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(trackerRef);
    const tracker = snap.data() as PropagationTracker;

    if (!tracker || tracker.status !== "in_progress") return;

    const newCompleted = tracker.chunksCompleted + 1;

    tx.update(trackerRef, {
      chunksCompleted: newCompleted,
      processedDocuments: FieldValue.increment(processedDocs),
    });

    if (newCompleted === tracker.chunksTotal) {
      tx.update(trackerRef, {
        status: "completed",
        completedAt: Timestamp.now(),
      });
    }
  });
}

// ============================================================================
// CHUNK PROCESSORS
// ============================================================================

async function processShelfLocationChunk(task: PropagationTask) {
  const {
    businessId,
    entityId: shelfId,
    data,
    chunkIndex,
    chunkSize,
    propagationId,
    version,
  } = task;

  const trackerRef = db.doc(`users/${businessId}/propagation_trackers/${propagationId}`);

  let affectedCount = 0;

  try {
    if (version !== undefined) {
      const shelfSnap = await db.doc(`users/${businessId}/shelves/${shelfId}`).get();

      if (!shelfSnap.exists) {
        await trackerRef.update({
          status: "obsolete",
          completedAt: Timestamp.now(),
        });
        return;
      }

      const shelfData = shelfSnap.data() as Shelf;
      if (shelfData.locationVersion !== version) {
        await trackerRef.update({
          status: "obsolete",
          completedAt: Timestamp.now(),
        });
        return;
      }
    }

    const offset = chunkIndex * chunkSize;

    const docs = await db
      .collection(`users/${businessId}/${data.collection}`)
      .where("shelfId", "==", shelfId)
      .orderBy("__name__")
      .offset(offset)
      .limit(chunkSize)
      .get();

    affectedCount = docs.size;

    if (docs.empty) {
      await completeChunkTransaction(trackerRef, 0);
      return;
    }

    await batchedUpdate(
      docs.docs.map((doc) => ({
        ref: doc.ref,
        data: {
          rackId: data.rackId,
          zoneId: data.zoneId,
          warehouseId: data.warehouseId,
        },
      })),
    );

    await completeChunkTransaction(trackerRef, docs.size);
  } catch (error: any) {
    console.error(`Shelf chunk ${chunkIndex} failed:`, error);

    await trackerRef.update({
      chunksFailed: FieldValue.increment(1),
      failedDocuments: FieldValue.increment(affectedCount),
      lastError: error.message,
      status: "failed",
    });

    throw error;
  }
}

async function processRackLocationChunk(task: PropagationTask) {
  const {
    businessId,
    entityId: rackId,
    data,
    chunkIndex,
    chunkSize,
    propagationId,
    version,
  } = task;

  const trackerRef = db.doc(`users/${businessId}/propagation_trackers/${propagationId}`);

  let affectedCount = 0;

  try {
    if (version !== undefined) {
      const rackSnap = await db.doc(`users/${businessId}/racks/${rackId}`).get();

      if (!rackSnap.exists) {
        await trackerRef.update({
          status: "obsolete",
          completedAt: Timestamp.now(),
        });
        return;
      }

      const rackData = rackSnap.data() as Rack;
      if (rackData.locationVersion !== version) {
        await trackerRef.update({
          status: "obsolete",
          completedAt: Timestamp.now(),
        });
        return;
      }
    }

    const offset = chunkIndex * chunkSize;

    const docs = await db
      .collection(`users/${businessId}/${data.collection}`)
      .where("rackId", "==", rackId)
      .orderBy("__name__")
      .offset(offset)
      .limit(chunkSize)
      .get();

    affectedCount = docs.size;

    if (docs.empty) {
      await completeChunkTransaction(trackerRef, 0);
      return;
    }

    await batchedUpdate(
      docs.docs.map((doc) => ({
        ref: doc.ref,
        data: {
          zoneId: data.zoneId,
          warehouseId: data.warehouseId,
        },
      })),
    );

    await completeChunkTransaction(trackerRef, docs.size);
  } catch (error: any) {
    console.error(`Rack chunk ${chunkIndex} failed:`, error);

    await trackerRef.update({
      chunksFailed: FieldValue.increment(1),
      failedDocuments: FieldValue.increment(affectedCount),
      lastError: error.message,
      status: "failed",
    });

    throw error;
  }
}

async function processZoneLocationChunk(task: PropagationTask) {
  const {
    businessId,
    entityId: zoneId,
    data,
    chunkIndex,
    chunkSize,
    propagationId,
    version,
  } = task;

  const trackerRef = db.doc(`users/${businessId}/propagation_trackers/${propagationId}`);

  let affectedCount = 0;

  try {
    if (version !== undefined) {
      const zoneSnap = await db.doc(`users/${businessId}/zones/${zoneId}`).get();

      if (!zoneSnap.exists) {
        await trackerRef.update({
          status: "obsolete",
          completedAt: Timestamp.now(),
        });
        return;
      }

      const zoneData = zoneSnap.data() as Zone;
      if (zoneData.locationVersion !== version) {
        await trackerRef.update({
          status: "obsolete",
          completedAt: Timestamp.now(),
        });
        return;
      }
    }

    const offset = chunkIndex * chunkSize;

    const docs = await db
      .collection(`users/${businessId}/${data.collection}`)
      .where("zoneId", "==", zoneId)
      .orderBy("__name__")
      .offset(offset)
      .limit(chunkSize)
      .get();

    affectedCount = docs.size;

    if (docs.empty) {
      await completeChunkTransaction(trackerRef, 0);
      return;
    }

    await batchedUpdate(
      docs.docs.map((doc) => ({
        ref: doc.ref,
        data: {
          warehouseId: data.warehouseId,
        },
      })),
    );

    await completeChunkTransaction(trackerRef, docs.size);
  } catch (error: any) {
    console.error(`Zone chunk ${chunkIndex} failed:`, error);

    await trackerRef.update({
      chunksFailed: FieldValue.increment(1),
      failedDocuments: FieldValue.increment(affectedCount),
      lastError: error.message,
      status: "failed",
    });

    throw error;
  }
}
