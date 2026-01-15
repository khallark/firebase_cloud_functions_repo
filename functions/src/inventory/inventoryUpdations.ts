import { onDocumentWritten } from "firebase-functions/firestore";
import { db } from "../firebaseAdmin";
import { SHARED_STORE_IDS } from "../config";
// import { sleep } from "../helpers";

// interface Inventory {
//   autoAddition: number;
//   autoDeduction: number;
//   blockedStock: number;
//   deduction: number;
//   inwardAddition: number;
//   openingStock: number;
// }

// function getInventoryValues(inventory?: Inventory): Inventory {
//   return {
//     openingStock: inventory?.openingStock ?? 0,
//     inwardAddition: inventory?.inwardAddition ?? 0,
//     deduction: inventory?.deduction ?? 0,
//     autoAddition: inventory?.autoAddition ?? 0,
//     autoDeduction: inventory?.autoDeduction ?? 0,
//     blockedStock: inventory?.blockedStock ?? 0,
//   };
// }

// async function shopifyGraphQL(
//   storeId: string,
//   accessToken: string,
//   query: string,
//   variables?: any,
// ) {
//   const res = await fetch(`https://${storeId}/admin/api/2025-07/graphql.json`, {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       "X-Shopify-Access-Token": accessToken,
//     },
//     body: JSON.stringify({ query, variables }),
//   });

//   const json = (await res.json()) as any;
//   if (json.errors) {
//     throw new Error(JSON.stringify(json.errors));
//   }
//   return json.data;
// }

// async function ensureTracking(storeId: string, accessToken: string, inventoryItemId: string) {
//   const data = await shopifyGraphQL(
//     storeId,
//     accessToken,
//     `
//     query ($id: ID!) {
//       inventoryItem(id: $id) {
//         id
//         tracked
//       }
//     }
//     `,
//     { id: `gid://shopify/InventoryItem/${inventoryItemId}` },
//   );

//   if (!data.inventoryItem.tracked) {
//     await shopifyGraphQL(
//       storeId,
//       accessToken,
//       `
//       mutation ($id: ID!) {
//         inventoryItemUpdate(
//           id: $id,
//           input: { tracked: true }
//         ) {
//           inventoryItem { tracked }
//           userErrors { message }
//         }
//       }
//       `,
//       { id: `gid://shopify/InventoryItem/${inventoryItemId}` },
//     );
//   }
// }

// async function setInventory(
//   storeId: string,
//   accessToken: string,
//   inventoryItemId: string,
//   locationId: string,
//   quantity: number,
// ) {
//   await shopifyGraphQL(
//     storeId,
//     accessToken,
//     `
//     mutation ($input: [InventorySetQuantityInput!]!) {
//       inventorySetQuantities(input: $input) {
//         inventoryLevels { available }
//         userErrors { message }
//       }
//     }
//     `,
//     {
//       input: [
//         {
//           inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
//           locationId: `gid://shopify/Location/${locationId}`,
//           availableQuantity: quantity,
//         },
//       ],
//     },
//   );
// }

// function calculatePhysicalStock(inv: Inventory): number {
//   return (
//     inv.openingStock + inv.inwardAddition - inv.deduction + inv.autoAddition - inv.autoDeduction
//   );
// }

// function calculateAvailableStock(physicalStock: number, blockedStock: number): number {
//   return physicalStock - blockedStock;
// }
// export const onProductWritten = onDocumentWritten(
//   {
//     document: "users/{businessId}/products/{productId}",
//     memory: "256MiB",
//     timeoutSeconds: 300,
//   },
//   async (event) => {
//     const before = event.data?.before?.data();
//     const after = event.data?.after?.data();
//     const { businessId, productId } = event.params;

//     if (!before || !after) return null;

//     const beforeMappedVariants: {
//       mappedAt: string;
//       productId: string;
//       productTitle: string;
//       storeId: string;
//       variantId: number;
//       variantSku: string;
//       variantTitle: string;
//     }[] = before.mappedVariants || [];

//     const afterMappedVariants: {
//       mappedAt: string;
//       productId: string;
//       productTitle: string;
//       storeId: string;
//       variantId: number;
//       variantSku: string;
//       variantTitle: string;
//     }[] = after.mappedVariants || [];

//     if (afterMappedVariants.length - beforeMappedVariants.length === 1) {
//       const mappedVariantData = afterMappedVariants[afterMappedVariants.length - 1];
//       const businessDoc = await db.doc(`users/${businessId}`).get();
//       const businessData = businessDoc.data();
//       const linkedStores: string[] = businessData?.stores || [];
//       let blockedItemsCount = 0;
//       if (businessData?.vendorName) {
//         for (const store of linkedStores) {
//           let perStoreBlockedOrdersCount = 0;
//           let blockedOrdersSnapshot;
//           if (SHARED_STORE_IDS.includes(store)) {
//             blockedOrdersSnapshot = await db
//               .collection('accounts')
//               .doc(store)
//               .collection('orders')
//               .where('vendor', 'array-contains', businessData.vendorName)
//               .where('customStatus', 'in', ['New', 'Confirm', 'Ready To Dispatch'])
//               .get();
//           } else {
//             blockedOrdersSnapshot = await db
//               .collection('accounts')
//               .doc(store)
//               .collection('orders')
//               .where('customStatus', 'in', ['New', 'Confirm', 'Ready To Dispatch'])
//               .get();
//           }

//           if (!blockedOrdersSnapshot.docs.length) continue;
//           for (const doc of blockedOrdersSnapshot.docs) {
//             if (!doc.exists) continue;
//             const line_items: any[] = doc.data()?.line_items;
//             if (!line_items.some(item => item.variant_id === mappedVariantData.variantId)) continue;
//             const matchingItems = line_items.filter(item => item.variant_id === mappedVariantData.variantId);
//             perStoreBlockedOrdersCount += matchingItems.reduce((sum, item) => sum + item.quantity, 0);
//           }
//           blockedItemsCount += perStoreBlockedOrdersCount;
//         }

//         const productRef = db.doc(`users/${businessId}/products/${productId}`);
//         await db.runTransaction(async (tx) => {
//           const currentDoc = await tx.get(productRef);
//           const currentInventory = currentDoc.data()?.inventory;

//           tx.update(productRef, {
//             inventory: {
//               ...(currentInventory || {
//                 autoAddition: 0,
//                 autoDeduction: 0,
//                 blockedStock: 0,
//                 deduction: 0,
//                 inwardAddition: 0,
//                 openingStock: 0,
//               }),
//               blockedStock: (currentInventory?.blockedStock || 0) + blockedItemsCount,
//             }
//           });
//         });
//       }
//     }

//     return null;

//     // const beforeInv = getInventoryValues(before.inventory);
//     // const afterInv = getInventoryValues(after.inventory);

//     // const beforeAvailable = calculateAvailableStock(
//     //   calculatePhysicalStock(beforeInv),
//     //   beforeInv.blockedStock,
//     // );

//     // const availableStock = calculateAvailableStock(
//     //   calculatePhysicalStock(afterInv),
//     //   afterInv.blockedStock,
//     // );

//     // if (beforeAvailable === availableStock) {
//     //   console.log("No effective inventory change");
//     //   return null;
//     // }

//     // console.log("Inventory changed", { beforeAvailable, availableStock });

//     // for (const mapping of after.mappedVariants ?? []) {
//     //   const { storeId, productId, variantId } = mapping;

//     //   if (storeId === SHARED_STORE_ID) continue;

//     //   try {
//     //     const storeSnap = await db.doc(`accounts/${storeId}`).get();
//     //     const { accessToken, locationId } = storeSnap.data()!;

//     //     if (!accessToken || !locationId) {
//     //       console.error("Missing Shopify credentials", storeId);
//     //       continue;
//     //     }

//     //     const productSnap = await db.doc(`accounts/${storeId}/products/${productId}`).get();

//     //     const product = productSnap.data();
//     //     const variant = product?.variants?.find((v: any) => v.id === variantId);

//     //     if (!variant?.inventoryItemId) {
//     //       console.warn("Missing inventoryItemId", variantId);
//     //       continue;
//     //     }

//     //     // 1️⃣ Ensure tracking
//     //     await ensureTracking(storeId, accessToken, String(variant.inventoryItemId));

//     //     // ⏱ deliberate pause (tracking mutation is expensive)
//     //     await sleep(150);

//     //     // 2️⃣ Set inventory (absolute overwrite)
//     //     await setInventory(
//     //       storeId,
//     //       accessToken,
//     //       String(variant.inventoryItemId),
//     //       locationId,
//     //       availableStock,
//     //     );

//     //     // ⏱ pause before next variant
//     //     await sleep(200);
//     //   } catch (err) {
//     //     console.error("Failed to sync inventory", {
//     //       storeId,
//     //       variantId,
//     //       error: err,
//     //     });
//     //   }
//     // }

//     // if (availableStock <= 0) {
//     //   console.warn(`Placement ${event.params.placementId} out of stock`);
//     // }

//     // return null;
//   },
// );

export const onProductWritten = onDocumentWritten(
  {
    document: "users/{businessId}/products/{productId}",
    memory: "512MiB",
    timeoutSeconds: 300,
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

      // Only process when exactly 1 new variant is added
      if (afterMappedVariants.length - beforeMappedVariants.length !== 1) {
        return null;
      }

      const mappedVariantData = afterMappedVariants[afterMappedVariants.length - 1];
      mappedVariantData
      const businessDoc = await db.doc(`users/${businessId}`).get();

      if (!businessDoc.exists) {
        console.error(`Business ${businessId} not found`);
        return null;
      }

      const businessData = businessDoc.data();
      const linkedStores: string[] = businessData?.stores || [];

      if (!businessData?.vendorName || linkedStores.length === 0) {
        return null;
      }

      // Parallelize store queries - track which stores are shared
      const storeQueries = linkedStores.map((store) => {
        const baseQuery = db
          .collection("accounts")
          .doc(store)
          .collection("orders")
          .where("customStatus", "in", ["New", "Confirm", "Ready To Dispatch"]);

        const isSharedStore = SHARED_STORE_IDS.includes(store);

        if (isSharedStore) {
          if (businessData.vendorName === "OWR") {
            return {
              query: baseQuery
                .where("vendor", "array-contains-any", ["OWR", "BBB", "Ghamand"])
                .get(),
              isSharedStore,
              isOWR: true,
            };
          }
          return {
            query: baseQuery.where("vendor", "array-contains", businessData.vendorName).get(),
            isSharedStore,
            isOWR: false,
          };
        }
        return {
          query: baseQuery.get(),
          isSharedStore: false,
          isOWR: false,
        };
      });

      const allResults = await Promise.all(storeQueries.map((sq) => sq.query));

      // Calculate blocked stock across all stores
      let blockedItemsCount = 0;

      for (let i = 0; i < allResults.length; i++) {
        const snapshot = allResults[i];
        const { isSharedStore, isOWR } = storeQueries[i];

        for (const doc of snapshot.docs) {
          if (!doc.exists) continue;

          const orderData = doc.data();
          const vendorArray: string[] = orderData?.vendor || [];

          // Filter out orders for OWR in shared stores if they contain ENDORA or STYLE 05
          if (isSharedStore && isOWR) {
            const hasExcludedVendor = vendorArray.some((v) => v === "ENDORA" || v === "STYLE 05");

            if (hasExcludedVendor) {
              continue; // Skip this order
            }
          }

          const line_items: any[] = orderData?.line_items || [];

          const totalQuantity = line_items
            .filter((item) => item.variant_id === mappedVariantData.variantId)
            .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

          blockedItemsCount += totalQuantity;
        }
      }

      // Update inventory in a transaction to prevent race conditions
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

      console.log(`✅ Updated blocked stock for ${productId}: +${blockedItemsCount}`);
      return null;
    } catch (error) {
      console.error("❌ Error in onProductWritten:", error);
      // Don't throw - let the function complete gracefully
      return null;
    }
  },
);
