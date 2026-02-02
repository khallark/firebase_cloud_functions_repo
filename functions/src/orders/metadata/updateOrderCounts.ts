// ============================================================================
// BACKGROUND FUNCTION: Auto-Update Order Counts & Blocked Stock (With Transactions)
// ============================================================================

import {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  FieldValue,
  FieldPath,
} from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/firestore";
import { db } from "../../firebaseAdmin";
import { SHARED_STORE_IDS } from "../../config";

type InventoryStatus = "NotExists" | "Start" | "Dispatched" | "End" | "Exception";

type InventoryDelta = Partial<{
  blockedStock: FieldValue;
}>;

type InventoryChangeMatrix = Record<
  InventoryStatus,
  Partial<Record<InventoryStatus, InventoryDelta>>
>;

const POSSIBLE_INVENTORY_CHANGES = (quantity: number): InventoryChangeMatrix => {
  const incr = FieldValue.increment(quantity);
  const decr = FieldValue.increment(-quantity);

  return {
    NotExists: {
      Start: { blockedStock: incr },
      Dispatched: {},
      End: {},
      Exception: {},
    },

    Start: {
      Dispatched: {
        blockedStock: decr,
      },
      End: {
        blockedStock: decr,
      },
      Exception: {
        blockedStock: decr,
      },
    },

    Dispatched: {
      Start: {
        blockedStock: incr,
      },
      End: {},
      Exception: {},
    },

    End: {
      Start: {
        blockedStock: incr,
      },
      Dispatched: {},
      Exception: {},
    },

    Exception: {
      Start: { blockedStock: incr },
      Dispatched: {},
      End: {},
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

// Update blocked stock using transactions for consistency
const updateBlockedStock = async (
  storeId: string,
  orderId: string,
  orderData: DocumentData,
  beforeStatus: InventoryStatus,
  afterStatus: InventoryStatus,
  line_items: any[],
) => {
  if (beforeStatus === afterStatus) {
    console.log(`⏭️ No inventory status change (${beforeStatus}), skipping blocked stock update`);
    return;
  }

  console.log(`📦 Updating blocked stock: ${beforeStatus} → ${afterStatus}`);

  // Collect all product refs and updates first
  const productUpdates: Array<{
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

      const inventoryUpdates_inner: Record<string, FieldValue> = {};
      for (const [key, value] of Object.entries(changes)) {
        inventoryUpdates_inner[`inventory.${key}`] = value;
      }

      productUpdates.push({
        ref: businessProductRef,
        updates: inventoryUpdates_inner,
        productSku: businessProductSku,
      });
    } catch (error) {
      console.error(
        `❌ Failed to prepare blocked stock update for product ${product_id}, variant ${variant_id}:`,
        error,
      );
    }
  }

  if (productUpdates.length === 0) {
    console.log(`⚠️ No blocked stock updates prepared for order ${orderId}`);
    return;
  }

  console.log(`🔄 Prepared ${productUpdates.length} blocked stock updates for order ${orderId}`);

  // Execute updates in transactions (max 500 docs per transaction)
  const TRANSACTION_LIMIT = 500;

  for (let i = 0; i < productUpdates.length; i += TRANSACTION_LIMIT) {
    const chunk = productUpdates.slice(i, i + TRANSACTION_LIMIT);

    try {
      await db.runTransaction(async (transaction) => {
        // Read all products first (transaction requirement)
        const productDocs = await Promise.all(chunk.map((item) => transaction.get(item.ref)));

        // Verify all products exist
        const missingProducts: string[] = [];
        productDocs.forEach((doc, index) => {
          if (!doc.exists) {
            missingProducts.push(chunk[index].productSku);
          }
        });

        if (missingProducts.length > 0) {
          console.warn(`⚠️ Products not found: ${missingProducts.join(", ")}`);
        }

        // Apply updates
        chunk.forEach((item, index) => {
          if (productDocs[index].exists) {
            console.log(`📝 Updating product ${item.productSku}:`, item.updates);
            transaction.update(item.ref, item.updates);
          }
        });
      });

      console.log(`✅ Transaction committed: Updated blocked stock for ${chunk.length} products`);
    } catch (error) {
      console.error(`❌ Failed to commit transaction for products:`, error);
      chunk.forEach((item) => {
        console.error(`   - Failed product: ${item.productSku}`);
      });
    }
  }

  console.log(`📦 Blocked stock update complete for order ${orderId}`);
};

// Define the complete order counts schema
// const ORDER_COUNTS_SCHEMA: Record<string, number> = {
//   "All Orders": 0,
//   New: 0,
//   Confirmed: 0,
//   "Ready To Dispatch": 0,
//   Dispatched: 0,
//   "In Transit": 0,
//   "Out For Delivery": 0,
//   Delivered: 0,
//   "RTO In Transit": 0,
//   "RTO Delivered": 0,
//   "DTO Requested": 0,
//   "DTO Booked": 0,
//   "DTO In Transit": 0,
//   "DTO Delivered": 0,
//   "Pending Refunds": 0,
//   "DTO Refunded": 0,
//   Lost: 0,
//   Closed: 0,
//   "RTO Processed": 0,
//   "RTO Closed": 0,
//   "Cancellation Requested": 0,
//   Cancelled: 0,
// };

// Update order counts using FieldValue.increment() - NO TRANSACTIONS
// This eliminates contention issues during bulk operations
// Uses FieldPath to properly handle status names with spaces
const updateOrderCountsWithIncrement = async (
  storeId: string,
  statusUpdates: Record<string, number>,
  vendors?: string[],
) => {
  const metadataRef = db
    .collection("accounts")
    .doc(storeId)
    .collection("metadata")
    .doc("orderCounts");

  try {
    // Build update parameters as alternating field-value pairs
    // This properly handles field names with spaces
    const updateArgs: any[] = [];

    Object.entries(statusUpdates).forEach(([key, delta]) => {
      // Use FieldPath to properly escape field names with spaces
      updateArgs.push(new FieldPath("counts", key));
      updateArgs.push(FieldValue.increment(delta));
    });

    // Add lastUpdated timestamp
    updateArgs.push("lastUpdated");
    updateArgs.push(FieldValue.serverTimestamp());

    // Update metadata counts using alternating field-value pairs
    // This is the proper way to handle FieldPath with special characters
    // Type assertion needed for TypeScript to accept the spread operator
    await metadataRef.update(
      updateArgs[0] as string | FieldPath,
      updateArgs[1],
      ...updateArgs.slice(2),
    );

    console.log(`✅ Order counts updated using increments:`, statusUpdates);

    // Handle vendor updates if this is a shared store
    if (SHARED_STORE_IDS.includes(storeId) && vendors && vendors.length > 0) {
      console.log("Shared Store detected, updating vendor counts...");

      const uniqueVendors = [
        ...new Set(vendors.map((v) => (["ghamand", "bbb"].includes(v.toLowerCase()) ? "OWR" : v))),
      ];

      // Update all vendors in parallel (each uses atomic increment)
      const vendorUpdates = uniqueVendors.map(async (vendor) => {
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

            // Build vendor update parameters
            const vendorUpdateArgs: any[] = [];

            Object.entries(statusUpdates).forEach(([key, delta]) => {
              vendorUpdateArgs.push(new FieldPath("counts", key));
              vendorUpdateArgs.push(FieldValue.increment(delta));
            });

            vendorUpdateArgs.push("lastUpdated");
            vendorUpdateArgs.push(FieldValue.serverTimestamp());

            await vendorRef.update(
              vendorUpdateArgs[0] as string | FieldPath,
              vendorUpdateArgs[1],
              ...vendorUpdateArgs.slice(2),
            );
            console.log(`✅ Updated vendor ${vendor} counts`);
          } else {
            console.warn(`⚠️ Vendor ${vendor} not found`);
          }
        } catch (error) {
          console.error(`❌ Failed to update vendor ${vendor}:`, error);
        }
      });

      await Promise.all(vendorUpdates);
      console.log(`✅ All vendor counts updated (${uniqueVendors.length} vendors)`);
    }
  } catch (error) {
    console.error(`❌ Failed to update order counts:`, error);
    throw error;
  }
};

// Helper function to initialize order counts schema (call once per store/vendor)
// This ensures all count fields exist before increments are used
// export const initializeOrderCounts = async (
//   docRef: DocumentReference,
// ): Promise<void> => {
//   try {
//     await docRef.set(
//       {
//         counts: ORDER_COUNTS_SCHEMA,
//         lastUpdated: FieldValue.serverTimestamp(),
//       },
//       { merge: true },
//     );
//     console.log(`✅ Initialized order counts schema`);
//   } catch (error) {
//     console.error(`❌ Failed to initialize order counts:`, error);
//   }
// };

export const updateOrderCounts = onDocumentWritten(
  {
    document: "accounts/{storeId}/orders/{orderId}",
    memory: "512MiB",
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
        await updateOrderCountsWithIncrement(
          storeId,
          {
            "All Orders": -1,
            [oldStatus]: -1,
          },
          oldOrder.vendors,
        );
        console.log(`✅ Decremented count for deleted order (${oldStatus})`);
      } catch (error) {
        console.error(`❌ Failed to update counts for deleted order:`, error);
      }

      const line_items = oldOrder?.raw?.line_items || [];
      await updateBlockedStock(storeId, orderId, oldOrder, beforeStatus, afterStatus, line_items);
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
        await updateOrderCountsWithIncrement(
          storeId,
          {
            "All Orders": 1,
            [newStatus]: 1,
          },
          newOrder.vendors,
        );
        console.log(`✅ Incremented count for new order (${newStatus})`);
      } catch (error) {
        console.error(`❌ Failed to update counts for new order:`, error);
      }

      const line_items = newOrder?.raw?.line_items || [];
      await updateBlockedStock(storeId, orderId, newOrder, beforeStatus, afterStatus, line_items);
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
        await updateOrderCountsWithIncrement(
          storeId,
          {
            [oldStatus]: -1,
            [newStatus]: 1,
          },
          newOrder.vendors,
        );
        console.log(`✅ Updated counts: ${oldStatus} → ${newStatus}`);
      } catch (error) {
        console.error(`❌ Failed to update counts:`, error);
      }
    } else {
      console.log(`⏭️ No status change for order ${orderId}`);
    }

    const line_items = newOrder?.raw?.line_items || [];
    await updateBlockedStock(storeId, orderId, oldOrder, beforeStatus, afterStatus, line_items);
  },
);