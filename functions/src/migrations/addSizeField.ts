import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";

// Derive each product's size as the divergent tail of its SKU within the group.
// Inverse of the parent-id prefix logic: parent id = common leading segments,
// sizeName = what's left after those segments (minus a trailing CORE).
function deriveSizeNames(skus: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  if (skus.length === 0) return result;

  const split = skus.map((s) => s.split("-"));

  // Single-variant group: no divergence to measure. Take the second-to-last
  // segment if a CORE tail exists, else the last segment. (e.g. DEFAULTTITLE)
  if (skus.length === 1) {
    const segs = split[0];
    let size: string;
    if (segs.length > 1 && segs[segs.length - 1].toUpperCase() === "CORE") {
      size = segs.length > 2 ? segs[segs.length - 2] : segs[segs.length - 1];
    } else {
      size = segs[segs.length - 1];
    }
    result[skus[0]] = size.trim();
    return result;
  }

  // Multi-variant: find where the common prefix ends.
  const minLen = Math.min(...split.map((p) => p.length));
  let prefixLen = 0;
  for (let i = 0; i < minLen; i++) {
    const seg = split[0][i];
    if (split.every((p) => p[i] === seg)) prefixLen++;
    else break;
  }

  // Everything from prefixLen onward is the size, minus a trailing CORE.
  for (let i = 0; i < skus.length; i++) {
    const tail = split[i].slice(prefixLen);
    if (tail.length > 1 && tail[tail.length - 1].toUpperCase() === "CORE") {
      tail.pop();
    }
    result[skus[i]] = tail.join("-").trim();
  }

  return result;
}

export const addSizeField = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    try {
      const userId = "2yEGCC8AffNxDoTZEqhAkCRgxNl2";

      // ?dryRunProducts=false -> actually write sizeName onto product docs
      const dryRunProducts = req.query.dryRunProducts !== "false";

      const productsSnap = await db.collection(`users/${userId}/products`).get();

      // Group product doc ids (skus) by parentProductId
      const groups: Record<string, string[]> = {};
      let skippedNoParent = 0;

      for (const productDoc of productsSnap.docs) {
        const sku = productDoc.id;
        const parentId = productDoc.data().parentProductId as string | undefined;
        if (!parentId) {
          skippedNoParent++;
          continue;
        }
        (groups[parentId] ??= []).push(sku);
      }

      // Derive sizeName for every product, and collect anything suspicious
      const skuToSize: Record<string, string> = {};
      const problems: {
        sku: string;
        reason: string;
        parentId: string;
      }[] = [];

      for (const [parentId, skus] of Object.entries(groups)) {
        const sizes = deriveSizeNames(skus);
        for (const sku of skus) {
          const size = sizes[sku];
          skuToSize[sku] = size;
          if (!size) {
            problems.push({ sku, reason: "empty_size", parentId });
          }
        }
      }

      // Empty-size derivations are flagged but NOT blocking — some products
      // legitimately have no size. Report them so you can eyeball/fix, but
      // they're written as "" only if you opt in (see note below).
      const emptyCount = problems.length;

      // Preview grouped by parent, so you can scan size extraction per product line
      const preview = Object.entries(groups).map(([parentId, skus]) => ({
        parentId,
        skuCount: skus.length,
        sizes: skus.map((sku) => ({ sku, sizeName: skuToSize[sku] })),
      }));

      let productDocsUpdated = 0;
      if (!dryRunProducts) {
        const productsRef = db.collection(`users/${userId}/products`);
        // Only write non-empty sizes; leave sizeless products untouched (null-by-absence)
        const updates = Object.entries(skuToSize).filter(([, size]) => size);

        for (let i = 0; i < updates.length; i += 450) {
          const batch = db.batch();
          for (const [sku, size] of updates.slice(i, i + 450)) {
            batch.update(productsRef.doc(sku), { sizeName: size });
            productDocsUpdated++;
          }
          await batch.commit();
        }
      }

      res.status(200).json({
        ok: true,
        dryRunProducts,
        totalProducts: productsSnap.size,
        skippedNoParent,
        parentGroups: Object.keys(groups).length,
        emptyCount,
        productDocsUpdated,
        problems,
        preview,
      });
    } catch (error) {
      console.error("Error backfilling size names:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);