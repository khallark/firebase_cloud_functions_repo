import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";

const DEFAULT_BUSINESS_ID = "2yEGCC8AffNxDoTZEqhAkCRgxNl2";
const BATCH_LIMIT = 450; // under Firestore's 500-write cap, with headroom

/**
 * Backfill: set `sizeChart: null` on every parentProducts doc where the field
 * is ABSENT. Docs that already have `sizeChart` (null OR a real chart) are left
 * untouched.
 *
 * Firestore can't query "field missing", so we read all docs and filter in code:
 *   !("sizeChart" in data)  → field key not present at all.
 *
 * Query params:
 *   ?businessId=...   (optional, defaults to the known business)
 *   ?dryRun=1         report what WOULD change without writing.
 */
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
      let missing = 0;
      let updated = 0;
      const missingIds: string[] = [];

      let batch = db.batch();
      let inBatch = 0;

      for (const doc of snap.docs) {
        const data = doc.data();
        if ("sizeChart" in data) continue; // already present (null or value) → skip

        missing++;
        missingIds.push(doc.id);

        if (dryRun) continue;

        batch.update(doc.ref, { sizeChart: null });
        inBatch++;
        updated++;

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
        missingField: missing,
        updated: dryRun ? 0 : updated,
        alreadyPresent: totalDocs - missing,
        missingIds,
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