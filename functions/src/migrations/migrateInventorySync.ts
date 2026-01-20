import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { SHARED_STORE_ID } from "../config";
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
  await shopifyGraphQL(
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
}

async function syncProductInventory(businessId: string, productId: string) {
  // ✅ Fresh read right before syncing
  const productSnap = await db.doc(`users/${businessId}/products/${productId}`).get();

  if (!productSnap.exists) {
    console.warn(`Product ${productId} not found`);
    return { syncedCount: 0, failedCount: 0 };
  }

  const productData = productSnap.data() as any;

  const inv = getInventoryValues(productData.inventory);
  const availableStock = calculateAvailableStock(calculatePhysicalStock(inv), inv.blockedStock);

  let syncedCount = 0;
  let failedCount = 0;

  // Sync to Shopify for all mapped variants
  for (const mapping of productData.mappedVariants ?? []) {
    const { storeId, productId: mappedProductId, variantId } = mapping;

    if (storeId === SHARED_STORE_ID) continue;

    try {
      const storeSnap = await db.doc(`accounts/${storeId}`).get();
      const storeData = storeSnap.data();
      const accessToken = storeData?.accessToken;
      const locationId = storeData?.locationId;

      if (!accessToken || !locationId) {
        console.error(`Missing Shopify credentials for store ${storeId}`);
        failedCount++;
        continue;
      }

      const productSnap = await db.doc(`accounts/${storeId}/products/${mappedProductId}`).get();
      const product = productSnap.data();
      const variant = product?.variants?.find((v: any) => v.id === variantId);

      if (!variant?.inventoryItemId) {
        console.warn(`Missing inventoryItemId for variant ${variantId}`);
        failedCount++;
        continue;
      }

      // 1️⃣ Ensure tracking
      await ensureTracking(storeId, accessToken, String(variant.inventoryItemId));
      await sleep(150);

      // 2️⃣ Set inventory
      await setInventory(
        storeId,
        accessToken,
        String(variant.inventoryItemId),
        locationId,
        availableStock,
      );

      syncedCount++;
      console.log(`✅ Synced: ${productId} -> ${storeId}/${variantId} = ${availableStock}`);

      await sleep(200);
    } catch (err) {
      failedCount++;
      console.error(`Failed to sync variant`, {
        productId,
        storeId,
        variantId,
        error: err,
      });
    }
  }

  return { syncedCount, failedCount };
}

export const migrateInventorySync = onRequest(
  {
    memory: "4GiB",
    timeoutSeconds: 3600,
    maxInstances: 1,
  },
  async (req, res) => {
    if (!req) console.log(req);

    const businessId = "2yEGCC8AffNxDoTZEqhAkCRgxNl2";

    try {
      console.log(`🚀 Starting inventory migration for business: ${businessId}`);

      const productsSnapshot = await db.collection(`users/${businessId}/products`).get();

      const totalProducts = productsSnapshot.size;
      console.log(`📦 Found ${totalProducts} products to process`);

      let processedCount = 0;
      let totalSyncedVariants = 0;
      let totalFailedVariants = 0;
      let skippedCount = 0;

      for (const doc of productsSnapshot.docs) {
        const productId = doc.id;
        const productData = doc.data();

        // Skip products without mapped variants
        if (!productData.mappedVariants || productData.mappedVariants.length === 0) {
          skippedCount++;
          processedCount++;
          continue;
        }

        try {
          const { syncedCount, failedCount } = await syncProductInventory(businessId, productId);

          totalSyncedVariants += syncedCount;
          totalFailedVariants += failedCount;
          processedCount++;

          // Log progress every 50 products
          if (processedCount % 50 === 0) {
            console.log(`📊 Progress: ${processedCount}/${totalProducts} products processed`);
            console.log(`   ✅ Synced: ${totalSyncedVariants} variants`);
            console.log(`   ❌ Failed: ${totalFailedVariants} variants`);
            console.log(`   ⏭️  Skipped: ${skippedCount} products (no mappings)`);
          }

          // Small delay between products to avoid overwhelming the system
          await sleep(100);
        } catch (err) {
          console.error(`Error processing product ${productId}:`, err);
          processedCount++;
        }
      }

      const summary = {
        businessId,
        totalProducts,
        processedProducts: processedCount,
        skippedProducts: skippedCount,
        syncedVariants: totalSyncedVariants,
        failedVariants: totalFailedVariants,
        timestamp: new Date().toISOString(),
      };

      console.log(`✅ Migration complete!`, summary);

      res.status(200).json({
        success: true,
        message: "Inventory migration completed",
        ...summary,
      });
    } catch (error) {
      console.error("❌ Migration failed:", error);
      res.status(500).json({
        success: false,
        error: String(error),
        message: "Migration failed",
      });
    }
  },
);
