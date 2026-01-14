// ============================================================================
// BACKGROUND FUNCTION: Auto-Update Order Counts (Optimized with Transactions)
// ============================================================================

import {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  FieldValue,
} from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/firestore";
import { db } from "../../firebaseAdmin";
import { SHARED_STORE_IDS } from "../../config";

type InventoryStatus = "NotExists" | "Start" | "Dispatched" | "End" | "Exception";

type InventoryDelta = Partial<{
  blockedStock: FieldValue;
  autoDeduction: FieldValue;
  autoAddition: FieldValue;
}>;

type InventoryChangeMatrix = Record<
  InventoryStatus,
  Partial<Record<InventoryStatus, InventoryDelta>>
>;

const POSSIBLE_INVENTORY_CHANGES = (quantity: number): InventoryChangeMatrix => {
  const incr = FieldValue.increment(quantity);
  const decr = FieldValue.increment(-quantity);
  const same = FieldValue.increment(0);

  return {
    NotExists: {
      Start: { blockedStock: incr },
      Dispatched: { autoDeduction: incr },
      End: { autoAddition: incr },
      Exception: {},
    },

    Start: {
      Dispatched: {
        blockedStock: decr,
        autoDeduction: incr,
      },
      End: {
        blockedStock: decr,
        autoAddition: incr,
      },
      Exception: {
        blockedStock: decr,
      },
    },

    Dispatched: {
      Start: {
        blockedStock: incr,
        autoDeduction: decr,
      },
      End: {
        autoDeduction: same,
        autoAddition: incr,
      },
      Exception: {
        // Not sure yet
        autoDeduction: same,
      },
    },

    End: {
      Start: {
        // Not sure yet
        blockedStock: incr,
        autoAddition: same,
      },
      Dispatched: {
        autoDeduction: same,
        autoAddition: decr,
      },
      Exception: {
        autoAddition: same,
      },
    },

    Exception: {
      Start: { blockedStock: incr },
      Dispatched: { autoDeduction: same }, // This is not likely to happen
      End: { autoAddition: same }, // This is not likely to happen
    },
  };
};

const START_STATUES = ["New", "Confirmed", "Ready To Dispatch"];
const DISPATCHED_STATUSES = [
  "Dispatched",
  "In Transit",
  "Out For Delivery",
  "Delivered",
  "Closed",
  "Lost",
  "RTO In Transit",
  "RTO Delivered",
  "DTO Requested",
  "DTO Booked",
  "DTO In Transit",
  "DTO Delivered",
];
const END_STATUSES = ["RTO Processed", "RTO Closed", "Pending Refunds", "DTO Refunded"];

const mapToInventoryStatus = (customStatus: string | undefined): InventoryStatus => {
  if (!customStatus) return "Exception";

  if (START_STATUES.includes(customStatus)) {
    return "Start";
  } else if (DISPATCHED_STATUSES.includes(customStatus)) {
    return "Dispatched";
  } else if (END_STATUSES.includes(customStatus)) {
    return "End";
  } else {
    return "Exception";
  }
};

const getInventoryChangeStatus = (
  before: DocumentSnapshot,
  after: DocumentSnapshot,
): [InventoryStatus, InventoryStatus] => {
  let beforeStatus: InventoryStatus;
  if (!before.exists) {
    beforeStatus = "NotExists";
  } else {
    beforeStatus = mapToInventoryStatus(before.data()?.customStatus);
  }

  let afterStatus: InventoryStatus;
  if (!after.exists) {
    afterStatus = "NotExists";
  } else {
    afterStatus = mapToInventoryStatus(after.data()?.customStatus);
  }

  return [beforeStatus, afterStatus];
};

// Batch inventory updates for better performance
const updateInventory = async (
  storeId: string,
  orderId: string,
  orderData: DocumentData,
  beforeStatus: InventoryStatus,
  afterStatus: InventoryStatus,
  line_items: any[],
) => {
  if (beforeStatus === afterStatus) {
    console.log(`⏭️ No inventory status change (${beforeStatus}), skipping inventory update`);
    return;
  }

  console.log(`📦 Updating inventory: ${beforeStatus} → ${afterStatus}`);

  // Collect all inventory updates first
  const inventoryUpdates: Array<{
    ref: DocumentReference;
    updates: Record<string, FieldValue>;
    productSku: string;
  }> = [];

  for (const item of line_items) {
    const product_id = String(item.product_id);
    const variant_id = String(item.variant_id);
    const quantity = item.quantity as number;

    if (!product_id || !variant_id || !quantity) continue;

    const matrix = POSSIBLE_INVENTORY_CHANGES(quantity);
    const changes = matrix[beforeStatus]?.[afterStatus];
    if (!changes || !Object.keys(changes).length) continue;

    try {
      const storeProductDoc = await db
        .collection("accounts")
        .doc(storeId)
        .collection("products")
        .doc(product_id)
        .get();

      if (!storeProductDoc.exists) {
        console.warn(`⚠️ Store product ${product_id} not found, skipping`);
        continue;
      }

      const storeProductData = storeProductDoc.data();
      const variantMappingDetails = storeProductData?.variantMappingDetails;

      if (!variantMappingDetails || !variantMappingDetails[variant_id]) {
        console.warn(`⚠️ No variant mapping for ${variant_id}, skipping`);
        continue;
      }

      const { businessId, businessProductSku } = variantMappingDetails[variant_id];

      if (!businessId || !businessProductSku) {
        console.warn(`⚠️ Incomplete mapping for variant ${variant_id}, skipping`);
        continue;
      }

      const businessProductRef = db
        .collection("users")
        .doc(businessId)
        .collection("products")
        .doc(businessProductSku);

      const businessProductDoc = await businessProductRef.get();

      if (!businessProductDoc.exists) {
        console.warn(`⚠️ Business product ${businessProductSku} not found, skipping`);
        continue;
      }

      const BPMappedVariants = businessProductDoc.data()?.mappedVariants as
        | {
            mappedAt: string;
            productId: string;
            productTitle: string;
            storeId: string;
            variantId: number;
            variantSku: string;
            variantTitle: string;
          }[]
        | undefined;

      const productMappedAt = BPMappedVariants?.filter(
        (el) => el.variantId !== item.variant_id,
      )?.[0]?.mappedAt;
      const orderCreatedAt = orderData.createdAt as string;

      if (!productMappedAt) {
        console.warn(
          `⚠️ Mapping details not found in the Business product ${businessProductSku}, skipping`,
        );
        continue;
      }

      const prodMappedDate = new Date(productMappedAt);
      const orderCreatedDate = new Date(orderCreatedAt);

      if (prodMappedDate > orderCreatedDate) {
        console.warn(
          `⚠️ The mapping between business product "${businessProductSku}" and store product variant "${variant_id}" was created after the existence of this order. The inventory will be tracked for only those orders which were created after the mapping creation, skipping.`,
        );
        continue;
      }

      const inventoryUpdates_inner: Record<string, FieldValue> = {};
      for (const [key, value] of Object.entries(changes)) {
        inventoryUpdates_inner[`inventory.${key}`] = value;
      }

      inventoryUpdates.push({
        ref: businessProductRef,
        updates: inventoryUpdates_inner,
        productSku: businessProductSku,
      });
    } catch (error) {
      console.error(
        `❌ Failed to prepare inventory update for product ${product_id}, variant ${variant_id}:`,
        error,
      );
    }
  }

  // Execute all inventory updates in batches
  if (inventoryUpdates.length > 0) {
    const BATCH_SIZE = 500; // Firestore batch limit

    for (let i = 0; i < inventoryUpdates.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const batchItems = inventoryUpdates.slice(i, i + BATCH_SIZE);

      for (const item of batchItems) {
        batch.update(item.ref, item.updates);
      }

      try {
        await batch.commit();
        console.log(`✅ Batch committed: Updated inventory for ${batchItems.length} products`);
      } catch (error) {
        console.error(`❌ Failed to commit inventory batch:`, error);
        // Log which products failed
        batchItems.forEach((item) => {
          console.error(`   - Failed product: ${item.productSku}`);
        });
      }
    }
  }

  console.log(`📦 Inventory update complete for order ${orderId}`);
};

// Update order counts - using set with merge to handle missing documents
const updateOrderCountsWithTransaction = async (
  storeId: string,
  statusUpdates: Record<string, FieldValue>,
  vendors?: string[],
) => {
  const metadataRef = db
    .collection("accounts")
    .doc(storeId)
    .collection("metadata")
    .doc("orderCounts");

  // Use set with merge instead of update to auto-create if needed
  // This prevents "document not found" errors
  await metadataRef.set(
    {
      ...statusUpdates,
      lastUpdated: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  // Update vendor counts with batch if needed
  if (SHARED_STORE_IDS.includes(storeId) && vendors && vendors.length > 0) {
    console.log("Shared Store detected, updating vendor counts...");

    const uniqueVendors = [
      ...new Set(vendors.map((v) => (["ghamand", "bbb"].includes(v.toLowerCase()) ? "OWR" : v))),
    ];

    const batch = db.batch();
    let batchCount = 0;

    for (const vendor of uniqueVendors) {
      try {
        const memberDocQuery = await db
          .collection("accounts")
          .doc(storeId)
          .collection("members")
          .where("vendorName", "==", vendor)
          .limit(1)
          .get();

        if (!memberDocQuery.empty) {
          const vendorRef = memberDocQuery.docs[0].ref;
          const vendorDoc = await vendorRef.get();

          const vendorUpdates = {
            ...statusUpdates,
            lastUpdated: FieldValue.serverTimestamp(),
          };

          if (vendorDoc.exists) {
            batch.update(vendorRef, vendorUpdates);
          } else {
            batch.set(
              vendorRef,
              { counts: statusUpdates, lastUpdated: FieldValue.serverTimestamp() },
              { merge: true },
            );
          }

          batchCount++;
          console.log(`Added vendor ${vendor} to batch`);
        }
      } catch (error) {
        console.error(`❌ Failed to prepare vendor ${vendor} update:`, error);
      }
    }

    // Commit vendor updates batch
    if (batchCount > 0) {
      try {
        await batch.commit();
        console.log(`✅ Vendor batch committed: Updated ${batchCount} vendors`);
      } catch (error) {
        console.error(`❌ Failed to commit vendor batch:`, error);
      }
    }
  }
};

export const updateOrderCounts = onDocumentWritten(
  {
    document: "accounts/{storeId}/orders/{orderId}",
    memory: "256MiB",
  },
  async (event) => {
    const storeId = event.params.storeId;
    const orderId = event.params.orderId;

    console.log(`📝 Order ${orderId} changed in store ${storeId}`);

    const change = event.data;
    if (!change) return;

    const [beforeStatus, afterStatus] = getInventoryChangeStatus(change.before, change.after);

    // ============================================================
    // CASE 1: Order Deleted
    // ============================================================
    if (!change.after.exists) {
      const oldOrder = change.before.data();
      if (!oldOrder) return;

      const oldStatus = oldOrder.customStatus || "New";

      try {
        await updateOrderCountsWithTransaction(
          storeId,
          {
            "counts.All Orders": FieldValue.increment(-1),
            [`counts.${oldStatus}`]: FieldValue.increment(-1),
          },
          oldOrder.vendors,
        );
        console.log(`✅ Decremented count for deleted order (${oldStatus})`);
      } catch (error) {
        console.error(`❌ Failed to update counts for deleted order:`, error);
      }

      const line_items = oldOrder?.raw?.line_items || [];
      await updateInventory(storeId, orderId, oldOrder, beforeStatus, afterStatus, line_items);
      return;
    }

    // ============================================================
    // CASE 2: New Order Created
    // ============================================================
    if (!change.before.exists) {
      const newOrder = change.after.data();
      if (!newOrder) return;

      const newStatus = newOrder.customStatus || "New";

      try {
        await updateOrderCountsWithTransaction(
          storeId,
          {
            "counts.All Orders": FieldValue.increment(1),
            [`counts.${newStatus}`]: FieldValue.increment(1),
          },
          newOrder.vendors,
        );
        console.log(`✅ Incremented count for new order (${newStatus})`);
      } catch (error) {
        console.error(`❌ Failed to update counts for new order:`, error);
      }

      const line_items = newOrder?.raw?.line_items || [];
      await updateInventory(storeId, orderId, newOrder, beforeStatus, afterStatus, line_items);
      return;
    }

    // ============================================================
    // CASE 3: Order Updated
    // ============================================================
    const oldOrder = change.before.data();
    const newOrder = change.after.data();

    if (!oldOrder || !newOrder) return;

    const oldStatus = oldOrder.customStatus || "New";
    const newStatus = newOrder.customStatus || "New";

    if (oldStatus !== newStatus) {
      try {
        await updateOrderCountsWithTransaction(
          storeId,
          {
            [`counts.${oldStatus}`]: FieldValue.increment(-1),
            [`counts.${newStatus}`]: FieldValue.increment(1),
          },
          newOrder.vendors,
        );
        console.log(`✅ Updated counts: ${oldStatus} → ${newStatus}`);
      } catch (error) {
        console.error(`❌ Failed to update counts:`, error);
        if ((error as any).code === "not-found") {
          console.error(
            `⚠️ Metadata not found for ${storeId}. Please run initializeMetadata function first.`,
          );
        }
      }
    } else {
      console.log(`⏭️ No status change for order ${orderId}`);
    }

    const line_items = newOrder?.raw?.line_items || [];
    await updateInventory(storeId, orderId, oldOrder, beforeStatus, afterStatus, line_items);
  },
);
