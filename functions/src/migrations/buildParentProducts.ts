import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { Timestamp } from "firebase-admin/firestore";

function sanitizeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9-]/g, "");
}

export const buildParentProducts = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    try {
      const userId = "2yEGCC8AffNxDoTZEqhAkCRgxNl2";

      const dryRunParents = req.query.dryRunParents !== "false";
      const dryRunProducts = req.query.dryRunProducts !== "false";

      const productsSnap = await db.collection(`users/${userId}/products`).get();

      // Group skus by name
      const groups: Record<string, string[]> = {};
      let skippedNoName = 0;

      for (const productDoc of productsSnap.docs) {
        const sku = productDoc.id;
        const name = productDoc.data().name as string | undefined;
        if (!name) {
          skippedNoName++;
          continue;
        }
        (groups[name] ??= []).push(sku);
      }

      // Derive a prefix id per group and validate
      const nameToParentId: Record<string, string> = {};
      const idToNames: Record<string, string[]> = {};
      const problems: {
        name: string;
        reason: string;
        parentId: string;
        skus: string[];
      }[] = [];

      for (const [name, skus] of Object.entries(groups)) {
        const parentId = sanitizeId(name.toUpperCase());
        nameToParentId[name] = parentId;
        (idToNames[parentId] ??= []).push(name);

        // Empty id
        if (!parentId) {
          problems.push({ name, reason: "empty_prefix", parentId, skus });
          continue;
        }
        // Firestore forbids "/" and the ids "." / ".."
        if (parentId.includes("/") || parentId === "." || parentId === "..") {
          problems.push({ name, reason: "illegal_doc_id", parentId, skus });
          continue;
        }
      }

      // Collisions: same derived id from two different names
      const collisions = Object.entries(idToNames)
        .filter(([, names]) => names.length > 1)
        .map(([parentId, names]) => ({ parentId, names }));

      const hasBlockingIssues = problems.length > 0 || collisions.length > 0;

      // If anything is wrong, never write — return the report so you can fix the data.
      if (hasBlockingIssues) {
        res.status(200).json({
          ok: false,
          message:
            "Blocking issues found. No writes performed. Resolve these, then re-run.",
          totalProducts: productsSnap.size,
          parentGroups: Object.keys(groups).length,
          collisions,
          problems,
        });
        return;
      }

      const parentProductsRef = db.collection(`users/${userId}/parentProducts`);
      const productsRef = db.collection(`users/${userId}/products`);

      // Phase 1: parentProducts docs (id = prefix)
      let parentDocsWritten = 0;
      if (!dryRunParents) {
        const entries = Object.entries(nameToParentId);
        for (let i = 0; i < entries.length; i += 450) {
          const batch = db.batch();
          for (const [name, parentId] of entries.slice(i, i + 450)) {
            batch.set(parentProductsRef.doc(parentId), {
              udpatedBy: null,
              udpatedAt: null,
              createdBy: "vD8UJMLtHNefUfkMgbcF605SNAm2",
              createdAt: Timestamp.now(),
              name,
              id: parentId
            });
            parentDocsWritten++;
          }
          await batch.commit();
        }
      }

      // Phase 2: parentProductId on product docs
      let productDocsUpdated = 0;
      if (!dryRunProducts) {
        const updates: { sku: string; parentId: string }[] = [];
        for (const [name, skus] of Object.entries(groups)) {
          const parentId = nameToParentId[name];
          for (const sku of skus) updates.push({ sku, parentId });
        }
        for (let i = 0; i < updates.length; i += 450) {
          const batch = db.batch();
          for (const { sku, parentId } of updates.slice(i, i + 450)) {
            batch.update(productsRef.doc(sku), { parentProductId: parentId });
            productDocsUpdated++;
          }
          await batch.commit();
        }
      }

      res.status(200).json({
        ok: true,
        dryRunParents,
        dryRunProducts,
        totalProducts: productsSnap.size,
        skippedNoName,
        parentGroups: Object.keys(groups).length,
        parentDocsWritten,
        productDocsUpdated,
        preview: Object.entries(groups).map(([name, skus]) => ({
          parentProductId: nameToParentId[name],
          name,
          skuCount: skus.length,
          skus,
        })),
      });
    } catch (error) {
      console.error("Error building parent products:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);