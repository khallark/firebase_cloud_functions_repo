// functions/src/generateTableData.ts
import { onRequest } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { ENQUEUE_FUNCTION_SECRET, SHARED_STORE_ID, SUPER_ADMIN_ID } from "../../config";
import { requireHeaderSecret } from "../../helpers";
import { db } from "../../firebaseAdmin";

// Define the status categories with their individual statuses
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

// All status labels for display purposes
// const STATUS_LABELS: Record<string, string> = {
//   // Cancellations
//   "Cancellation Requested": "Cancellation Requested",
//   Cancelled: "Cancelled",
//   // Pending Dispatch
//   New: "New",
//   Confirmed: "Confirmed",
//   "Ready To Dispatch": "Ready To Dispatch",
//   // Returns
//   "RTO Delivered": "RTO Delivered",
//   "RTO Closed": "RTO Closed",
//   "RTO In Transit": "RTO In Transit",
//   "DTO Delivered": "DTO Delivered",
//   "Pending Refund": "Pending Refund",
//   "DTO Refunded": "DTO Refunded",
//   Lost: "Lost",
//   // In Transit
//   Dispatched: "Dispatched",
//   "In Transit": "In Transit",
//   "Out For Delivery": "Out For Delivery",
//   "DTO Requested": "DTO Requested",
//   "DTO Booked": "DTO Booked",
//   "DTO In Transit": "DTO In Transit",
//   // Delivered
//   Closed: "Closed",
//   Delivered: "Delivered",
// };

interface TableRowData {
  orderCount: number;
  itemCount: number;
  netSaleValue: number;
}

interface StatusBreakdown {
  [status: string]: TableRowData;
}

interface CategoryData extends TableRowData {
  breakdown: StatusBreakdown;
}

interface TableData {
  grossSales: TableRowData;
  cancellations: CategoryData;
  pendingDispatch: CategoryData;
  returns: CategoryData;
  inTransit: CategoryData;
  delivered: CategoryData;
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

// Initialize empty row data
function initializeRowData(): TableRowData {
  return { orderCount: 0, itemCount: 0, netSaleValue: 0 };
}

// Initialize empty category data with breakdown
function initializeCategoryData(statuses: string[]): CategoryData {
  const breakdown: StatusBreakdown = {};
  statuses.forEach((status) => {
    breakdown[status] = initializeRowData();
  });
  return {
    orderCount: 0,
    itemCount: 0,
    netSaleValue: 0,
    breakdown,
  };
}

// Initialize empty table data
function initializeTableData(): TableData {
  return {
    grossSales: initializeRowData(),
    cancellations: initializeCategoryData(STATUS_CATEGORIES.cancellations),
    pendingDispatch: initializeCategoryData(STATUS_CATEGORIES.pendingDispatch),
    returns: initializeCategoryData(STATUS_CATEGORIES.returns),
    inTransit: initializeCategoryData(STATUS_CATEGORIES.inTransit),
    delivered: initializeCategoryData(STATUS_CATEGORIES.delivered),
  };
}

// Add to row data
function addToRowData(target: TableRowData, itemCount: number, netSaleValue: number): void {
  target.orderCount += 1;
  target.itemCount += itemCount;
  target.netSaleValue += netSaleValue;
}

// Categorize and accumulate order data
function categorizeOrder(order: OrderDoc, tableData: TableData): void {
  const status = order.customStatus || "";
  const itemCount = calculateItemCount(order);
  const netSaleValue = getNetSaleValue(order);

  // Always add to gross sales
  addToRowData(tableData.grossSales, itemCount, netSaleValue);

  // Categorize by status and update both category totals and breakdown
  if (STATUS_CATEGORIES.cancellations.includes(status)) {
    addToRowData(tableData.cancellations, itemCount, netSaleValue);
    addToRowData(tableData.cancellations.breakdown[status], itemCount, netSaleValue);
  } else if (STATUS_CATEGORIES.pendingDispatch.includes(status)) {
    addToRowData(tableData.pendingDispatch, itemCount, netSaleValue);
    addToRowData(tableData.pendingDispatch.breakdown[status], itemCount, netSaleValue);
  } else if (STATUS_CATEGORIES.returns.includes(status)) {
    addToRowData(tableData.returns, itemCount, netSaleValue);
    addToRowData(tableData.returns.breakdown[status], itemCount, netSaleValue);
  } else if (STATUS_CATEGORIES.inTransit.includes(status)) {
    addToRowData(tableData.inTransit, itemCount, netSaleValue);
    addToRowData(tableData.inTransit.breakdown[status], itemCount, netSaleValue);
  } else if (STATUS_CATEGORIES.delivered.includes(status)) {
    addToRowData(tableData.delivered, itemCount, netSaleValue);
    addToRowData(tableData.delivered.breakdown[status], itemCount, netSaleValue);
  }
}

// Round all values in the table data
function roundTableData(tableData: TableData): void {
  // Round gross sales
  tableData.grossSales.netSaleValue = Math.round(tableData.grossSales.netSaleValue * 100) / 100;

  // Round each category and its breakdown
  const categories: (keyof Omit<TableData, "grossSales">)[] = [
    "cancellations",
    "pendingDispatch",
    "returns",
    "inTransit",
    "delivered",
  ];

  categories.forEach((category) => {
    const categoryData = tableData[category];
    categoryData.netSaleValue = Math.round(categoryData.netSaleValue * 100) / 100;

    Object.keys(categoryData.breakdown).forEach((status) => {
      categoryData.breakdown[status].netSaleValue =
        Math.round(categoryData.breakdown[status].netSaleValue * 100) / 100;
    });
  });
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

      // Round all net sale values to 2 decimal places
      roundTableData(aggregatedData);

      console.log("📊 Aggregated data:", JSON.stringify(aggregatedData, null, 2));

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
