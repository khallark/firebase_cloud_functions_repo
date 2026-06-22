import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { sleep } from "../helpers";

// ── Shopify GraphQL helper (same shape as the inventory sync function) ──
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
  if (json.errors) {
    throw new Error(JSON.stringify(json.errors));
  }

  const data = json.data;
  if (data) {
    const mutationKey = Object.keys(data)[0];
    if (data[mutationKey]?.userErrors?.length > 0) {
      throw new Error(`Shopify userErrors: ${JSON.stringify(data[mutationKey].userErrors)}`);
    }
  }

  return data;
}

async function writeSizeChartMetafield(
  storeId: string,
  accessToken: string,
  shopifyProductId: string,
  jsonValue: string,
) {
  return shopifyGraphQL(
    storeId,
    accessToken,
    `
    mutation ($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key }
        userErrors { field message }
      }
    }
    `,
    {
      metafields: [
        {
          ownerId: `gid://shopify/Product/${shopifyProductId}`,
          namespace: "custom",
          key: "majime_size_chart",
          type: "multi_line_text_field",
          value: jsonValue,
        },
      ],
    },
  );
}

export const migrateSizeChartsToShopify = onRequest(
  {
    cors: true,
    timeoutSeconds: 3600,
    memory: "1GiB",
    maxInstances: 1,
  },
  async (req, res) => {
    const startTime = Date.now();
    const businessId = "2yEGCC8AffNxDoTZEqhAkCRgxNl2";

    const dryRun = req.body?.dryRun === true;
    const batchSize = req.body?.batchSize || 25;

    console.log(`🚀 Size chart → Shopify metafield migration for ${businessId}`);
    console.log(`   Mode: ${dryRun ? "DRY RUN" : "LIVE"}  |  Batch size: ${batchSize}`);

    try {
      const businessDoc = await db.doc(`users/${businessId}`).get();
      if (!businessDoc.exists) {
        res.status(404).json({ error: "Business not found" });
        return;
      }

      const parentsSnap = await db.collection(`users/${businessId}/parentProducts`).get();
      const parentDocs = parentsSnap.docs;

      const stats = {
        totalParents: parentDocs.length,
        parentsProcessed: 0,
        parentsSkippedNoChart: 0,
        parentsSkippedNoMappings: 0,
        metafieldsWritten: 0,
        productsSkipped: 0,
        errors: 0,
      };

      const errors: Array<{ parentId: string; storeId?: string; productId?: string; error: string }> = [];
      const preview: Array<{ parentId: string; storeId: string; productId: string }> = [];

      // Cache store access tokens so we don't refetch accounts/{storeId} per mapping
      const storeTokenCache: Record<string, { accessToken?: string } | null> = {};
      const getStore = async (storeId: string) => {
        if (storeTokenCache[storeId] !== undefined) return storeTokenCache[storeId];
        const snap = await db.doc(`accounts/${storeId}`).get();
        storeTokenCache[storeId] = snap.exists ? (snap.data() as any) : null;
        return storeTokenCache[storeId];
      };

      for (let i = 0; i < parentDocs.length; i += batchSize) {
        const batch = parentDocs.slice(i, i + batchSize);
        const batchNumber = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(parentDocs.length / batchSize);
        console.log(`\n🔄 Batch ${batchNumber}/${totalBatches} (${batch.length} parents)`);

        for (const parentDoc of batch) {
          const parentId = parentDoc.id;
          const data = parentDoc.data();
          const sizeChart = data?.sizeChart;
          const mappedStoreProducts: Array<{ storeId: string; productId: string }> =
            data?.mappedStoreProducts || [];

          stats.parentsProcessed++;

          if (!sizeChart) {
            stats.parentsSkippedNoChart++;
            continue;
          }
          if (mappedStoreProducts.length === 0) {
            stats.parentsSkippedNoMappings++;
            continue;
          }

          // Serialize the full chart object; your parser expects this shape.
          const jsonValue = JSON.stringify({ rows: sizeChart.rows, columns: sizeChart.columns, values: sizeChart.values });

          for (const mapping of mappedStoreProducts) {
            const { storeId, productId } = mapping;

            if (!storeId || !productId) {
              stats.productsSkipped++;
              continue;
            }

            try {
              const store = await getStore(storeId);
              const accessToken = store?.accessToken;

              if (!accessToken) {
                stats.productsSkipped++;
                errors.push({ parentId, storeId, productId, error: "Missing accessToken for store" });
                continue;
              }

              if (dryRun) {
                preview.push({ parentId, storeId, productId });
                stats.metafieldsWritten++; // count what WOULD be written
                continue;
              }

              await writeSizeChartMetafield(storeId, accessToken, productId, jsonValue);
              stats.metafieldsWritten++;
              console.log(`  ✅ ${parentId} → ${storeId}/${productId}`);

              await sleep(200); // throttle, matching the inventory sync cadence
            } catch (err: any) {
              stats.errors++;
              errors.push({ parentId, storeId, productId, error: err.message });
              console.error(`  ❌ ${parentId} → ${storeId}/${productId}: ${err.message}`);
            }
          }
        }

        const pct = Math.round((stats.parentsProcessed / stats.totalParents) * 100);
        console.log(`📈 ${stats.parentsProcessed}/${stats.totalParents} parents (${pct}%) | written: ${stats.metafieldsWritten} | errors: ${stats.errors}`);

        if (i + batchSize < parentDocs.length) {
          await sleep(500); // breather between batches
        }
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log("\n✅ MIGRATION COMPLETE");
      console.log(`Duration: ${duration}s | Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
      console.log(JSON.stringify(stats, null, 2));

      res.status(200).json({
        success: true,
        dryRun,
        duration: `${duration}s`,
        stats,
        errors: errors.length > 0 ? errors : undefined,
        preview: dryRun ? (preview.length <= 200 ? preview : `${preview.length} writes (truncated)`) : undefined,
      });
    } catch (error: any) {
      console.error("💥 FATAL:", error);
      res.status(500).json({ success: false, error: error.message, stack: error.stack });
    }
  },
);