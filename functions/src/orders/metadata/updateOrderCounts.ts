// ============================================================================
// BACKGROUND FUNCTION: Auto-Update Order Counts
// ============================================================================

import { DocumentSnapshot, FieldValue } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/firestore";
import { db } from "../../firebaseAdmin";
import { SHARED_STORE_ID } from "../../config";

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
const END_STATUSES = ["RTO Closed", "Pending Refunds", "DTO Refunded"];

// Helper function to map customStatus to InventoryStatus
const mapToInventoryStatus = (customStatus: string | undefined): InventoryStatus => {
  if (!customStatus) return "Exception"; // Fallback for undefined status

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
  // -------------------------
  // BEFORE
  // -------------------------
  let beforeStatus: InventoryStatus;

  if (!before.exists) {
    beforeStatus = "NotExists";
  } else {
    beforeStatus = mapToInventoryStatus(before.data()?.customStatus);
  }

  // -------------------------
  // AFTER
  // -------------------------
  let afterStatus: InventoryStatus;

  if (!after.exists) {
    afterStatus = "NotExists";
  } else {
    afterStatus = mapToInventoryStatus(after.data()?.customStatus);
  }

  return [beforeStatus, afterStatus];
};

// Extracted inventory update logic with its own error handling
const updateInventory = async (
  storeId: string,
  orderId: string,
  beforeStatus: InventoryStatus,
  afterStatus: InventoryStatus,
  line_items: any[],
) => {
  // Skip if no actual transition
  if (beforeStatus === afterStatus) {
    console.log(`⏭️ No inventory status change (${beforeStatus}), skipping inventory update`);
    return;
  }

  console.log(`📦 Updating inventory: ${beforeStatus} → ${afterStatus}`);

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

      const businessProductDoc = await db
        .collection("users")
        .doc(businessId)
        .collection("products")
        .doc(businessProductSku)
        .get();

      if (!businessProductDoc.exists) {
        console.warn(`⚠️ Business product ${businessProductSku} not found, skipping`);
        continue;
      }

      const inventoryUpdates: Record<string, FieldValue> = {};
      for (const [key, value] of Object.entries(changes)) {
        inventoryUpdates[`inventory.${key}`] = value;
      }

      await businessProductDoc.ref.update(inventoryUpdates);

      console.log(`✅ Updated inventory for business product ${businessProductSku}`);
    } catch (error) {
      // Log but don't throw - continue processing other items
      console.error(
        `❌ Failed to update inventory for product ${product_id}, variant ${variant_id}:`,
        error,
      );
    }
  }

  console.log(`📦 Inventory update complete for order ${orderId}`);
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

    const metadataRef = db
      .collection("accounts")
      .doc(storeId)
      .collection("metadata")
      .doc("orderCounts");

    const change = event.data;
    if (!change) return;

    // Get inventory status transition for all cases
    const [beforeStatus, afterStatus] = getInventoryChangeStatus(change.before, change.after);

    // ============================================================
    // CASE 1: Order Deleted
    // ============================================================
    if (!change.after.exists) {
      const oldOrder = change.before.data();
      if (!oldOrder) return;

      const oldStatus = oldOrder.customStatus || "New";

      try {
        await metadataRef.set(
          {
            counts: {
              "All Orders": FieldValue.increment(-1),
              [oldStatus]: FieldValue.increment(-1),
            },
            lastUpdated: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        console.log(`✅ Decremented count for deleted order (${oldStatus})`);
      } catch (error) {
        console.error(`❌ Failed to update counts for deleted order:`, error);
      }

      // Update inventory for deletion (has its own error handling)
      const line_items = oldOrder?.raw?.line_items || [];
      await updateInventory(storeId, orderId, beforeStatus, afterStatus, line_items);
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
        await metadataRef.set(
          {
            counts: {
              "All Orders": FieldValue.increment(1),
              [newStatus]: FieldValue.increment(1),
            },
            lastUpdated: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        if (storeId === SHARED_STORE_ID && newOrder.vendors && Array.isArray(newOrder.vendors)) {
          console.log(
            "Shared Store detected, incrementing the 'All Orders' count of vendors too...",
          );
          const vendors = newOrder.vendors;
          for (const vendor of vendors) {
            const memberDocQuery = await db
              .collection("accounts")
              .doc(storeId)
              .collection("members")
              .where("vendorName", "==", vendor)
              .get();

            if (!memberDocQuery.empty) {
              await memberDocQuery.docs[0].ref.set(
                {
                  counts: {
                    "All Orders": FieldValue.increment(1),
                    [newStatus]: FieldValue.increment(1),
                  },
                  lastUpdated: FieldValue.serverTimestamp(),
                },
                { merge: true },
              );
              console.log(`Vendor ${vendor} Counts updated!`);
            }
          }
        }

        console.log(`✅ Incremented count for new order (${newStatus})`);
      } catch (error) {
        console.error(`❌ Failed to update counts for new order:`, error);
      }

      // Update inventory for new order
      const line_items = newOrder?.raw?.line_items || [];
      await updateInventory(storeId, orderId, beforeStatus, afterStatus, line_items);
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

    // Update counts only if customStatus changed
    if (oldStatus !== newStatus) {
      try {
        const updates: any = {
          lastUpdated: FieldValue.serverTimestamp(),
          [`counts.${oldStatus}`]: FieldValue.increment(-1),
          [`counts.${newStatus}`]: FieldValue.increment(1),
        };

        await metadataRef.update(updates);

        if (storeId === SHARED_STORE_ID && newOrder.vendors && Array.isArray(newOrder.vendors)) {
          console.log("Shared Store detected, updating count of vendors too...");
          for (const vendor of newOrder.vendors) {
            const memberDocQuery = await db
              .collection("accounts")
              .doc(storeId)
              .collection("members")
              .where("vendorName", "==", vendor)
              .get();

            if (!memberDocQuery.empty) {
              await memberDocQuery.docs[0].ref.update(updates);
              console.log(`Vendor ${vendor} Counts updated!`);
            }
          }
        }

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

    // Always attempt inventory update
    const line_items = newOrder?.raw?.line_items || [];
    await updateInventory(storeId, orderId, beforeStatus, afterStatus, line_items);
  },
);
