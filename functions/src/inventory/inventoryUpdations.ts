import { onDocumentWritten } from "firebase-functions/firestore";
import { db } from "../firebaseAdmin";

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
  return json.data;
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
    mutation ($input: [InventorySetQuantityInput!]!) {
      inventorySetQuantities(input: $input) {
        inventoryLevels { available }
        userErrors { message }
      }
    }
    `,
    {
      input: [
        {
          inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
          locationId: `gid://shopify/Location/${locationId}`,
          availableQuantity: quantity,
        },
      ],
    },
  );
}

function calculatePhysicalStock(inv: Inventory): number {
  return (
    inv.openingStock + inv.inwardAddition - inv.deduction + inv.autoAddition - inv.autoDeduction
  );
}

function calculateAvailableStock(physicalStock: number, blockedStock: number): number {
  return physicalStock - blockedStock;
}

export const onPlacementWritten = onDocumentWritten(
  {
    document: "users/{businessId}/products/{placementId}",
    memory: "256MiB",
    timeoutSeconds: 30,
  },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();

    if (!before || !after) return null;

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

    if (beforeAvailable === availableStock) {
      console.log("No effective inventory change");
      return null;
    }

    console.log("Inventory changed", { beforeAvailable, availableStock });

    for (const mapping of after.mappedVariants ?? []) {
      const { storeId, productId, variantId } = mapping;

      try {
        const storeSnap = await db.doc(`accounts/${storeId}`).get();
        const { accessToken, locationId } = storeSnap.data()!;

        if (!accessToken || !locationId) {
          console.error("Missing Shopify credentials", storeId);
          continue;
        }

        const productSnap = await db.doc(`accounts/${storeId}/products/${productId}`).get();

        const product = productSnap.data();
        const variant = product?.variants?.find((v: any) => v.id === variantId);

        if (!variant?.inventoryItemId) {
          console.warn("Missing inventoryItemId", variantId);
          continue;
        }

        await ensureTracking(storeId, accessToken, String(variant.inventoryItemId));

        await setInventory(
          storeId,
          accessToken,
          String(variant.inventoryItemId),
          locationId,
          availableStock,
        );
      } catch (err) {
        console.error("Failed to sync inventory", {
          storeId,
          variantId,
          error: err,
        });
      }
    }

    if (availableStock <= 0) {
      console.warn(`Placement ${event.params.placementId} out of stock`);
    }

    return null;
  },
);
