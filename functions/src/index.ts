// ============================================================================
// CLOUD FUNCTIONS - Direct Exports Only
// ============================================================================

import { setGlobalOptions } from "firebase-functions/v2";

setGlobalOptions({ region: process.env.LOCATION || "asia-south1" });

// Shipments - Forward
export { enqueueShipmentTasks } from "./shipments/forward/enqueueShipmentTasks";
export { processShipmentTask } from "./shipments/forward/processShipmentTask";
export { processShipmentTask2 } from "./shipments/forward/processShipmentTask2";
export { processShipmentTask3 } from "./shipments/forward/processShipmentTask3";
export { handlePriorityFallback } from "./shipments/forward/handlePriorityFallback";

// Shipments - Reverse
export { enqueueReturnShipmentTasks } from "./shipments/reverse/enqueueReturnShipmentTask";
export { processReturnShipmentTask } from "./shipments/reverse/processReturnShipmentTask";

// Orders - Fulfillment
export { enqueueOrdersFulfillmentTasks } from "./orders/fullfilment/enqueue";
export { processFulfillmentTask } from "./orders/fullfilment/process";

// Orders - Metadata
export { initializeMetadata } from "./orders/metadata/initializeMetadata";
export { updateOrderCounts } from "./orders/metadata/updateOrderCounts";

// Orders - Splitting
export { enqueueOrderSplitBatch } from "./orders/splitting/enqueue";
export { processOrderSplitJob } from "./orders/splitting/process";

// Status Updates - Delhivery
export { enqueueDelhiveryStatusUpdateTasksScheduled } from "./statusUpdates/delhivery/enqueue";
export { updateDelhiveryStatusesJob } from "./statusUpdates/delhivery/process";

// Status Updates - Shiprocket
export { enqueueShiprocketStatusUpdateTasksScheduled } from "./statusUpdates/shiprocket/enqueue";
export { updateShiprocketStatusesJob } from "./statusUpdates/shiprocket/process";

// Status Updates - Xpressbees
export { enqueueXpressbeesStatusUpdateTasksScheduled } from "./statusUpdates/xpressbees/enqueue";
export { updateXpressbeesStatusesJob } from "./statusUpdates/xpressbees/process";

// Scheduled Jobs
export { checkDelayedConfirmedOrders } from "./scheduledJobs/checkDelayed";
export { processDelayedOrdersTask } from "./scheduledJobs/checkDelayed";
export { closeDeliveredOrdersJob } from "./scheduledJobs/closeDelivered";
export { closeDeliveredOrdersTask } from "./scheduledJobs/closeDelivered";

// Migrations
export { migrateCancelledOrdersStatus } from "./migrations/migrateCancelledOrders";
export { migrateCourierProviders } from "./migrations/migrateCourierProviders";
export { migrateVendorsField } from "./migrations/migrateVendorsField";
export { syncSharedStoreProductsBasic } from "./migrations/syncSharedStoreProductsBasic";

// Reports
export { generateDailyTaxReport } from "./reports/taxReport/generateDaily";
export { generateUnavailableStockReport } from "./reports/unavailableStocks/generateReport";
export { generateUnavailableStockReportOnRequest } from "./reports/unavailableStocks/generateReport";
export { generateSharedStoreOrdersExcel } from "./reports/ordersExcel/generateExcel";

// ❌ DO NOT EXPORT INTERNAL MODULES
// NO export * from "./config"
// NO export * from "./helpers"
// NO export * from "./services"
