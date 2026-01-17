// ============================================================================
// BACKGROUND FUNCTION: Auto-Update Order Counts & Blocked Stock (With Transactions)
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

// Update order counts using a proper transaction
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

  // Build updates with proper dot notation for nested fields
  const countUpdates: Record<string, FieldValue | any> = {};
  Object.entries(statusUpdates).forEach(([key, value]) => {
    countUpdates[`counts.${key}`] = value;
  });
  countUpdates["lastUpdated"] = FieldValue.serverTimestamp();

  // Get vendor refs if needed
  const vendorRefs: DocumentReference[] = [];

  if (SHARED_STORE_IDS.includes(storeId) && vendors && vendors.length > 0) {
    console.log("Shared Store detected, preparing vendor count updates...");

    const uniqueVendors = [
      ...new Set(vendors.map((v) => (["ghamand", "bbb"].includes(v.toLowerCase()) ? "OWR" : v))),
    ];

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
          vendorRefs.push(memberDocQuery.docs[0].ref);
          console.log(`Added vendor ${vendor} to transaction`);
        }
      } catch (error) {
        console.error(`❌ Failed to prepare vendor ${vendor}:`, error);
      }
    }
  }

  // Execute everything in a single transaction for consistency
  try {
    await db.runTransaction(async (transaction) => {
      // Read all documents first (transaction requirement)
      const metadataDoc = await transaction.get(metadataRef);
      const vendorDocs = await Promise.all(vendorRefs.map((ref) => transaction.get(ref)));

      // Update order counts metadata
      if (metadataDoc.exists) {
        transaction.update(metadataRef, countUpdates);
      } else {
        // Initialize if doesn't exist
        transaction.set(metadataRef, {
          counts: {},
          lastUpdated: FieldValue.serverTimestamp(),
        });
        transaction.update(metadataRef, countUpdates);
      }

      // Update vendor counts
      const vendorUpdates: Record<string, FieldValue | any> = {};
      Object.entries(statusUpdates).forEach(([key, value]) => {
        vendorUpdates[`counts.${key}`] = value;
      });
      vendorUpdates["lastUpdated"] = FieldValue.serverTimestamp();

      vendorDocs.forEach((vendorDoc, index) => {
        if (vendorDoc.exists) {
          transaction.update(vendorRefs[index], vendorUpdates);
        } else {
          // Initialize if doesn't exist
          transaction.set(vendorRefs[index], {
            counts: {},
            lastUpdated: FieldValue.serverTimestamp(),
          });
          transaction.update(vendorRefs[index], vendorUpdates);
        }
      });
    });

    console.log(`✅ Order counts transaction committed (${vendorRefs.length} vendors updated)`);
  } catch (error) {
    console.error(`❌ Failed to update order counts:`, error);
    throw error; // Re-throw to handle at caller level
  }
};

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
        await updateOrderCountsWithTransaction(
          storeId,
          {
            "All Orders": FieldValue.increment(-1),
            [oldStatus]: FieldValue.increment(-1),
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
        await updateOrderCountsWithTransaction(
          storeId,
          {
            "All Orders": FieldValue.increment(1),
            [newStatus]: FieldValue.increment(1),
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
        await updateOrderCountsWithTransaction(
          storeId,
          {
            [oldStatus]: FieldValue.increment(-1),
            [newStatus]: FieldValue.increment(1),
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
