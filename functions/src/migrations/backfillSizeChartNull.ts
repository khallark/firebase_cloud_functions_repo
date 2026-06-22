import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";

const DEFAULT_BUSINESS_ID = "2yEGCC8AffNxDoTZEqhAkCRgxNl2";
const BATCH_LIMIT = 450; // under Firestore's 500-write cap, with headroom

/**
 * Backfill: set `sizeChart`, `description`, and `specifications` to null on
 * every parentProducts doc where each field is ABSENT — independently per field.
 * A doc already holding a field (null OR a value) keeps it untouched.
 *
 * Each field is checked on its own, so a doc missing two of the three gets both
 * set in a SINGLE update (one write). Fields already present are never rewritten.
 *
 * Firestore can't query "field missing", so we read all docs and filter in code:
 *   !("<field>" in data)  → that field key is not present at all.
 *
 * Query params:
 *   ?businessId=...   (optional, defaults to the known business)
 *   ?dryRun=1         report what WOULD change without writing.
 */
const NULLABLE_FIELDS = ["sizeChart", "description", "specifications"] as const;

export const backfillSizeChartNull = onRequest(
  { cors: true, timeoutSeconds: 540, memory: "1GiB" },
  async (req, res) => {
    const businessId =
      (req.query.businessId as string) || req.body?.businessId || DEFAULT_BUSINESS_ID;
    const dryRun =
      req.query.dryRun === "1" || req.query.dryRun === "true" || req.body?.dryRun === true;

    try {
      const snap = await db
        .collection("users")
        .doc(businessId)
        .collection("parentProducts")
        .get();

      const totalDocs = snap.size;

      // Per-field "missing" counts.
      const missingByField: Record<string, number> = {
        sizeChart: 0,
        description: 0,
        specifications: 0,
      };
      // Docs that had at least one missing field (= number of writes performed).
      let docsTouched = 0;
      const touchedIds: string[] = [];

      let batch = db.batch();
      let inBatch = 0;

      for (const doc of snap.docs) {
        const data = doc.data();

        // Build an update containing ONLY the fields this doc is missing.
        const patch: Record<string, null> = {};
        for (const field of NULLABLE_FIELDS) {
          if (!(field in data)) {
            patch[field] = null;
            missingByField[field]++;
          }
        }

        const missingCount = Object.keys(patch).length;
        if (missingCount === 0) continue; // all three present → skip

        docsTouched++;
        touchedIds.push(doc.id);

        if (dryRun) continue;

        batch.update(doc.ref, patch);
        inBatch++;

        if (inBatch >= BATCH_LIMIT) {
          await batch.commit();
          batch = db.batch();
          inBatch = 0;
        }
      }

      if (!dryRun && inBatch > 0) {
        await batch.commit();
      }

      res.status(200).json({
        success: true,
        dryRun,
        businessId,
        totalDocs,
        missingByField,
        docsTouched,
        docsFullyPresent: totalDocs - docsTouched,
        writesPerformed: dryRun ? 0 : docsTouched,
        touchedIds,
      });
    } catch (error: unknown) {
      console.error("[backfillSizeChartNull] error:", error);
      res.status(500).json({
        error: "Internal server error.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);