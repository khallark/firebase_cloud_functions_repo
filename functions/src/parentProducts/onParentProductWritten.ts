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
interface ProductSpecifications {
  fit: string;
  fabric: string;
  composition: string;
  technique: string;
}

interface StoreProductMapping {
  storeId: string;
  productId: string;
}

// ── Metafield identity (mirror these in Shopify metafield definitions) ──
const NAMESPACE = "custom";
const KEY_SIZE_CHART = "majime_size_chart";       // multi_line_text_field
const KEY_DESCRIPTION = "majime_description";       // multi_line_text_field
const KEY_SPECIFICATIONS = "majime_specifications"; // json

interface MetafieldInput {
  key: string;
  type: string;
  value: string;
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

// Writes 1..n metafields onto a single product in one mutation.
async function writeMetafields(
  storeId: string,
  accessToken: string,
  shopifyProductId: string,
  inputs: MetafieldInput[],
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
      metafields: inputs.map((i) => ({
        ownerId: `gid://shopify/Product/${shopifyProductId}`,
        namespace: NAMESPACE,
        key: i.key,
        type: i.type,
        value: i.value,
      })),
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

function serializeSpecs(s: ProductSpecifications): string {
  // Fixed key order so change-detection is stable.
  return JSON.stringify({
    fit: s.fit,
    composition: s.composition,
    technique: s.technique,
    fabric: s.fabric ?? "",
  });
}

const mapKey = (m: StoreProductMapping) => `${m.storeId}::${m.productId}`;

// A field's resolved write-state for this event.
interface FieldState {
  label: string;
  key: string;
  type: string;
  value: string | null; // serialized value to write, or null when the field has no value
  changed: boolean;      // serialized value differs from before
}

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

      // Doc deleted (no after) → nothing to do. A cleared field also never
      // deletes its metafield (stale value intentionally left behind).
      if (!after) return null;

      // ── sizeChart ──
      const beforeChart: ProductSizeChart | null = before?.sizeChart ?? null;
      const afterChart: ProductSizeChart | null = after?.sizeChart ?? null;
      const afterChartStr = afterChart ? serializeChart(afterChart) : null;
      const beforeChartStr = beforeChart ? serializeChart(beforeChart) : null;

      // ── description (treat empty/whitespace/missing as no value) ──
      const rawBeforeDesc = typeof before?.description === "string" ? before.description : null;
      const rawAfterDesc = typeof after?.description === "string" ? after.description : null;
      const beforeDescVal = rawBeforeDesc && rawBeforeDesc.trim() ? rawBeforeDesc : null;
      const afterDescVal = rawAfterDesc && rawAfterDesc.trim() ? rawAfterDesc : null;

      // ── specifications ──
      const beforeSpecs: ProductSpecifications | null = before?.specifications ?? null;
      const afterSpecs: ProductSpecifications | null = after?.specifications ?? null;
      const afterSpecsStr = afterSpecs ? serializeSpecs(afterSpecs) : null;
      const beforeSpecsStr = beforeSpecs ? serializeSpecs(beforeSpecs) : null;

      const fields: FieldState[] = [
        {
          label: "sizeChart",
          key: KEY_SIZE_CHART,
          type: "multi_line_text_field",
          value: afterChartStr,
          changed: beforeChartStr !== afterChartStr,
        },
        {
          label: "description",
          key: KEY_DESCRIPTION,
          type: "multi_line_text_field",
          value: afterDescVal,
          changed: beforeDescVal !== afterDescVal,
        },
        {
          label: "specifications",
          key: KEY_SPECIFICATIONS,
          type: "multi_line_text_field",
          value: afterSpecsStr,
          changed: beforeSpecsStr !== afterSpecsStr,
        },
      ];

      const beforeMappings: StoreProductMapping[] = before?.mappedStoreProducts ?? [];
      const afterMappings: StoreProductMapping[] = after?.mappedStoreProducts ?? [];
      const beforeKeys = new Set(beforeMappings.map(mapKey));

      const anyChangedNonNull = fields.some((f) => f.changed && f.value !== null);
      const anyNonNull = fields.some((f) => f.value !== null);
      const hasNewMappings = afterMappings.some((m) => !beforeKeys.has(mapKey(m)));

      // Nothing to write if no field changed to a value, and there are no new
      // mappings that would need the existing (unchanged) values.
      if (!anyChangedNonNull && !(hasNewMappings && anyNonNull)) return null;

      // Cache store tokens across this invocation.
      const storeCache: Record<string, any | null> = {};
      const getStore = async (storeId: string) => {
        if (storeId in storeCache) return storeCache[storeId];
        const snap = await db.doc(`accounts/${storeId}`).get();
        storeCache[storeId] = snap.exists ? snap.data() : null;
        return storeCache[storeId];
      };

      for (const m of afterMappings) {
        const { storeId, productId } = m;
        if (!storeId || !productId) continue;

        const isNew = !beforeKeys.has(mapKey(m));

        // A field is written to this mapping when it has a value AND
        // (the field changed  OR  the mapping is newly added).
        const inputs: MetafieldInput[] = fields
          .filter((f) => f.value !== null && (f.changed || isNew))
          .map((f) => ({ key: f.key, type: f.type, value: f.value as string }));

        if (inputs.length === 0) continue;

        try {
          const store = await getStore(storeId);
          const accessToken = store?.accessToken;
          if (!accessToken) {
            console.error(`  ⚠️ ${parentId} → ${storeId}/${productId}: missing accessToken`);
            continue;
          }

          await writeMetafields(storeId, accessToken, productId, inputs);
          console.log(
            `  ✅ ${parentId} → ${storeId}/${productId} [${inputs.map((i) => i.key).join(", ")}]${isNew ? " (new mapping)" : ""}`,
          );
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