// functions/src/generateTableData.ts
import { onRequest } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { ENQUEUE_FUNCTION_SECRET, SHARED_STORE_ID, SUPER_ADMIN_ID } from "../../config";
import { requireHeaderSecret } from "../../helpers";
import { db } from "../../firebaseAdmin";

// Define the status categories
const STATUS_CATEGORIES = {
  cancellations: ["Cancellation Requested", "Cancelled"],
  pendingDispatch: ["New", "Confirmed", "Ready To Dispatch"],
  returns: [
    "RTO Delivered",
    "RTO Closed",
    "RTO In Transit",
    "DTO Delivered",
    "Pending Refund",
    "DTO Refunded",
    "Lost",
  ],
  inTransit: [
    "Dispatched",
    "In Transit",
    "Out For Delivery",
    "DTO Requested",
    "DTO Booked",
    "DTO In Transit",
  ],
  delivered: ["Closed", "Delivered"],
};

interface TableRowData {
  orderCount: number;
  itemCount: number;
  netSaleValue: number;
}

interface TableData {
  grossSales: TableRowData;
  cancellations: TableRowData;
  pendingDispatch: TableRowData;
  returns: TableRowData;
  inTransit: TableRowData;
  delivered: TableRowData;
}

interface OrderDoc {
  customStatus?: string;
  createdAt?: string;
  raw?: {
    line_items?: Array<{ quantity?: number }>;
    total_price?: string | number;
  };
  refundedAmount?: string | number;
}

// Helper function to calculate item count from line_items
function calculateItemCount(order: OrderDoc): number {
  if (!order.raw?.line_items || !Array.isArray(order.raw.line_items)) {
    return 0;
  }
  return order.raw.line_items.reduce((sum, item) => {
    return sum + (Number(item.quantity) || 0);
  }, 0);
}

// Helper function to get net sale value
function getNetSaleValue(order: OrderDoc): number {
  // Special case for DTO Refunded - use refundedAmount
  if (order.customStatus === "DTO Refunded" && order.refundedAmount !== undefined) {
    return Number(order.refundedAmount) || 0;
  }
  return Number(order.raw?.total_price) || 0;
}

// Helper function to check if order falls within date range (IST aware)
function isWithinDateRange(orderCreatedAt: string, startTime: string, endTime: string): boolean {
  const orderDate = new Date(orderCreatedAt);
  const startDate = new Date(startTime);
  const endDate = new Date(endTime);

  return orderDate >= startDate && orderDate <= endDate;
}

// Initialize empty table data
function initializeTableData(): TableData {
  return {
    grossSales: { orderCount: 0, itemCount: 0, netSaleValue: 0 },
    cancellations: { orderCount: 0, itemCount: 0, netSaleValue: 0 },
    pendingDispatch: { orderCount: 0, itemCount: 0, netSaleValue: 0 },
    returns: { orderCount: 0, itemCount: 0, netSaleValue: 0 },
    inTransit: { orderCount: 0, itemCount: 0, netSaleValue: 0 },
    delivered: { orderCount: 0, itemCount: 0, netSaleValue: 0 },
  };
}

// Categorize and accumulate order data
function categorizeOrder(order: OrderDoc, tableData: TableData): void {
  const status = order.customStatus || "";
  const itemCount = calculateItemCount(order);
  const netSaleValue = getNetSaleValue(order);

  // Always add to gross sales
  tableData.grossSales.orderCount += 1;
  tableData.grossSales.itemCount += itemCount;
  tableData.grossSales.netSaleValue += netSaleValue;

  // Categorize by status
  if (STATUS_CATEGORIES.cancellations.includes(status)) {
    tableData.cancellations.orderCount += 1;
    tableData.cancellations.itemCount += itemCount;
    tableData.cancellations.netSaleValue += netSaleValue;
  } else if (STATUS_CATEGORIES.pendingDispatch.includes(status)) {
    tableData.pendingDispatch.orderCount += 1;
    tableData.pendingDispatch.itemCount += itemCount;
    tableData.pendingDispatch.netSaleValue += netSaleValue;
  } else if (STATUS_CATEGORIES.returns.includes(status)) {
    tableData.returns.orderCount += 1;
    tableData.returns.itemCount += itemCount;
    tableData.returns.netSaleValue += netSaleValue;
  } else if (STATUS_CATEGORIES.inTransit.includes(status)) {
    tableData.inTransit.orderCount += 1;
    tableData.inTransit.itemCount += itemCount;
    tableData.inTransit.netSaleValue += netSaleValue;
  } else if (STATUS_CATEGORIES.delivered.includes(status)) {
    tableData.delivered.orderCount += 1;
    tableData.delivered.itemCount += itemCount;
    tableData.delivered.netSaleValue += netSaleValue;
  }
}

export const generateTableData = onRequest(
  {
    timeoutSeconds: 540, // 9 minutes max
    memory: "1GiB",
    secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

    // Only allow POST
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { businessId, stores, startTime, endTime } = req.body;

    // Validate inputs
    if (!businessId || typeof businessId !== "string") {
      res.status(400).json({ error: "businessId is required" });
      return;
    }

    if (!stores || !Array.isArray(stores) || stores.length === 0) {
      res.status(400).json({ error: "stores must be a non-empty array" });
      return;
    }

    if (!startTime || !endTime) {
      res.status(400).json({ error: "startTime and endTime are required" });
      return;
    }

    console.log("📊 Starting table data generation:", {
      businessId,
      stores,
      startTime,
      endTime,
    });

    const businessDocRef = db.collection("users").doc(businessId);

    try {
      // Initialize aggregated table data
      const aggregatedData = initializeTableData();

      // Process each store
      for (const storeId of stores) {
        console.log(`📦 Processing store: ${storeId}`);

        const storeRef = db.collection("accounts").doc(storeId);
        const ordersRef = db.collection("accounts").doc(storeId).collection("orders");

        // Query orders within date range
        // Using createdAt field for date filtering
        let ordersQuery = null;
        if (storeId === SHARED_STORE_ID) {
          if (businessId == SUPER_ADMIN_ID) {
            ordersQuery = ordersRef
              .where("createdAt", ">=", startTime)
              .where("createdAt", "<=", endTime);
          } else {
            const memberDoc = await storeRef.collection("members").doc(businessId).get();
            if (memberDoc.exists && memberDoc.data()?.vendorName) {
              const vendorName = memberDoc.data()?.vendorName;
              if (vendorName === "OWR") {
                const allPermutations = [
                  ["OWR"],
                  ["Ghamand"],
                  ["BBB"],
                  ["OWR", "Ghamand"],
                  ["Ghamand", "OWR"],
                  ["OWR", "BBB"],
                  ["BBB", "OWR"],
                  ["Ghamand", "BBB"],
                  ["BBB", "Ghamand"],
                  ["OWR", "Ghamand", "BBB"],
                  ["OWR", "BBB", "Ghamand"],
                  ["Ghamand", "OWR", "BBB"],
                  ["Ghamand", "BBB", "OWR"],
                  ["BBB", "OWR", "Ghamand"],
                  ["BBB", "Ghamand", "OWR"],
                ];
                ordersQuery = ordersRef
                  .where("createdAt", ">=", startTime)
                  .where("createdAt", "<=", endTime)
                  .where("vendors", "in", allPermutations);
              } else {
                ordersQuery = ordersRef
                  .where("createdAt", ">=", startTime)
                  .where("createdAt", "<=", endTime)
                  .where("vendors", "array-contains", vendorName);
              }
            } else {
              ordersQuery = ordersRef.where("some-random-shit", "==", "some-random-shit");
            }
          }
        } else {
          ordersQuery = ordersRef
            .where("createdAt", ">=", startTime)
            .where("createdAt", "<=", endTime);
        }

        const ordersSnapshot = await ordersQuery.get();

        console.log(`   Found ${ordersSnapshot.size} orders for store ${storeId}`);

        // Process each order
        ordersSnapshot.forEach((doc) => {
          const order = doc.data() as OrderDoc;

          // Double-check date range (in case of timezone issues)
          if (order.createdAt && isWithinDateRange(order.createdAt, startTime, endTime)) {
            categorizeOrder(order, aggregatedData);
          }
        });
      }

      // Round net sale values to 2 decimal places
      Object.keys(aggregatedData).forEach((key) => {
        const category = key as keyof TableData;
        aggregatedData[category].netSaleValue =
          Math.round(aggregatedData[category].netSaleValue * 100) / 100;
      });

      console.log("📊 Aggregated data:", aggregatedData);

      // Update the business document with the calculated data
      await businessDocRef.update({
        "tableData.loading": false,
        "tableData.lastUpdated": Timestamp.now(),
        "tableData.startTime": startTime,
        "tableData.endTime": endTime,
        "tableData.stores": stores,
        "tableData.data": aggregatedData,
        "tableData.error": null,
      });

      console.log("✅ Table data generation completed successfully");

      res.status(200).json({
        success: true,
        message: "Table data generated successfully",
        data: aggregatedData,
      });
    } catch (error: any) {
      console.error("❌ Error generating table data:", error);

      // Update document with error state
      try {
        await businessDocRef.update({
          "tableData.loading": false,
          "tableData.error": error.message || "Unknown error occurred",
          "tableData.lastUpdated": Timestamp.now(),
        });
      } catch (updateError) {
        console.error("Failed to update error state:", updateError);
      }

      res.status(500).json({
        success: false,
        error: "Failed to generate table data",
        message: error.message,
      });
    }
  },
);
