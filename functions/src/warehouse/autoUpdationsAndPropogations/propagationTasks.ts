// propagationTasks.ts
import { onRequest } from "firebase-functions/v2/https";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebaseAdmin";
import { batchedUpdate } from "./helpers";
import type { PropagationTask, PropagationTracker, Shelf, Rack, Zone } from "../../config/types";
import { TASKS_SECRET } from "../../config";
import { requireHeaderSecret } from "../../helpers";

export const processPropagationTask = onRequest(
  {
    timeoutSeconds: 540, // 9 minutes
    memory: "512MiB",
    cors: false,
    secrets: [TASKS_SECRET],
  },
  async (req, res) => {
    try {
      // Basic security: Verify request is from Cloud Tasks
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value()! || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      // Parse task payload
      const task: PropagationTask = JSON.parse(Buffer.from(req.body, "base64").toString());

      console.log(
        `Processing ${task.type} chunk ${task.chunkIndex}/${task.totalChunks} for ${task.entityId}`,
      );

      // Route to appropriate handler
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

  try {
    // Check if this propagation is still valid (version check)
    if (version !== undefined) {
      const shelf = await db.doc(`users/${businessId}/shelves/${shelfId}`).get();
      const shelfData = shelf.data() as Shelf;

      if (shelfData.locationVersion !== version) {
        console.log(`Shelf ${shelfId} location changed again, marking propagation obsolete`);
        await trackerRef.update({
          status: "obsolete",
          completedAt: Timestamp.now(),
        });
        return;
      }
    }

    // Query placements for this chunk
    const offset = chunkIndex * chunkSize;

    const placements = await db
      .collection(`users/${businessId}/placements`)
      .where("shelfId", "==", shelfId)
      .orderBy("__name__")
      .offset(offset)
      .limit(chunkSize)
      .get();

    if (placements.empty) {
      await trackerRef.update({
        chunksCompleted: FieldValue.increment(1),
      });
      return;
    }

    // Update placements
    const updates = placements.docs.map((doc) => ({
      ref: doc.ref,
      data: {
        rackId: data.rackId,
        zoneId: data.zoneId,
        warehouseId: data.warehouseId,
      },
    }));

    await batchedUpdate(updates);

    // Update tracker
    await trackerRef.update({
      chunksCompleted: FieldValue.increment(1),
      processedDocuments: FieldValue.increment(placements.size),
    });

    // Check if all chunks are done
    const tracker = (await trackerRef.get()).data() as PropagationTracker;
    if (tracker.chunksCompleted === tracker.chunksTotal) {
      await trackerRef.update({
        status: "completed",
        completedAt: Timestamp.now(),
      });
      console.log(`Propagation ${propagationId} completed successfully`);
    }
  } catch (error: any) {
    console.error(`Chunk ${chunkIndex} failed:`, error);

    await trackerRef.update({
      chunksFailed: FieldValue.increment(1),
      failedDocuments: FieldValue.increment(chunkSize),
      lastError: error.message,
      status: "failed",
    });

    throw error;
  }
}

async function processRackLocationChunk(task: PropagationTask) {
  const { businessId, data, chunkIndex, chunkSize, propagationId, version } = task;

  // Extract actual rackId from entityId (format: "rackId-shelves" or "rackId-placements")
  const [rackId] = task.entityId.split("-");

  const trackerRef = db.doc(`users/${businessId}/propagation_trackers/${propagationId}`);

  try {
    if (version !== undefined) {
      const rack = await db.doc(`users/${businessId}/racks/${rackId}`).get();
      const rackData = rack.data() as Rack;

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

    if (docs.empty) {
      await trackerRef.update({ chunksCompleted: FieldValue.increment(1) });
      return;
    }

    const updates = docs.docs.map((doc) => ({
      ref: doc.ref,
      data: {
        zoneId: data.zoneId,
        warehouseId: data.warehouseId,
      },
    }));

    await batchedUpdate(updates);

    await trackerRef.update({
      chunksCompleted: FieldValue.increment(1),
      processedDocuments: FieldValue.increment(docs.size),
    });

    const tracker = (await trackerRef.get()).data() as PropagationTracker;
    if (tracker.chunksCompleted === tracker.chunksTotal) {
      await trackerRef.update({
        status: "completed",
        completedAt: Timestamp.now(),
      });
    }
  } catch (error: any) {
    console.error(`Chunk ${chunkIndex} failed:`, error);
    await trackerRef.update({
      chunksFailed: FieldValue.increment(1),
      failedDocuments: FieldValue.increment(chunkSize),
      lastError: error.message,
      status: "failed",
    });
    throw error;
  }
}

async function processZoneLocationChunk(task: PropagationTask) {
  const { businessId, data, chunkIndex, chunkSize, propagationId, version } = task;

  const [zoneId] = task.entityId.split("-");
  const trackerRef = db.doc(`users/${businessId}/propagation_trackers/${propagationId}`);

  try {
    if (version !== undefined) {
      const zone = await db.doc(`users/${businessId}/zones/${zoneId}`).get();
      const zoneData = zone.data() as Zone;

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

    if (docs.empty) {
      await trackerRef.update({ chunksCompleted: FieldValue.increment(1) });
      return;
    }

    const updates = docs.docs.map((doc) => ({
      ref: doc.ref,
      data: {
        warehouseId: data.warehouseId,
      },
    }));

    await batchedUpdate(updates);

    await trackerRef.update({
      chunksCompleted: FieldValue.increment(1),
      processedDocuments: FieldValue.increment(docs.size),
    });

    const tracker = (await trackerRef.get()).data() as PropagationTracker;
    if (tracker.chunksCompleted === tracker.chunksTotal) {
      await trackerRef.update({
        status: "completed",
        completedAt: Timestamp.now(),
      });
    }
  } catch (error: any) {
    console.error(`Chunk ${chunkIndex} failed:`, error);
    await trackerRef.update({
      chunksFailed: FieldValue.increment(1),
      failedDocuments: FieldValue.increment(chunkSize),
      lastError: error.message,
      status: "failed",
    });
    throw error;
  }
}
