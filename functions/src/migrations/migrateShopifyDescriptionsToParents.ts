import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { sleep } from "../helpers";

const DEFAULT_BUSINESS_ID = "2yEGCC8AffNxDoTZEqhAkCRgxNl2";
const BATCH_LIMIT = 450;
const PAGE_SIZE = 100;

/**
 * One-time migration:
 *   1. Read all ACTIVE Shopify products that have a non-empty default description
 *      (live, via the Admin GraphQL API), across the business's mapped stores.
 *   2. For each, find the parent product it's mapped to (storeId::productId →
 *      parentId, from each parent's mappedStoreProducts reverse array) and set
 *      that parent's `description`.
 *
 * Source field:   descriptionFormat=text (default) → GraphQL `description` (plain)
 *                 descriptionFormat=html           → `descriptionHtml` (raw HTML)
 * Non-destructive: overwrite=false (default) only fills parents with no description.
 * Conflicts:      if multiple store products map to one parent, FIRST non-empty wins.
 *
 * Query params:
 *   ?businessId=...        (optional; defaults to the known business)
 *   ?dryRun=1              report without writing
 *   ?overwrite=1           replace existing parent descriptions too
 *   ?descriptionFormat=html
 */
export const migrateShopifyDescriptionsToParents = onRequest(
  { cors: true, timeoutSeconds: 540, memory: "1GiB" },
  async (req, res) => {
    const businessId =
      (req.query.businessId as string) || req.body?.businessId || DEFAULT_BUSINESS_ID;
    const dryRun =
      req.query.dryRun === "1" || req.query.dryRun === "true" || req.body?.dryRun === true;
    const overwrite =
      req.query.overwrite === "1" || req.query.overwrite === "true" || req.body?.overwrite === true;
    const useHtml =
      req.query.descriptionFormat === "html" || req.body?.descriptionFormat === "html";

    try {
      // ── 1. Build mapping lookup + current descriptions from parentProducts ──
      const parentsSnap = await db
        .collection("users")
        .doc(businessId)
        .collection("parentProducts")
        .get();

      // key = `${storeId}::${productId}` → parentId
      const productToParent = new Map<string, string>();
      const parentCurrentDesc = new Map<string, string | null>();
      const storeIds = new Set<string>();

      for (const doc of parentsSnap.docs) {
        const data = doc.data();
        parentCurrentDesc.set(doc.id, (data.description as string | null) ?? null);

        const mappings: Array<{ storeId?: string; productId?: string }> =
          data.mappedStoreProducts ?? [];
        for (const m of mappings) {
          if (!m?.storeId || !m?.productId) continue;
          productToParent.set(`${m.storeId}::${m.productId}`, doc.id);
          storeIds.add(m.storeId);
        }
      }

      if (storeIds.size === 0) {
        res.status(200).json({
          success: true,
          dryRun,
          businessId,
          note: "No mapped store products found — nothing to migrate.",
        });
        return;
      }

      // ── 2. Pull ACTIVE Shopify products with descriptions, per store ──
      // parentId → { description, sourceProductId } (first non-empty wins)
      const chosen = new Map<string, { description: string; storeId: string; productId: string }>();
      const conflicts: Array<{
        parentId: string;
        keptProductId: string;
        ignoredProductId: string;
        storeId: string;
      }> = [];

      let shopifyWithDescription = 0;
      let mappedToParent = 0;
      let unmapped = 0;
      const storeErrors: Array<{ storeId: string; error: string }> = [];
      const storesProcessed: string[] = [];

      for (const storeId of storeIds) {
        const storeDoc = await db.doc(`accounts/${storeId}`).get();
        const accessToken = storeDoc.exists ? storeDoc.data()?.accessToken : null;
        if (!accessToken) {
          storeErrors.push({ storeId, error: "missing accessToken" });
          continue;
        }

        try {
          let cursor: string | null = null;
          let hasNext = true;

          while (hasNext) {
            const data: any = await shopifyGraphQL(
              storeId,
              accessToken,
              `
              query ($cursor: String) {
                products(first: ${PAGE_SIZE}, after: $cursor, query: "status:active") {
                  pageInfo { hasNextPage endCursor }
                  edges {
                    node {
                      id
                      description
                      descriptionHtml
                    }
                  }
                }
              }
              `,
              { cursor },
            );

            const conn = data?.products;
            const edges: any[] = conn?.edges ?? [];

            for (const edge of edges) {
              const node = edge?.node;
              if (!node?.id) continue;

              const raw = useHtml ? node.descriptionHtml : node.description;
              const description = typeof raw === "string" ? raw.trim() : "";
              if (!description) continue;

              shopifyWithDescription++;

              const productId = String(node.id).split("/").pop() ?? "";
              const parentId = productToParent.get(`${storeId}::${productId}`);
              if (!parentId) {
                unmapped++;
                continue;
              }
              mappedToParent++;

              const existing = chosen.get(parentId);
              if (existing) {
                // Another product already claimed this parent → first wins.
                conflicts.push({
                  parentId,
                  keptProductId: existing.productId,
                  ignoredProductId: productId,
                  storeId,
                });
                continue;
              }
              chosen.set(parentId, { description, storeId, productId });
            }

            hasNext = !!conn?.pageInfo?.hasNextPage;
            cursor = conn?.pageInfo?.endCursor ?? null;
            if (hasNext) await sleep(300); // gentle pacing between pages
          }

          storesProcessed.push(storeId);
        } catch (err: any) {
          storeErrors.push({ storeId, error: err?.message ?? String(err) });
        }
      }

      // ── 3. Apply to parents (respecting overwrite + dryRun) ──
      let parentsUpdated = 0;
      let parentsSkippedExisting = 0;
      const updatedParentIds: string[] = [];

      let batch = db.batch();
      let inBatch = 0;
      const now = new Date();

      for (const [parentId, info] of chosen) {
        const current = parentCurrentDesc.get(parentId) ?? null;
        const currentNonEmpty = !!(current && current.trim());

        if (currentNonEmpty && !overwrite) {
          parentsSkippedExisting++;
          continue;
        }

        parentsUpdated++;
        updatedParentIds.push(parentId);

        if (dryRun) continue;

        const ref = db
          .collection("users")
          .doc(businessId)
          .collection("parentProducts")
          .doc(parentId);

        batch.update(ref, {
          description: info.description,
          updatedBy: "migration:shopify-descriptions",
          updatedAt: now,
        });
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
        overwrite,
        descriptionFormat: useHtml ? "html" : "text",
        businessId,
        storesQueried: storeIds.size,
        storesProcessed,
        shopifyActiveWithDescription: shopifyWithDescription,
        mappedToParent,
        unmapped,
        parentsUpdated,
        parentsSkippedExisting,
        conflicts,
        storeErrors,
        updatedParentIds,
      });
    } catch (error: unknown) {
      console.error("[migrateShopifyDescriptionsToParents] error:", error);
      res.status(500).json({
        error: "Internal server error.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

// ── Shopify GraphQL helper (Admin API 2025-07) ──
async function shopifyGraphQL(
  storeId: string,
  accessToken: string,
  query: string,
  variables?: any,
) {
  const res = await fetch(`https://${storeId}/admin/api/2025-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json()) as any;
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}