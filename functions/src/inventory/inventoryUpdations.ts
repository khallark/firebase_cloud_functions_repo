import { onDocumentWritten } from "firebase-functions/firestore";
import { db } from "../firebaseAdmin";
import { SHARED_STORE_ID, SHARED_STORE_IDS } from "../config";
import { sleep } from "../helpers";

interface Inventory {
  autoAddition: number;
  autoDeduction: number;
  blockedStock: number;
  deduction: number;
  inwardAddition: number;
  openingStock: number;
}

interface MappedVariant {
  storeId: string;
  productId: string;
  variantId: number;
}

function getInventoryValues(inventory?: Inventory): Inventory {
  return {
    openingStock: inventory?.openingStock ?? 0,
    inwardAddition: inventory?.inwardAddition ?? 0,
    deduction: inventory?.deduction ?? 0,
    autoAddition: inventory?.autoAddition ?? 0,
    autoDeduction: inventory?.autoDeduction ?? 0,
    blockedStock: inventory?.blockedStock ?? 0,
  };
}

function calculatePhysicalStock(inv: Inventory): number {
  return (
    inv.openingStock + inv.inwardAddition - inv.deduction + inv.autoAddition - inv.autoDeduction
  );
}

function calculateAvailableStock(physicalStock: number, blockedStock: number): number {
  return physicalStock - blockedStock;
}

function mappingArrayChanged(before: MappedVariant[], after: MappedVariant[]): boolean {
  if (before.length !== after.length) return true;
  // Same length — check if any entry differs
  const afterSet = new Set(after.map((v) => `${v.storeId}:${v.variantId}`));
  return before.some((v) => !afterSet.has(`${v.storeId}:${v.variantId}`));
}

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
      console.error("Shopify userErrors:", JSON.stringify(data[mutationKey].userErrors, null, 2));
      throw new Error(`Shopify userErrors: ${JSON.stringify(data[mutationKey].userErrors)}`);
    }
  }

  return data;
}

async function ensureTracking(storeId: string, accessToken: string, inventoryItemId: string) {
  const data = await shopifyGraphQL(
    storeId,
    accessToken,
    `
    query ($id: ID!) {
      inventoryItem(id: $id) {
        id
        tracked
      }
    }
    `,
    { id: `gid://shopify/InventoryItem/${inventoryItemId}` },
  );

  if (!data.inventoryItem.tracked) {
    await shopifyGraphQL(
      storeId,
      accessToken,
      `
      mutation ($id: ID!) {
        inventoryItemUpdate(
          id: $id,
          input: { tracked: true }
        ) {
          inventoryItem { tracked }
          userErrors { message }
        }
      }
      `,
      { id: `gid://shopify/InventoryItem/${inventoryItemId}` },
    );
  }
}

async function setInventory(
  storeId: string,
  accessToken: string,
  inventoryItemId: string,
  locationId: string,
  quantity: number,
) {
  const result = await shopifyGraphQL(
    storeId,
    accessToken,
    `
    mutation ($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        userErrors {
          field
          message
        }
        inventoryAdjustmentGroup {
          reason
          changes {
            name
            delta
            quantityAfterChange
            item {
              id
            }
          }
        }
      }
    }
    `,
    {
      input: {
        reason: "correction",
        name: "available",
        ignoreCompareQuantity: true,
        quantities: [
          {
            inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
            locationId: `gid://shopify/Location/${locationId}`,
            quantity: quantity,
          },
        ],
      },
    },
  );
  return result;
}

/**
 * Recomputes the total blockedStock for a product by querying all active orders
 * across every mapping in afterMappedVariants.
 *
 * For each mapping: queries New/Confirmed/Ready To Dispatch orders for that store,
 * sums line item quantities matching that variantId.
 * Returns the accumulated total across all mappings.
 */
async function recomputeBlockedStock(
  businessId: string,
  afterMappedVariants: MappedVariant[],
  businessData: any,
): Promise<number> {
  let totalBlocked = 0;

  for (const mapping of afterMappedVariants) {
    const { storeId, variantId } = mapping;
    const isSharedStore = SHARED_STORE_IDS.includes(storeId);
    const isOWR = businessData.vendorName === "OWR";

    let ordersQuery = db
      .collection("accounts")
      .doc(storeId)
      .collection("orders")
      .where("customStatus", "in", ["New", "Confirmed", "Ready To Dispatch"]);

    if (isSharedStore) {
      if (isOWR) {
        ordersQuery = ordersQuery.where("vendors", "array-contains-any", ["OWR", "BBB", "Ghamand"]);
      } else {
        ordersQuery = ordersQuery.where("vendors", "array-contains", businessData.vendorName);
      }
    }

    const ordersSnapshot = await ordersQuery.get();

    for (const doc of ordersSnapshot.docs) {
      if (!doc.exists) continue;
      const line_items: any[] = doc.data()?.raw?.line_items || [];
      const qty = line_items
        .filter((item) => item.variant_id === variantId)
        .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      totalBlocked += qty;
    }
  }

  return totalBlocked;
}

/**
 * Syncs availableStock to Shopify for all mappings in afterMappedVariants,
 * skipping SHARED_STORE_ID.
 */
async function syncAllMappingsToShopify(
  businessId: string,
  productId: string,
  afterMappedVariants: MappedVariant[],
  availableStock: number,
): Promise<void> {
  for (const mapping of afterMappedVariants) {
    const { storeId, productId: mappedProductId, variantId } = mapping;

    if (storeId === SHARED_STORE_ID) continue;

    try {
      const storeSnap = await db.doc(`accounts/${storeId}`).get();
      const storeData = storeSnap.data();
      const accessToken = storeData?.accessToken;
      const locationId = storeData?.locationId;

      if (!accessToken || !locationId) {
        console.error(`Missing Shopify credentials for store ${storeId}`);
        continue;
      }

      const productSnap = await db.doc(`accounts/${storeId}/products/${mappedProductId}`).get();
      const variant = productSnap.data()?.variants?.find((v: any) => v.id === variantId);

      if (!variant?.inventoryItemId) {
        console.warn(`Missing inventoryItemId for variant ${variantId}`);
        continue;
      }

      await ensureTracking(storeId, accessToken, String(variant.inventoryItemId));
      await sleep(150);

      await setInventory(
        storeId,
        accessToken,
        String(variant.inventoryItemId),
        locationId,
        availableStock,
      );

      console.log(`✅ Synced to Shopify: ${storeId}/${variantId} = ${availableStock}`);
      await sleep(200);
    } catch (err) {
      console.error(`Failed to sync to Shopify`, { storeId, variantId, error: err });
    }
  }
}

export const onProductWritten = onDocumentWritten(
  {
    document: "users/{businessId}/products/{productId}",
    memory: "512MiB",
    timeoutSeconds: 540,
    maxInstances: 10,
  },
  async (event) => {
    try {
      const before = event.data?.before?.data();
      const after = event.data?.after?.data();
      const { businessId, productId } = event.params;

      if (!before || !after) return null;

      const beforeMappedVariants: MappedVariant[] = before.mappedVariants || [];
      const afterMappedVariants: MappedVariant[] = after.mappedVariants || [];

      // ============================================================
      // SCENARIO 1: Mapping array changed
      // Recompute blockedStock from scratch across all current mappings,
      // overwrite it, then sync availableStock to Shopify.
      // ============================================================
      if (mappingArrayChanged(beforeMappedVariants, afterMappedVariants)) {
        console.log(`📍 Mapping array changed for product ${productId}`);

        const businessDoc = await db.doc(`users/${businessId}`).get();

        if (!businessDoc.exists) {
          console.error(`Business ${businessId} not found`);
        } else {
          const businessData = businessDoc.data();

          if (businessData?.vendorName) {
            // Recompute full blocked stock across all current mappings
            const recomputedBlockedStock = await recomputeBlockedStock(
              businessId,
              afterMappedVariants,
              businessData,
            );

            console.log(
              `🔢 Recomputed blockedStock for ${productId}: ${recomputedBlockedStock}`,
            );

            // Overwrite blockedStock in a transaction
            const productRef = db.doc(`users/${businessId}/products/${productId}`);
            let availableStock = 0;

            await db.runTransaction(async (tx) => {
              const currentDoc = await tx.get(productRef);
              if (!currentDoc.exists) {
                console.warn(`Product ${productId} no longer exists`);
                return;
              }

              const currentInventory = currentDoc.data()?.inventory;
              const inv = getInventoryValues(currentInventory);
              inv.blockedStock = recomputedBlockedStock;

              availableStock = calculateAvailableStock(
                calculatePhysicalStock(inv),
                inv.blockedStock,
              );

              tx.update(productRef, {
                inventory: {
                  ...currentInventory,
                  blockedStock: recomputedBlockedStock,
                },
              });
            });

            console.log(
              `✅ blockedStock overwritten for ${productId}: ${recomputedBlockedStock} → availableStock: ${availableStock}`,
            );

            // Sync to Shopify for all current mappings
            await syncAllMappingsToShopify(
              businessId,
              productId,
              afterMappedVariants,
              availableStock,
            );
          }
        }

        // Mapping change is fully handled above — skip Scenario 2 to avoid
        // double Shopify sync (the transaction write will trigger another
        // onProductWritten invocation for the inventory change).
        return null;
      }

      // ============================================================
      // SCENARIO 2: Inventory changed (no mapping change)
      // Sync availableStock to Shopify for all mapped variants.
      // ============================================================
      const beforeInv = getInventoryValues(before.inventory);
      const afterInv = getInventoryValues(after.inventory);

      const beforeAvailable = calculateAvailableStock(
        calculatePhysicalStock(beforeInv),
        beforeInv.blockedStock,
      );
      const availableStock = calculateAvailableStock(
        calculatePhysicalStock(afterInv),
        afterInv.blockedStock,
      );

      if (beforeAvailable !== availableStock) {
        console.log(`📦 Inventory changed for ${productId}`, { beforeAvailable, availableStock });

        await syncAllMappingsToShopify(
          businessId,
          productId,
          afterMappedVariants,
          availableStock,
        );
      } else {
        console.log(`⏭️ No effective inventory change for ${productId}`);
      }

      return null;
    } catch (error) {
      console.error("❌ Error in onProductWritten:", error);
      return null;
    }
  },
);