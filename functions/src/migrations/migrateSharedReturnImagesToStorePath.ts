// functions/src/storage/migrateSharedReturnImages.ts

import { onRequest } from "firebase-functions/v2/https";
import { storage } from "../firebaseAdmin";

type MigrationResult = {
  storeId: string;
  sourcePrefix: string;
  destinationPrefix: string;
  totalSourceFiles: number;
  copied: number;
  skippedExisting: number;
  failed: number;
  copiedFiles: Array<{
    from: string;
    to: string;
  }>;
  skippedFiles: Array<{
    from: string;
    to: string;
    reason: string;
  }>;
  failedFiles: Array<{
    from: string;
    to: string;
    error: string;
  }>;
};

const DEFAULT_STORE_IDS = [
  "nfkjgp-sv.myshopify.com",
  "gj9ejg-cu.myshopify.com",
];

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

async function migrateStorePrefix(params: {
  storeId: string;
  dryRun: boolean;
  maxFilesPerStore?: number;
}): Promise<MigrationResult> {
  const { storeId, dryRun, maxFilesPerStore } = params;

  const bucket = storage.bucket();

  const sourcePrefix = `return-images/shared/${storeId}/`;
  const destinationPrefix = `return-images/${storeId}/`;

  const result: MigrationResult = {
    storeId,
    sourcePrefix,
    destinationPrefix,
    totalSourceFiles: 0,
    copied: 0,
    skippedExisting: 0,
    failed: 0,
    copiedFiles: [],
    skippedFiles: [],
    failedFiles: [],
  };

  const [files] = await bucket.getFiles({
    prefix: sourcePrefix,
  });

  const realFiles = files.filter((file) => {
    const name = file.name;

    // Avoid folder placeholders.
    if (name.endsWith("/")) return false;

    // Must be strictly inside the store prefix.
    if (!name.startsWith(sourcePrefix)) return false;

    return true;
  });

  const filesToProcess =
    typeof maxFilesPerStore === "number" && maxFilesPerStore > 0
      ? realFiles.slice(0, maxFilesPerStore)
      : realFiles;

  result.totalSourceFiles = realFiles.length;

  for (const sourceFile of filesToProcess) {
    const sourcePath = sourceFile.name;

    const relativePath = sourcePath.slice(sourcePrefix.length);

    if (!relativePath) {
      result.skippedExisting++;
      result.skippedFiles.push({
        from: sourcePath,
        to: "",
        reason: "Empty relative path.",
      });
      continue;
    }

    const destinationPath = `${destinationPrefix}${relativePath}`;
    const destinationFile = bucket.file(destinationPath);

    try {
      const [destinationExists] = await destinationFile.exists();

      if (destinationExists) {
        result.skippedExisting++;
        result.skippedFiles.push({
          from: sourcePath,
          to: destinationPath,
          reason: "Destination already exists. Not overwritten.",
        });
        continue;
      }

      if (!dryRun) {
        await sourceFile.copy(destinationFile);
      }

      result.copied++;
      result.copiedFiles.push({
        from: sourcePath,
        to: destinationPath,
      });
    } catch (error) {
      result.failed++;

      result.failedFiles.push({
        from: sourcePath,
        to: destinationPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

export const migrateSharedReturnImagesToStorePath = onRequest(
  {
    cors: true,
    timeoutSeconds: 3600,
    memory: "2GiB",
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

      /**
       * Optional safety secret.
       * Set MIGRATION_SECRET in functions env if you want this protected.
       *
       * firebase functions:secrets:set MIGRATION_SECRET
       *
       * Then add secrets: ["MIGRATION_SECRET"] in options if using defineSecret.
       * For now, this checks process.env.MIGRATION_SECRET only if present.
       */
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

      const maxFilesPerStore =
        typeof req.body?.maxFilesPerStore === "number"
          ? req.body.maxFilesPerStore
          : undefined;

      console.log("Starting shared return images migration", {
        dryRun,
        storeIds,
        maxFilesPerStore,
      });

      const results: MigrationResult[] = [];

      for (const storeId of storeIds) {
        const storeResult = await migrateStorePrefix({
          storeId,
          dryRun,
          maxFilesPerStore,
        });

        results.push(storeResult);
      }

      const summary = results.reduce(
        (acc, item) => {
          acc.totalSourceFiles += item.totalSourceFiles;
          acc.copied += item.copied;
          acc.skippedExisting += item.skippedExisting;
          acc.failed += item.failed;
          return acc;
        },
        {
          totalSourceFiles: 0,
          copied: 0,
          skippedExisting: 0,
          failed: 0,
        }
      );

      res.status(200).json({
        success: true,
        dryRun,
        message: dryRun
          ? "Dry run complete. No files were copied."
          : "Migration copy complete.",
        durationMs: Date.now() - startedAt,
        summary,
        results,
      });
    } catch (error) {
      console.error("Migration failed:", error);

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
    }
  }
);