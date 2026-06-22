import { onDocumentWritten } from "firebase-functions/firestore";
import { db } from "../firebaseAdmin";
import { sleep } from "../helpers";

interface SizeChartCols { key: string; label: string }
interface ProductSizeChart {
  presetId: string | null;
  presetName: string | null;
  rows: string[];
  columns: SizeChartCols[];
  values: Record<string, Record<string, string>>;
}

interface StoreProductMapping {
  storeId: string;
  productId: string;
}

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
  if (json.errors) throw new Error(JSON.stringify(json.errors));

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

// Storefront only needs the renderable data — strip provenance.
function serializeChart(chart: ProductSizeChart): string {
  return JSON.stringify({
    rows: chart.rows,
    columns: chart.columns,
    values: chart.values,
  });
}

const mapKey = (m: StoreProductMapping) => `${m.storeId}::${m.productId}`;

export const onParentProductWritten = onDocumentWritten(
  {
    document: "users/{businessId}/parentProducts/{parentId}",
    memory: "512MiB",
    timeoutSeconds: 540,
    maxInstances: 10,
  },
  async (event) => {
    try {
      const before = event.data?.before?.data();
      const after = event.data?.after?.data();
      const { parentId } = event.params;

      // Doc deleted (no after) → nothing to do. Per the rules, a cleared chart
      // also never deletes the metafield.
      if (!after) return null;

      const beforeChart: ProductSizeChart | null = before?.sizeChart ?? null;
      const afterChart: ProductSizeChart | null = after?.sizeChart ?? null;

      const beforeMappings: StoreProductMapping[] = before?.mappedStoreProducts ?? [];
      const afterMappings: StoreProductMapping[] = after?.mappedStoreProducts ?? [];

      // Nothing to ever write if there's no chart now.
      if (!afterChart) return null;

      const afterChartStr = serializeChart(afterChart);
      const beforeChartStr = beforeChart ? serializeChart(beforeChart) : null;
      const chartChanged = beforeChartStr !== afterChartStr;

      // Decide the target set of mappings to write to.
      // - chart changed  → ALL current mappings
      // - chart same but mappings changed → only the NEWLY-ADDED mappings
      let targets: StoreProductMapping[] = [];

      if (chartChanged) {
        targets = afterMappings;
        console.log(`📐 ${parentId}: chart changed → writing all ${targets.length} mapping(s)`);
      } else {
        const beforeKeys = new Set(beforeMappings.map(mapKey));
        const added = afterMappings.filter((m) => !beforeKeys.has(mapKey(m)));
        if (added.length === 0) {
          // Neither chart nor mappings (additively) changed — nothing to do.
          return null;
        }
        targets = added;
        console.log(`🔗 ${parentId}: ${added.length} new mapping(s) → writing existing chart`);
      }

      if (targets.length === 0) return null;

      const jsonValue = afterChartStr;

      // Cache store tokens across this invocation.
      const storeCache: Record<string, any | null> = {};
      const getStore = async (storeId: string) => {
        if (storeId in storeCache) return storeCache[storeId];
        const snap = await db.doc(`accounts/${storeId}`).get();
        storeCache[storeId] = snap.exists ? snap.data() : null;
        return storeCache[storeId];
      };

      for (const { storeId, productId } of targets) {
        if (!storeId || !productId) continue;
        try {
          const store = await getStore(storeId);
          const accessToken = store?.accessToken;
          if (!accessToken) {
            console.error(`  ⚠️ ${parentId} → ${storeId}/${productId}: missing accessToken`);
            continue;
          }

          await writeSizeChartMetafield(storeId, accessToken, productId, jsonValue);
          console.log(`  ✅ ${parentId} → ${storeId}/${productId}`);
          await sleep(200); // throttle, matching the inventory sync cadence
        } catch (err: any) {
          console.error(`  ❌ ${parentId} → ${storeId}/${productId}: ${err.message}`);
          // Swallow per-mapping errors so one bad product doesn't abort the rest.
        }
      }

      return null;
    } catch (error) {
      console.error("❌ Error in onParentProductWritten:", error);
      return null;
    }
  },
);