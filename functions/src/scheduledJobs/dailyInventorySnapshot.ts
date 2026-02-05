import { onSchedule } from "firebase-functions/scheduler";
import { db } from "../firebaseAdmin";
import { DocumentSnapshot, Timestamp } from "firebase-admin/firestore";

interface Inventory {
  autoAddition: number;
  autoDeduction: number;
  blockedStock: number;
  deduction: number;
  inwardAddition: number;
  openingStock: number;
}

function calculatePhysicalStock(inv: Inventory): number {
  return (
    inv.openingStock +
    inv.inwardAddition -
    inv.deduction +
    inv.autoAddition -
    inv.autoDeduction
  );
}

/**
 * Get YYYY-MM-DD and IST day start string
 */
function getTodayIST() {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffsetMs);

  const yyyy = ist.getFullYear();
  const mm = String(ist.getMonth() + 1).padStart(2, "0");
  const dd = String(ist.getDate()).padStart(2, "0");

  return {
    date: `${yyyy}-${mm}-${dd}`,
    startString: `${yyyy}-${mm}-${dd}T00:00:00+05:30`,
  };
}

/**
 * Build variantId → quantity sold map
 */
function buildVariantSalesMap(orderDocs: FirebaseFirestore.QueryDocumentSnapshot[]) {
  const map = new Map<string, number>();

  for (const doc of orderDocs) {
    const lineItems = doc.data()?.raw?.line_items;
    if (!Array.isArray(lineItems)) continue;

    for (const item of lineItems) {
      if (!item?.variant_id || typeof item.quantity !== "number") continue;

      map.set(
        item.variant_id,
        (map.get(item.variant_id) || 0) + item.quantity
      );
    }
  }

  return map;
}

/**
 * Create (idempotent) inventory snapshot
 */
async function createInventorySnapshot(
  businessId: string,
  productDoc: DocumentSnapshot,
  variantSalesMap: Map<string, number>,
  today: string
): Promise<void> {
  if (!productDoc.exists) return;

  const product = productDoc.data();
  if (!product?.inventory) return;

  const stockLevel = calculatePhysicalStock(product.inventory);

  const mappedVariants = product.mappedVariants;
  const dailySales =
    Array.isArray(mappedVariants)
      ? mappedVariants.reduce(
        (sum: number, mv: any) =>
          sum + (variantSalesMap.get(mv.variantId) || 0),
        0
      )
      : 0;

  const snapshotId = `${productDoc.id}_${today}`;

  await db
    .collection('users')
    .doc(businessId)
    .collection("inventory_snapshots")
    .doc(snapshotId)
    .set(
      {
        productId: productDoc.id,
        date: today,
        stockLevel,
        isStockout: stockLevel === 0,
        dailySales,
        timestamp: Timestamp.now(),
        exactDocState: { ...product },
      },
      { merge: true } // idempotent
    );
}

export const checkDelayedConfirmedOrders = onSchedule(
  {
    schedule: "59 23 * * *",
    timeZone: "Asia/Kolkata",
    memory: "4GiB",
    timeoutSeconds: 7200,
  },
  async () => {
    const { date: today, startString } = getTodayIST();

    try {
      const businessesSnapshot = await db.collection("users").get();

      for (const businessDoc of businessesSnapshot.docs) {
        const linkedStores = businessDoc.data()?.stores;

        if (!Array.isArray(linkedStores) || !linkedStores.length) {
          continue;
        }

        // Fetch all stores' orders in parallel
        const orderSnapshots = await Promise.all(
          linkedStores.map(store =>
            db
              .collection("accounts")
              .doc(store)
              .collection("orders")
              .where("createdAt", ">=", startString)
              .get()
          )
        );

        // Merge variant sales across all stores
        const variantSalesMap = new Map<string, number>();

        for (const snapshot of orderSnapshots) {
          const storeMap = buildVariantSalesMap(snapshot.docs);

          for (const [variantId, qty] of storeMap.entries()) {
            variantSalesMap.set(
              variantId,
              (variantSalesMap.get(variantId) || 0) + qty
            );
          }
        }

        const productsSnapshot = await db
          .collection(`users/${businessDoc.id}/products`)
          .get();

        for (const productDoc of productsSnapshot.docs) {
          try {
            await createInventorySnapshot(
              businessDoc.id,
              productDoc,
              variantSalesMap,
              today
            );
          } catch (err) {
            console.error(
              `Snapshot failed for product ${productDoc.id}`,
              err
            );
          }
        }
      }
    } catch (err) {
      console.error("Inventory snapshot job failed", err);
    }
  }
);
