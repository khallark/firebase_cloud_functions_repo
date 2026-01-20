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

  // Check for userErrors in mutations
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

export const onProductWritten = onDocumentWritten(
  {
    document: "users/{businessId}/products/{productId}",
    memory: "1GiB",
    timeoutSeconds: 540,
    maxInstances: 10,
  },
  async (event) => {
    try {
      const before = event.data?.before?.data();
      const after = event.data?.after?.data();
      const { businessId, productId } = event.params;

      if (!before || !after) return null;

      const beforeMappedVariants = before.mappedVariants || [];
      const afterMappedVariants = after.mappedVariants || [];

      // ============================================================
      // SCENARIO 1: New variant mapping added
      // Calculate and add blocked stock for the new variant
      // ============================================================
      if (afterMappedVariants.length - beforeMappedVariants.length === 1) {
        console.log(`📍 New variant mapping detected for product ${productId}`);

        const mappedVariantData = afterMappedVariants[afterMappedVariants.length - 1];
        const businessDoc = await db.doc(`users/${businessId}`).get();

        if (!businessDoc.exists) {
          console.error(`Business ${businessId} not found`);
          // Continue to check inventory changes
        } else {
          const businessData = businessDoc.data();

          if (businessData?.vendorName) {
            const storeId = mappedVariantData.storeId;
            const isSharedStore = SHARED_STORE_IDS.includes(storeId);

            let ordersQuery = db
              .collection("accounts")
              .doc(storeId)
              .collection("orders")
              .where("customStatus", "in", ["New", "Confirmed", "Ready To Dispatch"]);

            const isOWR = businessData.vendorName === "OWR";

            // Apply vendor filtering for shared stores
            if (isSharedStore) {
              if (isOWR) {
                ordersQuery = ordersQuery.where("vendors", "array-contains-any", [
                  "OWR",
                  "BBB",
                  "Ghamand",
                ]);
              } else {
                ordersQuery = ordersQuery.where(
                  "vendors",
                  "array-contains",
                  businessData.vendorName,
                );
              }
            }

            const ordersSnapshot = await ordersQuery.get();

            // Calculate blocked stock for this specific variant
            let blockedItemsCount = 0;

            for (const doc of ordersSnapshot.docs) {
              if (!doc.exists) continue;

              const orderData = doc.data();
              const line_items: any[] = orderData?.raw?.line_items || [];

              const totalQuantity = line_items
                .filter((item) => item.variant_id === mappedVariantData.variantId)
                .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

              blockedItemsCount += totalQuantity;
            }

            // Update blocked stock in transaction
            const productRef = db.doc(`users/${businessId}/products/${productId}`);

            await db.runTransaction(async (tx) => {
              const currentDoc = await tx.get(productRef);

              if (!currentDoc.exists) {
                console.warn(`Product ${productId} no longer exists`);
                return;
              }

              const currentInventory = currentDoc.data()?.inventory;
              const currentBlockedStock = currentInventory?.blockedStock || 0;

              tx.update(productRef, {
                inventory: {
                  ...(currentInventory || {
                    autoAddition: 0,
                    autoDeduction: 0,
                    blockedStock: 0,
                    deduction: 0,
                    inwardAddition: 0,
                    openingStock: 0,
                  }),
                  blockedStock: currentBlockedStock + blockedItemsCount,
                },
              });
            });

            console.log(
              `✅ Updated blocked stock for ${productId} (store: ${storeId}): +${blockedItemsCount}`,
            );

            // 🆕 Sync the new available stock to Shopify for this newly mapped variant
            try {
              const storeSnap = await db.doc(`accounts/${storeId}`).get();
              const storeData = storeSnap.data();
              const accessToken = storeData?.accessToken;
              const locationId = storeData?.locationId;

              if (!accessToken || !locationId) {
                console.error(`Missing Shopify credentials for store ${storeId}`);
              } else {
                const productSnap = await db
                  .doc(`accounts/${storeId}/products/${mappedVariantData.productId}`)
                  .get();
                const product = productSnap.data();
                const variant = product?.variants?.find(
                  (v: any) => v.id === mappedVariantData.variantId,
                );

                if (!variant?.inventoryItemId) {
                  console.warn(
                    `Missing inventoryItemId for variant ${mappedVariantData.variantId}`,
                  );
                } else {
                  // Get the updated product data after transaction
                  const updatedProductSnap = await db
                    .doc(`users/${businessId}/products/${productId}`)
                    .get();
                  const updatedProduct = updatedProductSnap.data();
                  const updatedInv = getInventoryValues(updatedProduct?.inventory);
                  const updatedAvailableStock = calculateAvailableStock(
                    calculatePhysicalStock(updatedInv),
                    updatedInv.blockedStock,
                  );

                  // Ensure tracking
                  await ensureTracking(storeId, accessToken, String(variant.inventoryItemId));
                  await sleep(150);

                  // Set inventory
                  await setInventory(
                    storeId,
                    accessToken,
                    String(variant.inventoryItemId),
                    locationId,
                    updatedAvailableStock,
                  );

                  console.log(
                    `✅ Synced new mapping to Shopify: ${storeId}/${mappedVariantData.variantId} = ${updatedAvailableStock}`,
                  );
                }
              }
            } catch (err) {
              console.error(`Failed to sync new mapping to Shopify`, {
                storeId,
                variantId: mappedVariantData.variantId,
                error: err,
              });
            }
          }
        }
      }

      // ============================================================
      // SCENARIO 2: Inventory changed
      // Sync available stock to Shopify
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

        // Sync to Shopify for all mapped variants
        for (const mapping of after.mappedVariants ?? []) {
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

            const productSnap = await db
              .doc(`accounts/${storeId}/products/${mappedProductId}`)
              .get();
            const product = productSnap.data();
            const variant = product?.variants?.find((v: any) => v.id === variantId);

            if (!variant?.inventoryItemId) {
              console.warn(`Missing inventoryItemId for variant ${variantId}`);
              continue;
            }

            // 1️⃣ Ensure tracking
            await ensureTracking(storeId, accessToken, String(variant.inventoryItemId));

            // ⏱ Deliberate pause (tracking mutation is expensive)
            await sleep(150);

            // 2️⃣ Set inventory (absolute overwrite)
            await setInventory(
              storeId,
              accessToken,
              String(variant.inventoryItemId),
              locationId,
              availableStock,
            );

            console.log(
              `✅ Synced inventory to Shopify: ${storeId}/${variantId} = ${availableStock}`,
            );

            // ⏱ Pause before next variant
            await sleep(200);
          } catch (err) {
            console.error(`Failed to sync inventory to Shopify`, {
              storeId,
              variantId,
              error: err,
            });
          }
        }
      } else {
        console.log(`⏭️ No effective inventory change for ${productId}`);
      }

      return null;
    } catch (error) {
      console.error("❌ Error in onProductWritten:", error);
      // Don't throw - let the function complete gracefully
      return null;
    }
  },
);
