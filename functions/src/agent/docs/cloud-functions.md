# Majime Platform — Cloud Functions Reference

All Cloud Functions live in a separate Firebase Functions repository.
The root `functions/src/index.ts` barrel-exports everything:

```
shipments       → forward (Delhivery, Shiprocket, Xpressbees, Blue Dart, Priority) + reverse
orders          → fulfillment dispatch, order splitting, order count trigger
statusUpdates   → polling loops for all four couriers (runs every 2 hours)
scheduledJobs   → delayed order alerts, auto-close delivered, daily inventory snapshot
reports         → dashboard table, gross profit, remittance, tax report, purchase report, etc.
warehouse       → UPC trigger, placement trigger, shelf/rack/zone/warehouse triggers, propagation
inventory       → product write trigger (Shopify sync), restock recommendation HTTP functions
B2B_OMS_INVENTORY_WAREHOUSE → B2B lot/order/reservation triggers + scheduled delay recompute
agent           → onAgentMessageCreated (Gemini chat handler)
```

Authentication patterns used across functions:
- **HTTP functions (user-triggered)**: `requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET)` — secret sent by Next.js API routes, never the browser.
- **Cloud Task workers**: `requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET)` — secret injected into task payloads by Cloud Tasks.
- **Firestore triggers**: no auth — fire automatically on document writes.
- **Scheduled functions**: no auth — triggered by Cloud Scheduler.

---

## SECTION 1 — SHIPMENTS (FORWARD)

### How AWB assignment flows end-to-end

```
Browser (Orders page) → "Assign AWBs"
  ↓
Next.js API: POST /api/shopify/courier/assign-awb
  ↓  (validates, calls with ENQUEUE_FUNCTION_SECRET)
Cloud Function: enqueueShipmentTasks
  ↓  (creates batch + job docs, enqueues Cloud Tasks)
Cloud Tasks queue: shipments-queue
  ↓  (one task per order)
Cloud Function: processShipmentTask / processShipmentTask2 / processShipmentTask3 / processBlueDartShipmentTask
  ↓  (calls carrier API, writes AWB + status "Ready To Dispatch" to order doc)
Firestore trigger: updateOrderCounts  (on every order write)
  ↓  updates metadata/orderCounts + blockedStock on business products
Frontend: onSnapshot on shipment_batches → real-time progress on AWB Processing page
```

### `enqueueShipmentTasks` [onRequest, authenticated with ENQUEUE_FUNCTION_SECRET]

Called by: `POST /api/shopify/courier/assign-awb` (Next.js API route).

What it does:
1. Validates `businessId`, `shop`, `orders[]`, `courier`, `pickupName`, `shippingMode`.
2. Resolves the correct Cloud Task target URL based on courier:
   - `Delhivery` → `SHIPMENT_TASK_TARGET_URL_1`
   - `Shiprocket` → `SHIPMENT_TASK_TARGET_URL_2`
   - `Xpressbees` → `SHIPMENT_TASK_TARGET_URL_3`
   - `Blue Dart` → `SHIPMENT_TASK_TARGET_URL_4`
   - `Priority` → reads `integrations.couriers.priorityList[0].name` from business doc, uses its URL.
3. Creates a `shipment_batches` doc at `users/{businessId}/shipment_batches/{batchId}` with `{shop, courier, total, queued, status: "running", success: 0, failed: 0, processing: 0}`.
4. Uses `bulkWriter()` to create one job doc per order at `shipment_batches/{batchId}/jobs/{orderId}` with `{orderId, orderName, status: "queued", attempts: 0}`. For Priority batches, each job doc also stores `courier` (the first priority courier name, capitalized).
5. Calls `createTask()` once per order to enqueue into `shipments-queue`.
6. Returns `{collectionName: "shipment_batches", batchId}` — the frontend uses batchId to `onSnapshot` for progress.

---

### `processShipmentTask` — Delhivery forward [onRequest, Cloud Task worker]

Triggered by: Cloud Task from `enqueueShipmentTasks`.

Flow:
1. Auth check + method check.
2. Atomic idempotency: Firestore transaction reads job doc. If already `success` or `failed`, skips. Otherwise sets `status: "processing"`, increments `attempts`.
3. Loads order doc from `accounts/{shop}/orders/{orderId}`. Guards:
   - Order must exist (`ORDER_NOT_FOUND`).
   - `customStatus` must be `"Confirmed"` (not `ORDER_ALREADY_SHIPPED`).
   - `order.pickupReady` must be `true` (not `ORDER_NOT_PICKED_UP_YET`).
   - On shared stores: checks vendor authorization.
4. Allocates AWB from `users/{businessId}/unused_awbs` via Firestore transaction (`allocateAwb`). Released back (`releaseAwb`) on any carrier failure.
5. Builds Delhivery payload (`buildDelhiveryPayload`): maps order fields to Delhivery's flat schema. Reads `shippingMode` from batch; for Priority batches reads from `priorityList[courier].mode`.
6. POSTs to `https://track.delhivery.com/api/cmu/create.json` with `format=json&data=<payload>` and `Authorization: Token {apiKey}`.
7. Evaluates response (`evaluateDelhiveryResponse`). Checks for `INSUFFICIENT_BALANCE`, ambiguous errors. Releases AWB on failure.
8. On success: atomic Firestore transaction writes to job, batch, and order. Order gets `{awb, courier: "Delhivery", courierProvider: "Delhivery", customStatus: "Ready To Dispatch", shippingMode}` plus a `customStatusesLogs` entry.
9. Calls `maybeCompleteBatch()` — marks batch `completed` if `success + failed === total`.

**Priority fallback path**: If courier is Priority and all retries are exhausted (or error is non-retryable but not an exception error), `handleJobFailure` sets job to `attempting_fallback` and calls `createTask` pointing to `PRIORITY_FALLBACK_HANDLER_URL` → `handlePriorityFallback`.

---

### `processShipmentTask2` — Shiprocket forward [onRequest, Cloud Task worker]

Same guards and idempotency as Delhivery. Key differences:
- Does NOT allocate an AWB from the pool — Shiprocket assigns its own AWB.
- Two-step API: (1) create Shiprocket order (`/v1/external/orders/create/adhoc`), (2) assign AWB (`/v1/external/courier/assign/awb`). Persists `shiprocketShipmentId` to order doc after step 1 to support resume on retry.
- Calls `requestShiprocketPickup()` (best-effort, non-fatal if fails).
- On success: order gets `{awb: awbCode, courier: "Shiprocket: {courierName}", courierProvider: "Shiprocket", customStatus: "Ready To Dispatch"}`.

---

### `processShipmentTask3` — Xpressbees forward [onRequest, Cloud Task worker]

Same guards. Key differences:
- Calls `selectCourier(token, shippingMode, totalQuantity)`: fetches Xpressbees courier list, picks smallest courier that fits the weight (250g × item count). For Express mode, picks the Air courier.
- POSTs to `https://shipment.xpressbees.com/api/shipments2`.
- On success: order gets `{awb: awbNumber, courier: "Xpressbees: {courierName}", courierProvider: "Xpressbees", customStatus: "Ready To Dispatch"}`.

---

### `processBlueDartShipmentTask` — Blue Dart forward [onRequest, Cloud Task worker]

Same guards. Key differences:
- Fetches JWT token first via `getBlueDartToken(appApiKey, appApiSecret)` — calls `https://apigateway.bluedart.com/in/transportation/token/v1/login`.
- POSTs to `https://apigateway.bluedart.com/in/transportation/waybill/v1/GenerateWayBill` with `JWTToken` header.
- Evaluates via `evaluateBlueDartResponse()` — handles `IsError`, status codes, `INSUFFICIENT_BALANCE`.
- On success: order gets `{awb, courier: "Blue Dart", courierProvider: "Blue Dart", bdDestinationArea, bdClusterCode, bdDestinationLocation, customStatus: "Ready To Dispatch"}`. The `bdDestinationArea` and `bdClusterCode` fields are used in shipping slips PDF.

---

### `handlePriorityFallback` [onRequest, Cloud Task worker]

Called when: a Priority batch job reaches `attempting_fallback` status.

What it does:
1. Reads the business's `priorityList`. Finds `currentCourier` from job doc. Finds its index.
2. If no next courier: marks job `failed`, calls `maybeCompleteBatch`.
3. If next courier exists: updates job to `{status: "fallback_queued", courier: nextCourier, attempts: 0}`, adds current courier to `previousCouriers` array. Creates a new Cloud Task pointing to the next courier's processor URL.

---

## SECTION 2 — SHIPMENTS (REVERSE / RETURN)

### How return booking flows end-to-end

```
Browser (Orders page) → "Book Returns" (bulk from DTO Requested tab)
  ↓
Next.js API: POST /api/shopify/courier/bulk-book-return
  ↓  (calls with ENQUEUE_FUNCTION_SECRET)
Cloud Function: enqueueReturnShipmentTasks
  ↓  (validates orders, creates book_return_batches doc + jobs)
Cloud Tasks queue: return-shipments-queue
  ↓  (one task per order)
Cloud Function: processReturnShipmentTask (Delhivery) / processBlueDartReturnShipmentTask (Blue Dart)
  ↓  (allocates AWB, calls carrier reverse API, sets status "DTO Booked")
WhatsApp: sendDTOBookedOrderWhatsAppMessage
Frontend: onSnapshot on book_return_batches → real-time progress on AWB Processing page (Return History tab)
```

### `enqueueReturnShipmentTasks` [onRequest, authenticated with ENQUEUE_FUNCTION_SECRET]

Called by: `POST /api/shopify/courier/bulk-book-return`.

Key logic:
- Validates all orders exist and have `customStatus` in `["Delivered", "DTO Requested"]`.
- Validates all orders have a `courier` field (needed to route to the right task handler — courier is read per-order from `order.courier`).
- Creates `book_return_batches` doc at `users/{businessId}/book_return_batches/{batchId}`.
- Currently routes all tasks to `RETURN_TASK_TARGET_URL_2` (Delhivery handler). Blue Dart is supported as a separate processor.
- Returns `{collectionName: "book_return_batches", batchId}`.

### `processReturnShipmentTask` — Delhivery reverse [onRequest, Cloud Task worker]

- Same idempotency and auth pattern as forward tasks.
- Guards: order must be `Delivered` or `DTO Requested`.
- Allocates AWB from pool. Uses hardcoded pickup name `"Majime Productions 2"` (not fetched from tracking API — the live fetch is commented out).
- Builds Delhivery return payload (`buildDelhiveryReturnPayload`): `payment_mode: "Pickup"`, customer address as consignee.
- On success: order gets `{awb_reverse, courier_reverse: "Delhivery", courierReverseProvider: "Delhivery", customStatus: "DTO Booked"}`.
- Calls `sendDTOBookedOrderWhatsAppMessage`.

### `processBlueDartReturnShipmentTask` — Blue Dart reverse [onRequest, Cloud Task worker]

- Fetches JWT token first.
- Builds Blue Dart return payload (`buildBlueDartReturnPayload`): Consignee = warehouse, Shipper = customer, `IsReversePickup: true`, `RegisterPickup: true`, `SubProductCode: "P"` (always Prepaid for returns).
- On success: order gets `{awb_reverse, courier_reverse: "Blue Dart", courierReverseProvider: "Blue Dart", customStatus: "DTO Booked"}`.
- Calls `sendDTOBookedOrderWhatsAppMessage`.

---

## SECTION 3 — ORDER FULFILLMENT (DISPATCH)

### How dispatch flows end-to-end

```
Browser (Orders page) → "Dispatch" (bulk action on Ready To Dispatch orders)
  ↓
Next.js API: POST /api/shopify/orders/dispatch
  ↓  (calls ENQUEUE_FUNCTION_URL_2)
Cloud Function: enqueueOrdersFulfillmentTasks
  ↓  (creates orders_fulfillment_summary + jobs)
Cloud Tasks queue: fulfillments-queue
  ↓  (one task per order)
Cloud Function: processFulfillmentTask
  ↓  (calls Shopify Fulfillments API, sets customStatus "Dispatched", dispatches UPCs)
Firestore trigger: updateOrderCounts  (fires on order write)
WhatsApp: sendDispatchedOrderWhatsAppMessage
```

### `enqueueOrdersFulfillmentTasks` [onRequest, authenticated with ENQUEUE_FUNCTION_SECRET]

Called by: `POST /api/shopify/orders/dispatch` Next.js route.

- Creates `orders_fulfillment_summary` doc at `users/{businessId}/orders_fulfillment_summary/{summaryId}`.
- Seeds one job doc per orderId.
- Enqueues Cloud Tasks to `FULFILLMENT_TASK_TARGET_URL` / `fulfillments-queue`.
- Returns `{collectionName: "orders_fulfillment_summary", summaryId}`.

### `processFulfillmentTask` [onRequest, Cloud Task worker]

What it does:
1. Checks if order is already fulfilled on Shopify (`fulfillmentStatus === "fulfilled"` or `"partial"`). If yes: still sets Firestore status to Dispatched, dispatches UPCs, returns success. This handles cases where Shopify already has the fulfillment.
2. Calls Shopify Fulfillments API (`/admin/api/2025-07/orders/{orderId}/fulfillment_orders.json`). Handles `on_hold` and `scheduled` fulfillment orders (releases hold or opens them before fulfilling).
3. Groups fulfillable FOs by `assigned_location_id`, creates separate fulfillments per location.
4. On success: sets order `customStatus: "Dispatched"` with log entry, dispatches UPCs via `dispatchOrderUPCs()`.
5. `dispatchOrderUPCs()`: for each line item, looks up `variantMappingDetails` on the store product to find `businessId` + `businessProductSku`, then queries `users/{actualBusinessId}/upcs` where `orderId == orderId AND productId == sku AND putAway == "outbound"`. Sets those UPCs to `putAway: null`.
6. Calls `sendDispatchedOrderWhatsAppMessage`.
7. Note: For `SHARED_STORE_ID` (the main shared store), `fulfillOrderOnShopify` returns `{nothingToDo: true}` immediately — fulfillment is not created on Shopify for shared store orders.

---

## SECTION 4 — ORDER SPLITTING

### `enqueueOrderSplitBatch` [onRequest, authenticated with ENQUEUE_FUNCTION_SECRET]

Called by: `POST /api/shopify/orders/split-order` Next.js route.

Flow:
1. Validates order is `New` status, has multiple vendors in `line_items`.
2. **Cancels the original Shopify order first** (critical — before any jobs are created). If cancel fails, sets `splitProcessing.status: "failed"` and aborts.
3. Groups line items by `item.vendor`. Calculates proportional discounts per vendor group (last split gets remainder to ensure exact sum).
4. Creates `order_split_batches` doc at `accounts/{shop}/order_split_batches/{batchId}`.
5. Creates one job doc per vendor group, storing `{vendorName, lineItems, subtotal, tax, total, proportionalDiscount}`.
6. Enqueues Cloud Tasks to `ORDER_SPLIT_TARGET_URL` / `order-splits-queue`.

### `processOrderSplitJob` [onRequest, Cloud Task worker]

For each vendor job:
1. Creates a Shopify Draft Order with the vendor's line items. Applies `applied_discount` with the proportional discount amount.
2. Completes the draft order via `PUT /draft_orders/{id}/complete.json`. `payment_pending: false` if original was fully paid, `true` otherwise.
3. For partially paid originals: creates a transaction for the proportional paid amount.
4. Sets job `status: "success"` with the new order details.
5. When all jobs succeed: updates original order with `splitProcessing.status: "completed"` and the list of split orders. Sends `sendSplitOrdersWhatsAppMessage`.

---

## SECTION 5 — ORDER COUNTS TRIGGER

### `updateOrderCounts` [onDocumentWritten: accounts/{storeId}/orders/{orderId}]

Fires on every Shopify order document write (created, updated, deleted).

What it does — three responsibilities:

**1. Order counts (via `updateOrderCountsWithIncrement`):**
- Updates `accounts/{storeId}/metadata/orderCounts.counts.{status}` using `FieldValue.increment`.
- On shared stores: also updates the vendor-specific `accounts/{storeId}/members/{vendorId}.counts.{status}` (the member doc doubles as a per-vendor count store). Maps `Ghamand` and `BBB` to `OWR` for count purposes.
- Three cases: order created (+1 to new status), order deleted (-1 from old status), order updated (−1 from old, +1 to new).

**2. Blocked stock (via `updateBlockedStock`):**
- Maps `customStatus` to an inventory state: `Start` (New/Confirmed/Ready To Dispatch), `Dispatched`, `End` (RTO Closed/Pending Refunds/DTO Refunded), `Exception` (Cancelled, etc).
- Uses a transition matrix `POSSIBLE_INVENTORY_CHANGES` to decide if `blockedStock` should increment or decrement.
- For each line item: looks up `variantMappingDetails[variantId]` on the store product to find `businessId` + `businessProductSku`, then updates `users/{businessId}/products/{businessProductSku}.inventory.blockedStock`.
- **Critical skip**: If transition is `Ready To Dispatch → Dispatched`, skips the blockedStock update entirely — this is handled atomically by `onUpcWritten` when UPCs go from `outbound → null` to avoid double-decrement.

**3. Status timestamp sync (on new order created or status change):**
- **No API route writes `lastStatusUpdate` or `{status}At` fields directly.** This trigger is the single owner of all status timestamp fields on order documents.
- Reads the order's `customStatusesLogs` array (each entry: `{status, createdAt}`).
- Filters logs to valid statuses only (the 21 known statuses: New, Confirmed, Ready To Dispatch, Dispatched, In Transit, Out For Delivery, Delivered, RTO In Transit, RTO Delivered, DTO Requested, DTO Booked, DTO In Transit, DTO Delivered, Pending Refunds, DTO Refunded, Lost, Closed, RTO Closed, Cancellation Requested, Cancelled). Invalid/unknown statuses are ignored.
- Finds the latest valid log entry by `createdAt` (highest `toMillis()` value).
- Sets `{toCamelCase(latestLog.status)}At = latestLog.createdAt` on the order doc (e.g. `confirmedAt`, `readyToDispatchAt`, `pendingRefundsAt`, `dtoRefundedAt`).
- Sets `lastStatusUpdate = latestLog.createdAt` — always equal to the most recent valid log's timestamp.
- **Stale field cleanup:** iterates all 21 valid statuses. For any `{status}At` field that exists on the order document but has no matching entry in `customStatusesLogs`, deletes it via `FieldValue.delete()`. This handles revert flows (e.g. `revert-to-confirmed` trims the log array, and the trigger cleans up the now-orphaned `readyToDispatchAt` field).
- All writes (set + deletes) are batched into a single `.update()` call on the order doc.
- Runs on both CASE 2 (new order create

---

## SECTION 6 — STATUS UPDATES (COURIER TRACKING POLLING)

All four couriers (Delhivery, Shiprocket, Xpressbees, Blue Dart) follow the identical pattern.

### Scheduled enqueue functions [onSchedule: every 2 hours, IST]

- `enqueueDelhiveryStatusUpdateTasksScheduled`
- `enqueueShiprocketStatusUpdateTasksScheduled`
- `enqueueXpressbeesStatusUpdateTasksScheduled`
- `enqueueBlueDartStatusUpdateTasksScheduled`

What they do:
1. Fetch all `users` docs (all businesses).
2. Filter to businesses that have at least one order in `[Dispatched, In Transit, Out For Delivery, RTO In Transit]` (`hasActiveShipments()`).
3. Build a set of `{accountId, businessId}` pairs. For shared stores: only included if the business is `SUPER_ADMIN_ID`.
4. Create a `status_update_batches` doc at root level with `{courier, type: "status_update", queued: N}`.
5. Create one job doc per account (store), enqueue Cloud Tasks with staggered 2-second delays.

### HTTP processors [onRequest, Cloud Task workers]

`updateDelhiveryStatusesJob`, `updateShiprocketStatusesJob`, `updateXpressbeesStatusesJob`, `updateBlueDartStatusesJob`

Each operates in chunks of 200 orders (`CHUNK_SIZE`). When more remain, the processor self-schedules a next chunk via `queueNextChunk()`.

**Per-chunk logic (`processCourierOrderChunk`):**
1. Queries orders where `courier == "{Courier}"` OR `courier_reverse == "{Courier}"` (uses Firestore composite `Filter.or`), ordered by `__name__`, limited to 200, starting after `cursor`.
2. Filters eligible orders: must have `awb`, `customStatus` not in excluded set (New, Confirmed, Ready To Dispatch, Lost, Closed, RTO Closed, DTO Delivered, Cancelled, Pending Refunds, DTO Refunded, Cancellation Requested).
3. Courier condition: `(courier == X AND no courier_reverse)` OR `(courier_reverse == X)`. This routes forward-shipped orders to their forward courier and return-shipped orders to their return courier.
4. AWB selection: if `customStatus.includes("DTO")` → use `awb_reverse`, otherwise use `awb`.
5. Calls courier tracking API in sub-batches of 50 (`API_BATCH_SIZE`).
6. Determines new status via `determineNew{Courier}Status()`.
7. Writes updates via Firestore batch write.
8. Sends WhatsApp notifications via `sendStatusChangeMessages()` for status changes to: In Transit, Out For Delivery, Delivered, RTO In Transit, RTO Delivered, DTO In Transit, DTO Delivered, Lost.

**Delhivery-specific:**
- Tracking API: `https://track.delhivery.com/api/v1/packages/json/?waybill={csv_of_awbs}`.
- Status mapping: `{Status, StatusType}` tuple → app status. Key mappings: `{In Transit, UD} → "In Transit"`, `{In Transit, RT} → "RTO In Transit"`, `{In Transit, PU} → "DTO In Transit"`, `{Dispatched, UD} → "Out For Delivery"`, `{Delivered, DL} → "Delivered"`, `{RTO, DL} → "RTO Delivered"`, `{DTO, DL} → "DTO Delivered"`, `{Lost, LT} → "Lost"`, `{Closed/Cancelled, CN} → "Closed/Cancelled Conditional"`.
- `"Closed/Cancelled Conditional"`: if order was `DTO Booked` → reverts to `Delivered` (clears `awb_reverse`); if `Ready To Dispatch` → reverts to `Confirmed` (clears `awb`). Handles Delhivery cancelling a shipment.
- **NDR RE-ATTEMPT**: Before preparing updates, checks each shipment for NDR-eligible `StatusCode` values (e.g. `EOD-74`, `EOD-15`, `EOD-104`, etc.). If found, calls `POST https://track.delhivery.com/api/p/update` with `{act: "RE-ATTEMPT"}` for that AWB. This is fire-and-forget (non-fatal).
- Also stores `delhiverydeliveredtime` Timestamp on Delivered orders (used by remittance table calculations).

**Blue Dart-specific:**
- Fetches JWT token per invocation (stateless).
- Tracking API: `GET https://apigateway.bluedart.com/in/transportation/tracking/v1/shipment?handler=tnt&numbers={csv}&format=json&scan=1&loginid={loginId}&lickey={trackingLicenceKey}`.
- Two-pass RTO strategy: first pass maps RT entries' `NewWaybillNo` → original order. Second pass processes entries — RTO sibling (matched by `NewWaybillNo`) gets `DL → "RTO Delivered"`, else `RTO In Transit`. Skips the original RT entry.
- Status mapping: `IT → "In Transit"`, `OD → "Out For Delivery"`, `DL → "Delivered"`, `RT → "RTO In Transit"`, `LS → "Lost"`.
- Stores `bluedartdeliveredtime` Timestamp on Delivered orders (used by remittance table calculations).

---

## SECTION 7 — SCHEDULED JOBS

### `checkDelayedConfirmedOrders` [onSchedule: daily 2 AM IST] → `processDelayedOrdersTask` [onRequest, Cloud Task]

Flow:
1. Scheduler fires → enqueues 3 × N tasks (3 delay levels × N accounts).
2. `processDelayedOrdersTask` per (account, delay level):
   - Queries `Confirmed` orders where `lastStatusUpdate <= cutoffTime` AND `delayNotified_{hours}h == null`.
   - Tags matched orders with the delay tag in `tags_confirmed` array.
   - Sets `delayNotified_{hours}h: serverTimestamp()` to prevent double-notification.
   - Sends WhatsApp message from the delay level's handler.

Three delay levels: 44h (`confirm_delay_1_order_1`), 96h (`confirm_delay_2_order_1`), 144h (`confirm_delay_3_order_1`).

### `closeDeliveredOrdersJob` [onSchedule: daily 3 AM IST] → `closeDeliveredOrdersTask` [onRequest, Cloud Task]

Flow:
1. Scheduler fires → one task per account.
2. Worker processes two queues with cursor-based pagination (max 25,000 orders, 500 per write batch):
   - **Store credit orders** (`payment_gateway_names` contains `"shopify_store_credit"`): close after 48h of Delivered.
   - **Regular orders**: close after 120h of Delivered. Store credit orders in this second query are filtered out client-side (`hasStoreCredit()`).
3. Closing means: `{customStatus: "Closed", customStatusesLogs append}`. The `closedAt` and `lastStatusUpdate` fields are set automatically by the `updateOrderCounts` trigger when it detects the status change.

### `dailyInventorySnapshot` [onSchedule: daily 23:59 IST]

Flow:
1. Runs just before midnight (captures the day's final state).
2. For each business: fetches all linked store orders created today (using `createdAt >= startString`).
3. Builds `variantId → quantitySold` map from line items.
4. For each business product: calculates `stockLevel = openingStock + inwardAddition - deduction + autoAddition - autoDeduction`.
5. Writes `users/{businessId}/inventory_snapshots/{productId}_{today}` with `{productId, date, stockLevel, isStockout, dailySales, exactDocState: {...product data}}`.
6. Uses `{merge: true}` for idempotency — safe to re-run for the same day.

**Consumed by**: `grossProfitReport` (opening/closing stock calculation), `restock` recommendation logic.

---

## SECTION 8 — REPORTS

All report functions write their results to Firestore. The frontend listens via `onSnapshot` on the business doc and displays results in real-time as they compute.

### `generateTableData` [onRequest, authenticated with ENQUEUE_FUNCTION_SECRET]

Called by: `POST /api/business/table-data` Next.js route (fire-and-forget).
Frontend consumption: `onSnapshot` on `users/{businessId}.tableData`.

What it does:
- Queries orders across all stores for the given date range by `createdAt`.
- On shared stores: filters by vendor membership.
- Categorizes each order into: grossSales, cancellations, pendingDispatch, inTransit, delivered, returns. Each category has a per-status breakdown.
- Writes aggregated data to `users/{businessId}.tableData.{loading, lastUpdated, data, error}`.

### `grossProfitReport` [onRequest, no header secret — called fire-and-forget from Next.js]

Called by: `POST /api/business/generate-gross-profit-report` Next.js route.
Frontend consumption: `onSnapshot` on `users/{businessId}.grossProfitData`.

Calculates eight metric rows in parallel:
1. **Sale**: all orders in date range by `createdAt`. Excludes ENDORA/STYLE 05 single-vendor orders.
2. **Sale Return**: RTO Closed (by `lastStatusUpdate`), Pending Refunds (by `pendingRefundsAt`), Cancellation Requested (by `cancellationRequestedAt`), Cancelled (by `lastStatusUpdate` if `cancellationRequestedAt` absent). All `{status}At` and `lastStatusUpdate` fields used in these queries are maintained automatically by the `updateOrderCounts` trigger from `customStatusesLogs`.
3. **Purchase**: GRNs by `createdAt` date range. Iterates each GRN's `items[]` array. For each item, `taxable = item.unitCost × item.receivedQty` (unit cost is ex-tax). Tax rate is fetched per SKU from `users/{businessId}/products/{sku}.taxRate` via a single `db.getAll()` batch call across all unique SKUs in the result set. Tax is applied **forward** (`taxable × taxRate / 100`), split equally into CGST + SGST (all purchases assumed intra-state Punjab — no IGST). `net = taxable + cgst + sgst`.
4. **Credit Notes**: completed Credit Notes by `completedAt` in date range. Queries `users/{businessId}/credit_notes` where `status == "completed"`. Value = sum of `items[].unitPrice × items[].quantity` across all matched docs. Represents stock that left the warehouse without generating revenue — treated as a negative row.
5. **Opening Stock**: `inventory_snapshots` for `startDate - 1 day`. Fetches product `price` (COGS) per product.
6. **Closing Stock**: `inventory_snapshots` for `endDate`.
7. **Lost**: orders with `customStatus == "Lost"` by `lastStatusUpdate`.
8. **Gross Profit**: sum of all above (signs already applied — Sale Return, Purchase, Credit Notes, Opening Stock, Lost are negative).

Tax calculation (Sale / Sale Return / Lost rows): reverse-calculates from `total_price` (tax-inclusive) using 5% rate to extract taxable + IGST/CGST/SGST. IGST vs CGST+SGST determined by `shipping_address.province == "Punjab"`. Purchase row uses forward tax calculation (ex-tax unit cost × per-product tax rate), always CGST+SGST (Punjab).

Writes to `users/{businessId}.grossProfitData.{loading, rows, startDate, endDate, error}`.

### `generateRemittanceTable` [onRequest, authenticated with ENQUEUE_FUNCTION_SECRET]

Called by: `POST /api/business/generate-remittance-table`.
Frontend consumption: `onSnapshot` on `users/{businessId}.remittanceTable.{blueDart|delhivery}`.

Two couriers supported:

**Blue Dart schedule**: Remittance on every Monday and Thursday. Each Monday covers orders delivered Mon-Wed of previous week. Each Thursday covers Thu-Sun.
**Delhivery schedule**: Daily remittance. Each day covers orders delivered 2 days prior.

For each remittance date: queries COD orders (status in `[Delivered, Closed, DTO Requested, DTO Booked, DTO In Transit, DTO Delivered, Pending Refunds, DTO Refunded]`) where `courierProvider == courier` AND `{bluedartdeliveredtime|delhiverydeliveredtime}` falls in the delivered range. Sums `total_outstanding` (COD amount).

Writes `{rows: [{date, orderDeliveredRangeStart, orderDeliveredRangeEnd, amount, orderCount, awbs[]}], totalAmount, totalOrderCount}`.

### Tax Report (two-function pipeline)

**`generateCustomTaxReportPreliminary`** [onRequest, authenticated with ENQUEUE_FUNCTION_SECRET]:
Called by: `POST /api/business/generate-tax-report`.
Creates a tracking doc in `users/{businessId}/tax_reports/{docId}`. Enqueues a Cloud Task to `generateCustomTaxReport`. Returns `{taskName, docId}` immediately (202).

**`generateCustomTaxReport`** [onRequest, Cloud Task worker, authenticated with TASKS_SECRET]:
Generates a 4-sheet Excel workbook:
1. **Sales Report**: one row per line item, per order created in range. Columns: Bill No., Date, Customer, State, Courier, Payment Gateway, Item Name, Qty, AWB, MRP, Discount, Shipping, Sale Price, HSN, Tax Rate, Taxable, IGST, SGST, CGST, Vendor, State/Courier/Gateway Amount Due.
2. **Sales Return Report**: same but for return events (RTO Closed, Pending Refunds, Cancellation Requested, Cancelled). Columns: same structure as Sales Report plus a **QC Status** column at the end (col 23), sourced from `raw.line_items[].qc_status`. This field is populated by the QC test flow on DTO In Transit / DTO Delivered orders. Empty string for RTO Closed and Cancelled orders that never went through QC.
3. **State Wise Tax Report**: pivot of gross sales + returns by state with net columns.
4. **HSN Wise Tax Report**: pivot by HSN code.

Uploads to Firebase Storage, sends download URL via WhatsApp (`sendTaxReportWhatsAppMessage`). Updates `tax_reports/{docId}` throughout with status (`generating → uploading → completed/failed`).

**`generateDailyTaxReport`** [onSchedule: daily midnight IST]: Body is commented out — disabled.

### `purchaseReport` [onRequest, no auth guard]

Called by: Dashboard Gross Profit table → Purchase row download button (direct POST from browser to Cloud Function URL).

- Queries `users/{businessId}/grns` by `completedAt` in date range.
- For each GRN: builds one row per item with `{billNumber, dateOfCompletion, grnNumber, productSku, hsn: "6109", taxRate: 5, unitPrice, quantity, taxableAmount, sgst, cgst, igst, totalAmount}`.
- Builds Excel, uploads to Storage, returns `{downloadUrl, rowCount}`.

### Credit Notes API Routes (Next.js)

Four Next.js API routes manage the Credit Note lifecycle. No Cloud Function involved — all logic runs in the API routes directly using Firebase Admin SDK. Credit Notes have no draft state — they are created and completed atomically in a single call.

**`POST /api/business/credit-notes/complete`** (unified create + complete):
- Pre-flight outside transaction: batch-reads all UPC docs via `db.getAll()`. Validates each is `putAway: "none"`. Returns 400 immediately if any fail — no locks acquired yet.
- Transaction: increments `users/{businessId}.creditNoteCount` to generate `creditNoteNumber` (CN-001, CN-002...). Creates the CN doc with `status: "completed"` and `completedAt` set immediately — no draft state. Sets each UPC `putAway → "outbound"` and tags `creditNoteRef: cnId` on each UPC doc.
- Setting UPCs to `outbound` triggers `onUpcWritten` `none → outbound` branch: decrements `inShelfQuantity` and placement quantity.
- UPCs are then physically removed from the put-away page (Outbound → "To be Removed" tab) which sets them to `null`.
- When put-away sets these UPCs `outbound → null`, `onUpcWritten` checks `creditNoteRef`: present → `inventory.deduction++` only (no `blockedStock` touch, UPC was never order-blocked); absent → `inventory.autoDeduction++, blockedStock--` (normal order dispatch).
- Body: `{businessId, partyId, partyName, warehouseId, reason, notes, items[], totalItems, totalValue}`.

**`POST /api/business/credit-notes/dispatch-upcs`**:
- Called from the put-away page "To be Removed" tab Dispatch button.
- Validates each UPC is `putAway: "outbound"` AND has `creditNoteRef` set. Rejects order-dispatch UPCs (no `creditNoteRef`) — they must go through fulfillment.
- Sets each validated UPC `putAway → null`. `onUpcWritten` fires and increments `inventory.deduction++`.
- Capped at 100 UPCs per request.
- Body: `{businessId, upcIds[]}`.

**`POST /api/business/warehouse/credit-notes/download-bill`**:
- Generates a PDF credit note bill using Puppeteer + `@sparticuz/chromium`.
- Fetches: CN doc, Party doc (supplier receiving the CN), business doc.
- **Opposite of GRN bill**: "Billed By" = Business (issuing the CN), "Billed To" = Party/Supplier. Bank details shown are the **business's** bank (so supplier knows where to send the refund).
- Tax rates come directly from `CreditNoteItem.taxRate` — no product fetch needed (rate stored at CN creation time). Intra/inter-state determined by party's address state vs Punjab.
- Returns PDF binary with `Content-Disposition: attachment`.
- Body: `{businessId, creditNoteId}`.

### `inventorySnapshotOfADate` [onRequest, no auth guard]

Called by: Dashboard Gross Profit table → Opening Stock and Closing Stock download buttons (direct POST from browser to Cloud Function URL).

- Takes `{businessId, date: "YYYY-MM-DD"}`.
- Fetches all `inventory_snapshots` for that date.
- Enriches: finds mapped variant for `gj9ejg-cu.myshopify.com` store, fetches variant price, fetches product COGS (`price` field), fetches product name.
- Builds Excel (`{productSku, stock, blockedStock, productName, variantSku, price, cogs}`).
- Uploads to Storage, returns `{downloadUrl}`.

### `generateUnavailableStockReport` [onSchedule: daily 8 PM IST]

Queries all `Confirmed` orders where `tags_confirmed array-contains "Unavailable"`. Builds a PDF with two tables (item summary by SKU, order-level detail). Sends via WhatsApp to hardcoded numbers.

---

## SECTION 9 — WAREHOUSE TRIGGERS

These fire automatically on Firestore writes. They are the backbone of warehouse data consistency.

### `onUpcWritten` [onDocumentWritten: users/{businessId}/upcs/{upcId}]

The most critical warehouse trigger. Uses exponential backoff retry wrapper (`runTransactionWithRetry`: 8 outer attempts × 25 inner Firestore attempts) due to high-volume UPC creation during GRNs.

**CASE 1 — UPC Created (no `before`, has `after`):**
1. Writes UPC log to `users/{businessId}/upcs/{upcId}/logs` and flat log to `users/{businessId}/upcsLogs` (non-fatal, isolated).
2. If `putAway == "inbound"`:
   - If UPC has `storeId` + `orderId` (came from an order return/RTO): increments `inventory.autoAddition` on the business product.
   - Otherwise (came from GRN): increments `inventory.inwardAddition`.

**CASE 2 — UPC Deleted (has `before`, no `after`):**
- Only acts if UPC was `putAway: "none"` (on a shelf).
- Decrements placement doc's `quantity`.

**CASE 3 — UPC Updated, `putAway` changed:**
1. Writes update log (non-fatal).
2. If `putAway` unchanged: returns early.
3. Transitions (ALL READS BEFORE ALL WRITES in transaction):
   - `inbound → none` (put away onto shelf): increments product `inShelfQuantity`, creates placement if not exists (sets `quantity: 1`) or increments `quantity`.
   - `none → outbound` (picked for dispatch): decrements product `inShelfQuantity`, decrements placement `quantity`.
   - `outbound → null` (order dispatch OR credit note finalisation via put-away page):
     - If UPC has `creditNoteRef` set → increments `inventory.deduction` only (credit note, never blocked by an order).
     - If UPC has no `creditNoteRef` → increments `inventory.autoDeduction`, decrements `inventory.blockedStock` (normal order dispatch).
   - `none → null` (direct removal, safety fallback): increments `inventory.deduction` only.
   - Any other `before → null`: logs a warning, no inventory update applied.
   - `* → inbound` (returned, but NOT from `outbound` or `none` — those are transient states): increments `inventory.autoAddition`.

**Key connection**: When `processFulfillmentTask` sets UPCs from `outbound → null`, this trigger fires. It checks `creditNoteRef` on the UPC: absent → `autoDeduction + blockedStock--` (order dispatch); present → `deduction++` only (credit note finalised via put-away). This is why `updateOrderCounts` skips the `Ready To Dispatch → Dispatched` blocked stock transition — to avoid double-counting with the UPC trigger.

### `onPlacementWritten` [onDocumentWritten: users/{businessId}/placements/{placementId}]

- **Created**: Updates shelf/rack/zone/warehouse `stats.totalProducts` (via transaction), creates movement doc, creates placement log. If `createUPCs: true`, calls `createUPCsForPlacement()` — creates UPC docs in batch (max 500), each with `putAway: "none"` at the placement's location.
- **Updated**: If quantity changed: updates stats (the delta), creates movement + log. If `createUPCs` flag changed AND `diff > 0`: creates UPCs for the diff amount.

### `onShelfWritten` [onDocumentWritten: users/{businessId}/shelves/{shelfId}]

- **Created**: Increments `stats.totalShelves` on rack, zone, warehouse. Creates shelf log.
- **Soft deleted**: Decrements stats, creates deletion log.
- **Restored**: Increments stats, creates restoration log.
- **Moved to different rack**: Increments `locationVersion` on shelf. Updates stats (−1 from old rack/zone/warehouse, +1 to new). Transfers `stats.totalProducts` across racks/zones/warehouses (queries placements). Creates `moved` log. Calls `propagateShelfLocationChange()` → creates Cloud Tasks to update `rackId/zoneId/warehouseId` on all child placements and UPCs in chunks of 500.
- **Other field changes**: Creates `updated` log with field diffs.

### `onRackWritten` [onDocumentWritten: users/{businessId}/racks/{rackId}]

Same pattern as shelf. Moves propagate `zoneId/warehouseId` to child shelves, placements, and UPCs via Cloud Tasks. Stats transferred include `totalShelves + totalProducts`.

### `onZoneWritten` [onDocumentWritten: users/{businessId}/zones/{zoneId}]

Same pattern. Moves propagate `warehouseId` to child racks, shelves, placements, and UPCs. Stats transferred include `totalRacks + totalShelves + totalProducts`.

### `onWarehouseWritten` [onDocumentWritten: users/{businessId}/warehouses/{warehouseId}]

Only handles soft-delete validation (warns if zones exist, which should be blocked at API level) and increments `nameVersion` on name change.

### `processPropagationTask` [onRequest, Cloud Task worker, authenticated with TASKS_SECRET]

Handles the chunked propagation of location changes. Called when zone/rack/shelf is moved.

Each task processes one chunk of 500 documents from the target collection (`placements`, `upcs`, `shelves`, or `racks`). Updates the relevant location field(s) on each doc. Uses a `propagation_trackers` doc to track progress. Version check: if the entity's `locationVersion` no longer matches the task's version (a newer move happened), marks the task `obsolete` and skips.

---

## SECTION 10 — INVENTORY TRIGGER (SHOPIFY SYNC)

### `onProductWritten` [onDocumentWritten: users/{businessId}/products/{productId}]

Fires on every business product write. Handles two scenarios:

**SCENARIO 1 — Mapping array changed** (any addition, removal, or swap in `mappedVariants`):
- Detected by comparing before/after arrays via a Set diff — handles length changes and same-length swaps, not just ±1 changes.
- **Full recompute**: queries `[New, Confirmed, Ready To Dispatch]` orders across every mapping in `afterMappedVariants` (with vendor filtering for shared stores / OWR logic). Sums all matching line item quantities across all mappings. Overwrites `blockedStock` with this total — no incremental delta math. This prevents drift over time.
- Writes updated `blockedStock` in a transaction, computes new `availableStock`, then syncs to Shopify for all current mappings (skips `SHARED_STORE_ID`).
- Returns early after Scenario 1 completes — Scenario 2 does not run in the same invocation to avoid double Shopify sync.

**SCENARIO 2 — Available stock changed** (`beforeAvailable !== availableStock`):
- `availableStock = physicalStock − blockedStock` where `physicalStock = openingStock + inwardAddition − deduction + autoAddition − autoDeduction`.
- For each mapped variant (skips `SHARED_STORE_ID`): fetches `inventoryItemId`, calls `inventoryItemUpdate` (ensure tracking), then `inventorySetQuantities` (absolute overwrite with `ignoreCompareQuantity: true`).
- 150ms pause between tracking mutation and set, 200ms pause between variants (rate limiting).

**This is the link between warehouse operations and Shopify inventory**: Every time a UPC is put away, picked up, dispatched, or returned (all via `onUpcWritten` → product inventory fields change → `onProductWritten` fires → Shopify inventory updates).

---

## SECTION 11 — B2B OMS TRIGGERS & SCHEDULED

### `syncOrderStatsOnLotChange` [onDocumentWritten: users/{businessId}/lots/{lotId}]

Fires on every lot write. Re-aggregates from scratch:
- Queries all lots for the order (`where("orderId", "==", orderId)`).
- Counts `lotsCompleted`, `lotsInProduction` (ACTIVE), `lotsDelayed` (isDelayed: true across all statuses).
- Updates `users/{businessId}/orders/{orderId}` with aggregated counts.
- If all lots are COMPLETED and order is currently `IN_PRODUCTION` → sets order status to `COMPLETED`.
- Note: cancelled lots have `isDelayed: false` (reset at cancellation time) to avoid inflating the count.

### `appendLotStageHistoryOnStageAdvance` [onDocumentWritten: users/{businessId}/lots/{lotId}]

Fires when `currentSequence` advances OR status flips to `COMPLETED` (two conditions because the last stage advance doesn't change `currentSequence`).

Writes to `users/{businessId}/lot_stage_history/{historyId}`: `{lotId, lotNumber, orderId, fromStage, toStage, fromSequence, toSequence, movedBy, movedAt, note}`.

### `createFinishedGoodOnLotCompleted` [onDocumentWritten: users/{businessId}/lots/{lotId}]

Fires when `lot.status` flips to `COMPLETED` for the first time. Has duplicate guard (queries `finished_goods` by `lotId` before writing).

Creates `users/{businessId}/finished_goods/{fgId}` with full denormalized lot data. `isDispatched: false`. Updated to `isDispatched: true` when `dispatch-finished-good` API is called.

### `syncMaterialStockOnReservationChange` [onDocumentWritten: users/{businessId}/material_reservations/{reservationId}]

Sole owner of raw material stock number updates for the reservation lifecycle (routes never touch these fields directly for RESERVATION/CONSUMPTION/RETURN events):

- **Created → RESERVED**: `reservedStock ↑ qty`, `availableStock ↓ qty`.
- **RESERVED → CONSUMED** (stage completed): `reservedStock ↓ qty`, `totalStock ↓ qty`.
- **RESERVED → RELEASED** (lot/order cancelled): `reservedStock ↓ qty`, `availableStock ↑ qty`.
- All other transitions: no-op.

### `recomputeLotDelays` [onSchedule: daily 9 AM IST (3 UTC)]

Iterates all businesses, all `ACTIVE` lots in chunks of 100 (cursor-based).
For each lot: computes `isDelayed` and `delayDays` by checking `plannedDate` of `PENDING` and `IN_PROGRESS` stages against today.
Only writes if the value changed (avoids unnecessary trigger cascades).

---

## SECTION 12 — AGENT TRIGGER

### `onAgentMessageCreated` [onDocumentCreated: users/{businessId}/agent_sessions/{sessionId}/messages/{messageId}]

Only reacts to `role === "user"` messages (ignores own assistant writes to prevent loops).

Flow:
1. Sets session `status: "generating"`, `generatingStartedAt: now`.
2. Fetches full message history ordered by `createdAt asc`. Slices off the last message (the current one). Maps history to Gemini's `{role: "user"|"model", parts: [{text}]}` format.
3. **Agentic tool-calling loop** (`while` capped at `MAX_TOOL_ITERATIONS = 5`):
   - Calls Gemini 2.5 Flash with full `contents` array, system prompt, tool declarations, temperature 0.3, max 1024 tokens.
   - If response part is `functionCall`: executes the tool via `executeTool()`, appends `{role: "model", parts: [{functionCall}]}` and `{role: "user", parts: [{functionResponse}]}` to `contents`, loops again.
   - If response part is `text`: exits loop with the reply.
   - If iterations exceed cap or no usable part: exits with fallback message.
4. Writes assistant reply as a new doc in the messages subcollection.
5. Sets session `status: "idle"`, clears `generatingStartedAt`.
6. On any error: sets `status: "error"`.

**Tool declarations** (schema-only, passed in `config.tools[].functionDeclarations[]`):

- **`getOrdersByStatus`**: Fetches orders for the business filtered by `customStatus` and date range. If no date range provided, the model is instructed to ask the user before calling. Falls back to today's date if model calls without one anyway. Generates an Excel file of results (order name, status, date/time IST), uploads to Firebase Storage at `majime_agent/getOrdersByStatus/{filename}.xlsx`, returns `{downloadUrl, count}`. The model presents this as a download link. Queried via the `{status}At` Timestamp field on order docs (e.g. `confirmedAt`, `readyToDispatchAt`) — requires Firestore composite index per status field. Limit: 50 orders per store, applied after client-side result collection across all business stores. Tool execution is wrapped in try/catch — errors returned as `{error}` in `functionResponse` so Gemini handles them gracefully.

**System prompt** is loaded once at cold start from `./docs/routes.md` and `./docs/cloud-functions.md` (module-level, cached across warm instances). Today's IST date is injected per-invocation so the model can correctly resolve "today", "this week", etc.

**Migration utility**: `migrateCreditNoteRef` [onRequest] — one-time migration that backfills `creditNoteRef: null` on all existing UPC docs, UPC subcollection logs, and flat `upcsLogs` docs that predate the credit note system. Run with `dryRun=true` first to verify counts.

---

## SECTION 13 — CROSS-CUTTING PATTERNS

### Batch + Job Pattern (used for all async bulk operations)
All multi-order operations (AWB assignment, dispatch, return booking, order splitting, status updates) use the same pattern:
- **Batch doc**: top-level tracking (`total, queued, processing, success, failed, status`).
- **Job docs**: per-item tracking (`status: queued|processing|retrying|success|failed|attempting_fallback`).
- **`maybeCompleteBatch()`**: called after every terminal job transition. Uses Firestore transaction to atomically check if `success + failed === total && processing === 0` and sets `status: "completed"`.
- **Frontend**: `onSnapshot` on the batch doc and its `jobs` subcollection drives real-time progress UI on the AWB Processing page.

### Retry and failure handling
- `handleJobFailure()` / `handleReturnJobFailure()`: used in all shipment task workers. Runs a transaction to atomically update job + batch counters. Returns `{shouldReturnFailure, statusCode, reason}`.
- Retryable errors return HTTP 503 → Cloud Tasks retries automatically.
- Non-retryable errors return HTTP 200 with `{ok: false}` → Cloud Tasks stops retrying.
- `NON_RETRYABLE_ERROR_CODES`: `CARRIER_KEY_MISSING`, `ORDER_NOT_FOUND`, `ORDER_ALREADY_SHIPPED`, `INVALID_ORDER_STATUS`, `NO_AWB_AVAILABLE`, `COURIER_SELECTION_FAILED`, `INSUFFICIENT_BALANCE`, `NOT_AUTHORIZED_TO_PROCESS_THIS_ORDER`, etc.

### AWB Pool
- `allocateAwb(businessId)`: Firestore transaction pops first doc from `users/{businessId}/unused_awbs`.
- `releaseAwb(businessId, awb)`: Restores AWB to pool on carrier failure.
- Pool is only used for Delhivery (forward + return) and manual single-return bookings. Shiprocket and Xpressbees assign their own AWBs. Blue Dart uses its own waybill generation API.

### WhatsApp notifications
All triggered automatically by Cloud Functions on status changes. Templates per event:
- Dispatched: `dipatched_order_1`
- In Transit: `intransit_order_1`
- Out For Delivery: `outfordelivery_order_2`
- Delivered: `delivered_order_2`
- RTO In Transit: `rtointransit_order_2`
- RTO Delivered: `rtodelivered_order_4`
- DTO Booked: `dtobooked_order_1` (button with tracking link)
- DTO In Transit: `dtointransit_order_1`
- DTO Delivered: `dtodelivered_order_1`
- Lost: `lost_order_1`
- Split Orders: `split_order_1`
- Tax Report: `tax_report_1` (with download button)
- Delay notifications: `confirm_delay_1/2/3_order_1`

Template parameters are sent from `shop.whatsappPhoneNumberId` and `shop.whatsappAccessToken` stored on the `accounts/{storeId}` doc.

### Firestore data paths specific to Cloud Functions
- Shipment batches: `users/{businessId}/shipment_batches/{batchId}/jobs/{orderId}`
- Return batches: `users/{businessId}/book_return_batches/{batchId}/jobs/{orderId}`
- Fulfillment summary: `users/{businessId}/orders_fulfillment_summary/{summaryId}/jobs/{orderId}`
- Order split batches: `accounts/{storeId}/order_split_batches/{batchId}/jobs/{jobId}`
- Status update batches: `status_update_batches/{batchId}/jobs/{accountId}` (root-level, not under users)
- Tax reports: `users/{businessId}/tax_reports/{docId}`
- Inventory snapshots: `users/{businessId}/inventory_snapshots/{productId}_{date}`
- UPC logs: `users/{businessId}/upcs/{upcId}/logs/{logId}` AND `users/{businessId}/upcsLogs/{logId}` (flat copy). Both include `snapshot.creditNoteRef` field since the credit note system was added.
- Credit notes: `users/{businessId}/credit_notes/{cnId}`
- Agent tool output (Excel files): `majime_agent/getOrdersByStatus/{filename}.xlsx` (Firebase Storage)
- Propagation trackers: `users/{businessId}/propagation_trackers/{propagationId}`
- Placement logs: `users/{businessId}/placements/{placementId}/logs/{logId}`
- B2B Material reservations: `users/{businessId}/material_reservations/{reservationId}`
- B2B Material transactions: `users/{businessId}/material_transactions/{txId}`
- B2B Lot stage history: `users/{businessId}/lot_stage_history/{historyId}`
- B2B Finished goods: `users/{businessId}/finished_goods/{finishedGoodId}`
- WhatsApp messages: `whatsapp_messages/{messageId}` (root-level)