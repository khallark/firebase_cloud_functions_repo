// functions/src/storage/migrateSharedUnboxingVideoPaths.ts

import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { FieldValue, Query, QueryDocumentSnapshot } from "firebase-admin/firestore";

const DEFAULT_STORE_IDS = [
  "nfkjgp-sv.myshopify.com",
  "gj9ejg-cu.myshopify.com",
];

const BATCH_LIMIT = 450;

type StoreMigrationResult = {
  storeId: string;
  scanned: number;
  matchedSharedPath: number;
  updated: number;
  skippedAlreadyNew: number;
  failed: number;
  updatedOrders: Array<{
    orderId: string;
    oldPath: string;
    newPath: string;
  }>;
  skippedOrders: Array<{
    orderId: string;
    path: string;
    reason: string;
  }>;
  failedOrders: Array<{
    orderId: string;
    oldPath: string;
    newPath: string;
    error: string;
  }>;
};

function normalizeStoreIds(input: unknown): string[] {
  if (!input) return DEFAULT_STORE_IDS;

  if (!Array.isArray(input)) {
    throw new Error("storeIds must be an array of strings.");
  }

  const storeIds = input
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (storeIds.length === 0) {
    throw new Error("storeIds array cannot be empty.");
  }

  return [...new Set(storeIds)];
}

function convertSharedVideoPath(storeId: string, oldPath: string): string | null {
  const sharedPrefix = `return-images/shared/${storeId}/`;
  const newPrefix = `return-images/${storeId}/`;

  if (!oldPath.startsWith(sharedPrefix)) {
    return null;
  }

  const relativePath = oldPath.slice(sharedPrefix.length);

  if (!relativePath) {
    return null;
  }

  return `${newPrefix}${relativePath}`;
}

async function migrateStoreVideoPaths(params: {
  storeId: string;
  dryRun: boolean;
  maxOrdersPerStore?: number;
}): Promise<StoreMigrationResult> {
  const { storeId, dryRun, maxOrdersPerStore } = params;

  const result: StoreMigrationResult = {
    storeId,
    scanned: 0,
    matchedSharedPath: 0,
    updated: 0,
    skippedAlreadyNew: 0,
    failed: 0,
    updatedOrders: [],
    skippedOrders: [],
    failedOrders: [],
  };

  const sharedPrefix = `return-images/shared/${storeId}/`;

  let queryRef = db
    .collection("accounts")
    .doc(storeId)
    .collection("orders")
    .where("unboxing_video_path", ">=", sharedPrefix)
    .where("unboxing_video_path", "<=", sharedPrefix + "\uf8ff")
    .orderBy("unboxing_video_path")
    .limit(BATCH_LIMIT);

  let processed = 0;
  let lastDoc: QueryDocumentSnapshot | null = null;

  while (true) {
    let pagedQuery: Query = queryRef;

    if (lastDoc) {
      pagedQuery = queryRef.startAfter(lastDoc);
    }

    const snapshot = await pagedQuery.get();

    if (snapshot.empty) {
      break;
    }

    const batch = db.batch();
    let batchUpdates = 0;

    for (const doc of snapshot.docs) {
      if (
        typeof maxOrdersPerStore === "number" &&
        maxOrdersPerStore > 0 &&
        processed >= maxOrdersPerStore
      ) {
        break;
      }

      processed++;
      result.scanned++;

      const orderData = doc.data();
      const oldPath = orderData.unboxing_video_path;

      if (typeof oldPath !== "string" || oldPath.trim() === "") {
        result.skippedOrders.push({
          orderId: doc.id,
          path: String(oldPath),
          reason: "unboxing_video_path is missing or not a string.",
        });
        continue;
      }

      const newPath = convertSharedVideoPath(storeId, oldPath);

      if (!newPath) {
        result.skippedAlreadyNew++;
        result.skippedOrders.push({
          orderId: doc.id,
          path: oldPath,
          reason: "Path is not a shared path for this store.",
        });
        continue;
      }

      result.matchedSharedPath++;

      try {
        if (!dryRun) {
          batch.update(doc.ref, {
            unboxing_video_path: newPath,
            unboxingVideoPathMigratedAt: FieldValue.serverTimestamp(),
            unboxingVideoPathMigrationOldPath: oldPath,
          });

          batchUpdates++;
        }

        result.updated++;
        result.updatedOrders.push({
          orderId: doc.id,
          oldPath,
          newPath,
        });
      } catch (error) {
        result.failed++;
        result.failedOrders.push({
          orderId: doc.id,
          oldPath,
          newPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!dryRun && batchUpdates > 0) {
      await batch.commit();
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];

    if (
      typeof maxOrdersPerStore === "number" &&
      maxOrdersPerStore > 0 &&
      processed >= maxOrdersPerStore
    ) {
      break;
    }

    if (snapshot.size < BATCH_LIMIT) {
      break;
    }
  }

  return result;
}

export const migrateSharedUnboxingVideoPathsToStorePath = onRequest(
  {
    cors: true,
    timeoutSeconds: 3600,
    memory: "1GiB",
  },
  async (req, res) => {
    const startedAt = Date.now();

    try {
      if (req.method !== "POST") {
        res.status(405).json({
          error: "Method not allowed. Use POST.",
        });
        return;
      }

      const configuredSecret = process.env.MIGRATION_SECRET;

      if (configuredSecret) {
        const providedSecret =
          req.headers["x-migration-secret"] ||
          req.headers["X-Migration-Secret"];

        if (providedSecret !== configuredSecret) {
          res.status(401).json({
            error: "Unauthorized migration request.",
          });
          return;
        }
      }

      const dryRun = req.body?.dryRun !== false;
      const storeIds = normalizeStoreIds(req.body?.storeIds);

      const maxOrdersPerStore =
        typeof req.body?.maxOrdersPerStore === "number"
          ? req.body.maxOrdersPerStore
          : undefined;

      console.log("Starting unboxing_video_path migration", {
        dryRun,
        storeIds,
        maxOrdersPerStore,
      });

      const results: StoreMigrationResult[] = [];

      for (const storeId of storeIds) {
        const storeResult = await migrateStoreVideoPaths({
          storeId,
          dryRun,
          maxOrdersPerStore,
        });

        results.push(storeResult);
      }

      const summary = results.reduce(
        (acc, item) => {
          acc.scanned += item.scanned;
          acc.matchedSharedPath += item.matchedSharedPath;
          acc.updated += item.updated;
          acc.skippedAlreadyNew += item.skippedAlreadyNew;
          acc.failed += item.failed;
          return acc;
        },
        {
          scanned: 0,
          matchedSharedPath: 0,
          updated: 0,
          skippedAlreadyNew: 0,
          failed: 0,
        }
      );

      res.status(200).json({
        success: true,
        dryRun,
        message: dryRun
          ? "Dry run complete. No Firestore documents were updated."
          : "unboxing_video_path migration complete.",
        durationMs: Date.now() - startedAt,
        summary,
        results,
      });
    } catch (error) {
      console.error("unboxing_video_path migration failed:", error);

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
    }
  }
);