/*
 * =============================================================================
 * B2B OMS — FUNCTION & API ROUTE REFERENCE
 * =============================================================================
 *
 * All HTTP handlers live as Next.js API routes under /api/business/b2b/.
 * This file contains only background triggers and the scheduled function.
 * All paths are scoped under users/{businessId}/...
 *
 * Authentication:
 *   API routes  → authUserForBusiness() — Firebase ID token via Authorization header
 *   onRequest   → requireHeaderSecret() — ENQUEUE_FUNCTION_SECRET via x-api-key header
 *   Triggers    → no auth, fire automatically on Firestore writes
 *
 * Key design decisions baked into every route:
 *   — SKU is the document ID for b2bProducts and raw_materials (not auto-generated).
 *     Duplicate check is a single doc.get() — no collection query needed.
 *   — Stock number updates (reservedStock, availableStock, totalStock) for the
 *     reservation lifecycle are owned exclusively by syncMaterialStockOnReservationChange.
 *     Routes only write reservation docs — they never touch raw material stock fields
 *     for RESERVATION / CONSUMPTION / RETURN events.
 *   — LotStageHistory writes are owned by appendLotStageHistoryOnStageAdvance.
 *   — FinishedGood creation is owned by createFinishedGoodOnLotCompleted.
 *     Routes only update the lot doc — they never write to finished_goods.
 *   — Order stats (lotsCompleted, lotsInProduction, lotsDelayed) are owned by
 *     syncOrderStatsOnLotChange. Routes never write these fields except at
 *     order creation time.
 *
 * =============================================================================
 * SECTION 1 — MASTER DATA
 * =============================================================================
 *
 * POST /api/business/b2b/create-buyer
 *   Creates a new buyer. Starts as isActive: true.
 *   No duplicate check — buyers are not uniquely keyed on any field.
 *   Required: name, contactPerson, phone, email, address, createdBy
 *   Optional: gstNumber
 *   Types: Buyer
 *   Writes: users/{businessId}/buyers/{buyerId}
 *
 * POST /api/business/b2b/update-buyer
 *   Updates editable fields on an existing buyer.
 *   Checks existence before updating. Cannot change id or createdAt.
 *   Pass isActive: false to deactivate. Deactivated buyers block new orders.
 *   Required: buyerId
 *   Optional: name, contactPerson, phone, email, address, gstNumber, isActive
 *   Types: Buyer
 *   Reads:  users/{businessId}/buyers/{buyerId}
 *   Writes: users/{businessId}/buyers/{buyerId}
 *
 * POST /api/business/b2b/create-product
 *   Creates a new finished-garment product (template — not physical inventory).
 *   SKU is the document ID, normalized to uppercase. Duplicate check is a
 *   single doc.get() on the SKU path — returns sku_already_exists if taken.
 *   Validates: defaultStages must be a non-empty array.
 *   Required: name, sku, category, defaultStages, createdBy
 *   Optional: description
 *   Types: Product
 *   Reads:  users/{businessId}/b2bProducts/{sku} (duplicate check)
 *   Writes: users/{businessId}/b2bProducts/{sku}
 *
 * POST /api/business/b2b/update-product
 *   Updates editable fields on a product. Checks existence before updating.
 *   Blocks sku changes — SKU is the doc ID and is referenced by lots,
 *   BOM entries, and finished goods. Changing it would orphan all of them.
 *   Validates: defaultStages must be non-empty if provided.
 *   Pass isActive: false to deactivate. Inactive products block new orders and BOM entries.
 *   Required: productId
 *   Optional: name, category, description, defaultStages, isActive
 *   Types: Product
 *   Reads:  users/{businessId}/b2bProducts/{productId}
 *   Writes: users/{businessId}/b2bProducts/{productId}
 *
 * POST /api/business/b2b/create-raw-material
 *   Creates a new raw material with zero stock. Stock is added separately via add-stock.
 *   SKU is the document ID, normalized to uppercase. Same duplicate check pattern as products.
 *   Validates: reorderLevel must be >= 0.
 *   Required: name, sku, unit, category, reorderLevel, createdBy
 *   Optional: supplierName
 *   Types: RawMaterial
 *   Reads:  users/{businessId}/raw_materials/{sku} (duplicate check)
 *   Writes: users/{businessId}/raw_materials/{sku}
 *
 * POST /api/business/b2b/update-raw-material
 *   Updates metadata on a raw material. Checks existence before updating.
 *   Explicitly blocks direct writes to totalStock, reservedStock, availableStock —
 *   those fields are owned by add-stock, adjust-stock, and syncMaterialStockOnReservationChange.
 *   Validates: reorderLevel must be >= 0 if provided.
 *   Required: materialId
 *   Optional: name, unit, category, reorderLevel, supplierName, isActive
 *   Types: RawMaterial
 *   Reads:  users/{businessId}/raw_materials/{materialId}
 *   Writes: users/{businessId}/raw_materials/{materialId}
 *
 * POST /api/business/b2b/create-bom-entry
 *   Creates a BOM entry linking one product to one raw material.
 *   Defines how much of the material is needed per finished piece (quantityPerPiece),
 *   which stage physically consumes it (consumedAtStage), and a wastage buffer % added
 *   on top when calculating reservation quantities.
 *   Validates:
 *     — product exists and isActive
 *     — material exists and isActive
 *     — no existing active BOM entry for this product-material pair (returns
 *       bom_entry_already_exists — deactivate the existing entry first to replace it)
 *     — quantityPerPiece > 0
 *     — wastagePercent between 0 and 100
 *   Denormalizes productName, productSku, materialName, materialUnit into the entry
 *   so BOM queries don't need joins.
 *   Required: productId, materialId, quantityPerPiece, consumedAtStage, wastagePercent
 *   Types: BOMEntry
 *   Reads:  users/{businessId}/b2bProducts/{productId}
 *           users/{businessId}/raw_materials/{materialId}
 *           users/{businessId}/bom (query: productId + materialId + isActive)
 *   Writes: users/{businessId}/bom/{bomId}
 *
 * POST /api/business/b2b/update-bom-entry
 *   Updates quantityPerPiece, wastagePercent, or consumedAtStage on a BOM entry.
 *   Cannot change which product or material the entry links.
 *   Blocks updates on inactive entries — reactivation is done by deactivating
 *   the current entry and creating a new one.
 *   Validates: quantityPerPiece > 0, wastagePercent 0–100 if provided.
 *   Required: bomId
 *   Optional: quantityPerPiece, wastagePercent, consumedAtStage
 *   Types: BOMEntry
 *   Reads:  users/{businessId}/bom/{bomId}
 *   Writes: users/{businessId}/bom/{bomId}
 *
 * POST /api/business/b2b/deactivate-bom-entry
 *   Soft-deletes a BOM entry by setting isActive: false.
 *   Deactivated entries are ignored by confirm-order and create-order.
 *   Guards against double-deactivation.
 *   Required: bomId
 *   Types: BOMEntry
 *   Reads:  users/{businessId}/bom/{bomId}
 *   Writes: users/{businessId}/bom/{bomId}
 *
 * POST /api/business/b2b/create-stage-config
 *   Creates a production stage config entry — seed data for the stage picker UI.
 *   Guards against duplicate stage names (one config per StageName enum value).
 *   Validates: defaultDurationDays > 0.
 *   Required: name, label, description, defaultDurationDays, canBeOutsourced, sortOrder
 *   Types: ProductionStageConfig
 *   Reads:  users/{businessId}/production_stage_config (query: name duplicate check)
 *   Writes: users/{businessId}/production_stage_config/{stageId}
 *
 * POST /api/business/b2b/update-stage-config
 *   Updates label, description, defaultDurationDays, canBeOutsourced, or sortOrder.
 *   Blocks name changes — StageName is referenced as a plain string on every lot's
 *   stage array. Changing it would orphan all existing lots referencing that stage.
 *   Validates: defaultDurationDays > 0, sortOrder >= 1 if provided.
 *   Required: stageId
 *   Optional: label, description, defaultDurationDays, canBeOutsourced, sortOrder
 *   Types: ProductionStageConfig
 *   Reads:  users/{businessId}/production_stage_config/{stageId}
 *   Writes: users/{businessId}/production_stage_config/{stageId}
 *
 * =============================================================================
 * SECTION 2 — ORDER LIFECYCLE
 * =============================================================================
 *
 * POST /api/business/b2b/save-draft-order
 *   Creates a new order in DRAFT status. No lots are created, no stock is reserved.
 *   Lot configurations are stored as draftLots[] on the order doc for later editing
 *   or confirmation. Generates a sequential order number (ORD-YYYY-NNNN).
 *   Validates:
 *     — buyer exists and isActive
 *     — each lot: productId present, quantity > 0, stages non-empty,
 *       product exists and isActive
 *     — BOM check is intentionally deferred to confirm-order (a draft may be
 *       created before BOM is fully set up)
 *     — lots array must be non-empty
 *   Required: buyerId, buyerName, buyerContact, shipDate, deliveryAddress, createdBy, lots
 *   Optional: note
 *   Types: Order, DraftLotInput
 *   Writes: users/{businessId}/orders/{orderId}
 *           users/{businessId}/counters/orders
 *
 * POST /api/business/b2b/update-draft-order
 *   Updates an existing DRAFT order's metadata and lot configurations.
 *   Same validations as save-draft-order (buyer, products) but BOM check
 *   is still deferred — save should not block if BOM is not yet set up.
 *   Blocks if order is not in DRAFT status.
 *   Does NOT generate a new order number — the existing one is preserved.
 *   Required: orderId, buyerId, buyerName, buyerContact, shipDate, deliveryAddress, lots
 *   Optional: note
 *   Types: Order, DraftLotInput
 *   Reads:  users/{businessId}/orders/{orderId}
 *           users/{businessId}/buyers/{buyerId}
 *           users/{businessId}/b2bProducts/{productId} (per lot)
 *   Writes: users/{businessId}/orders/{orderId}
 *
 * POST /api/business/b2b/confirm-order
 *   Moves a DRAFT order to IN_PRODUCTION. Accepts optional updated lot configs
 *   to allow last-minute changes at confirmation time without a separate edit step.
 *   If lots are not passed, uses the draftLots already on the order.
 *   Full validation pipeline:
 *     — order must be in DRAFT status
 *     — buyer re-validated for isActive (may have been deactivated since draft was saved)
 *     — each lot: product exists + isActive, quantity > 0, stages non-empty
 *     — each product must have at least one active BOM entry — blocks confirmation
 *       entirely if missing (returns no_bom_for_product)
 *     — stock shortfall check across all reservations — rolls order back to DRAFT
 *       and returns insufficient_stock with per-material detail if any material
 *       has insufficient availableStock
 *   On success: creates all lot docs, writes one MaterialReservation per lot-material
 *   pair, writes one RESERVATION MaterialTransaction per reservation, clears draftLots,
 *   and sets order status to IN_PRODUCTION.
 *   Note: raw material stock numbers (reservedStock, availableStock) are NOT updated
 *   here — that is handled by syncMaterialStockOnReservationChange when each
 *   reservation doc is written.
 *   Required: orderId, confirmedBy
 *   Optional: lots (updated DraftLotInput array)
 *   Types: Order, DraftLotInput, Lot, LotStage, BOMEntry, MaterialReservation, MaterialTransaction
 *   Reads:  users/{businessId}/orders/{orderId}
 *           users/{businessId}/buyers/{buyerId}
 *           users/{businessId}/b2bProducts/{productId} (per lot)
 *           users/{businessId}/bom (query: productId + isActive, per lot)
 *           users/{businessId}/raw_materials/{materialId} (stock shortfall check)
 *   Writes: users/{businessId}/orders/{orderId}
 *           users/{businessId}/lots/{lotId} (one per lot)
 *           users/{businessId}/material_reservations/{reservationId} (one per lot-material pair)
 *           users/{businessId}/material_transactions/{txId} (one RESERVATION per reservation)
 *           users/{businessId}/counters/lots
 *
 * POST /api/business/b2b/create-order
 *   Creates an order and immediately starts production in a single call — skips
 *   the draft step entirely. Identical validation pipeline to confirm-order including
 *   buyer, product, BOM, and stock shortfall checks. Generates order number and
 *   lot numbers in the same batch.
 *   Required: buyerId, buyerName, buyerContact, shipDate, deliveryAddress, createdBy, lots
 *   Optional: note
 *   Types: Order, DraftLotInput, Lot, LotStage, BOMEntry, MaterialReservation, MaterialTransaction
 *   Reads:  users/{businessId}/buyers/{buyerId}
 *           users/{businessId}/b2bProducts/{productId} (per lot)
 *           users/{businessId}/bom (query: productId + isActive, per lot)
 *           users/{businessId}/raw_materials/{materialId} (stock shortfall check)
 *   Writes: users/{businessId}/orders/{orderId}
 *           users/{businessId}/lots/{lotId} (one per lot)
 *           users/{businessId}/material_reservations/{reservationId} (one per lot-material pair)
 *           users/{businessId}/material_transactions/{txId} (one RESERVATION per reservation)
 *           users/{businessId}/counters/orders
 *           users/{businessId}/counters/lots
 *
 * POST /api/business/b2b/cancel-order
 *   Cancels an order and all its non-completed lots.
 *   DRAFT orders: just flips status to CANCELLED — no lots or reservations exist.
 *   IN_PRODUCTION orders: cancels all ACTIVE lots, releases all RESERVED material
 *   reservations (flips to RELEASED), and writes one RETURN MaterialTransaction
 *   per released reservation. COMPLETED lots are left untouched.
 *   Note: raw material stock numbers are not updated here — owned by trigger.
 *   Required: orderId, cancelledBy, reason
 *   Types: Order, Lot, MaterialReservation, MaterialTransaction
 *   Reads:  users/{businessId}/orders/{orderId}
 *           users/{businessId}/lots (query: orderId)
 *           users/{businessId}/material_reservations (query: lotId + status RESERVED)
 *   Writes: users/{businessId}/orders/{orderId}
 *           users/{businessId}/lots/{lotId} (status → CANCELLED)
 *           users/{businessId}/material_reservations/{reservationId} (status → RELEASED)
 *           users/{businessId}/material_transactions/{txId} (one RETURN per reservation)
 *
 * =============================================================================
 * SECTION 3 — LOT LIFECYCLE
 * =============================================================================
 *
 * POST /api/business/b2b/advance-lot-stage
 *   Marks the current stage COMPLETED, moves the lot to the next stage, and consumes
 *   all RESERVED material reservations whose consumedAtStage matches the stage
 *   just completed (flips them to CONSUMED).
 *   Writes one CONSUMPTION MaterialTransaction per consumed reservation.
 *   Runs in a Firestore transaction for atomicity.
 *   Validates:
 *     — lot must exist and be ACTIVE
 *     — current stage must not be BLOCKED (returns lot_stage_blocked)
 *   Does NOT write LotStageHistory — owned by appendLotStageHistoryOnStageAdvance.
 *   Does NOT create FinishedGood — owned by createFinishedGoodOnLotCompleted.
 *   Does NOT update raw material stock numbers — owned by syncMaterialStockOnReservationChange.
 *   Required: lotId, completedBy
 *   Optional: note
 *   Types: Lot, LotStage, MaterialReservation, MaterialTransaction
 *   Reads:  users/{businessId}/lots/{lotId}
 *           users/{businessId}/material_reservations (query: lotId + consumedAtStage + RESERVED)
 *   Writes: users/{businessId}/lots/{lotId}
 *           users/{businessId}/material_reservations/{reservationId} (status → CONSUMED)
 *           users/{businessId}/material_transactions/{txId} (one CONSUMPTION per reservation)
 *
 * POST /api/business/b2b/set-lot-stage-blocked
 *   Toggles the current stage between BLOCKED and IN_PROGRESS.
 *   Used to flag a lot that cannot proceed (machine breakdown, material shortage,
 *   outsource delay) and to clear that flag when resolved.
 *   Validates:
 *     — lot must exist and be ACTIVE
 *     — idempotency guards: returns already_blocked or already_unblocked if the
 *       stage is already in the requested state
 *   Required: lotId, blocked (boolean)
 *   Optional: reason
 *   Types: Lot, LotStage
 *   Reads:  users/{businessId}/lots/{lotId}
 *   Writes: users/{businessId}/lots/{lotId}
 *
 * POST /api/business/b2b/cancel-lot
 *   Cancels a single lot. Releases all RESERVED material reservations for the lot
 *   (flips to RELEASED) and writes one RETURN MaterialTransaction per reservation.
 *   Runs in a Firestore transaction.
 *   Guards against cancelling an already-CANCELLED or COMPLETED lot.
 *   Note: raw material stock numbers are not updated here — owned by trigger.
 *   Required: lotId, cancelledBy, reason
 *   Types: Lot, MaterialReservation, MaterialTransaction
 *   Reads:  users/{businessId}/lots/{lotId}
 *           users/{businessId}/material_reservations (query: lotId + status RESERVED)
 *   Writes: users/{businessId}/lots/{lotId} (status → CANCELLED)
 *           users/{businessId}/material_reservations/{reservationId} (status → RELEASED)
 *           users/{businessId}/material_transactions/{txId} (one RETURN per reservation)
 *
 * =============================================================================
 * SECTION 4 — STOCK MANAGEMENT
 * =============================================================================
 *
 * POST /api/business/b2b/add-stock
 *   Records an inbound stock receipt (GRN / purchase order arrival).
 *   Increments totalStock and availableStock directly — no reservation involved.
 *   Validates:
 *     — material exists and isActive (cannot add stock to a deactivated material)
 *     — quantity must be positive
 *   Writes a PURCHASE MaterialTransaction with stockBefore/stockAfter populated
 *   (these are meaningful here since we're doing the update ourselves in the
 *   same transaction, unlike the trigger-owned types).
 *   Runs in a Firestore transaction.
 *   Required: materialId, quantity, referenceId (PO number), createdBy
 *   Optional: note
 *   Types: RawMaterial, MaterialTransaction
 *   Reads:  users/{businessId}/raw_materials/{materialId}
 *   Writes: users/{businessId}/raw_materials/{materialId} (totalStock↑, availableStock↑)
 *           users/{businessId}/material_transactions/{txId} (PURCHASE)
 *
 * POST /api/business/b2b/adjust-stock
 *   Manual stock correction — positive to add, negative to reduce.
 *   Requires a note explaining the reason (damaged goods, counting error, etc.).
 *   Only touches totalStock and availableStock — never reservedStock, because
 *   reservations are independent commitments and must not be silently altered.
 *   Validates:
 *     — material exists and isActive
 *     — quantity cannot be zero
 *     — resulting availableStock cannot go below zero (returns
 *       adjustment_exceeds_available_stock — cannot adjust away stock that
 *       is already committed to active reservations)
 *   Writes an ADJUSTMENT MaterialTransaction with stockBefore/stockAfter populated.
 *   Runs in a Firestore transaction.
 *   Required: materialId, quantity, note, createdBy
 *   Types: RawMaterial, MaterialTransaction
 *   Reads:  users/{businessId}/raw_materials/{materialId}
 *   Writes: users/{businessId}/raw_materials/{materialId} (totalStock±, availableStock±)
 *           users/{businessId}/material_transactions/{txId} (ADJUSTMENT)
 *
 * --- MaterialTransaction types — where each is written and what it means ---
 *
 *   PURCHASE     → add-stock
 *                  Physical stock arrived. stockBefore/stockAfter populated.
 *
 *   ADJUSTMENT   → adjust-stock
 *                  Manual correction. stockBefore/stockAfter populated.
 *
 *   RESERVATION  → confirm-order, create-order
 *                  Stock locked for a lot. Physical stock unchanged — only
 *                  reservedStock↑ and availableStock↓ (via trigger).
 *                  stockBefore/stockAfter are null.
 *
 *   CONSUMPTION  → advance-lot-stage
 *                  Material physically used up at a stage. totalStock↓,
 *                  reservedStock↓ (via trigger). stockBefore/stockAfter are null.
 *
 *   RETURN       → cancel-order, cancel-lot
 *                  Reserved stock released — lot cancelled before material was used.
 *                  reservedStock↓, availableStock↑ (via trigger).
 *                  stockBefore/stockAfter are null.
 *
 *   Note on null stockBefore/stockAfter: for RESERVATION, CONSUMPTION, and RETURN,
 *   the raw material stock update is owned by syncMaterialStockOnReservationChange.
 *   Routes only write the reservation doc — the trigger fires asynchronously and
 *   updates the material. Capturing before/after in the route would require an
 *   extra read and would be stale by the time the trigger fires anyway.
 *   For PURCHASE and ADJUSTMENT, the route updates the material directly in the
 *   same transaction, so before/after are accurate and meaningful.
 *
 * =============================================================================
 * SECTION 5 — DISPATCH
 * =============================================================================
 *
 * POST /api/business/b2b/dispatch-finished-good
 *   Marks a finished good as dispatched. Sets isDispatched: true, dispatchedAt,
 *   courierName, and AWB number. This is the handoff point to Majime — after
 *   dispatch, Majime takes over shipment tracking via the AWB.
 *   Guards against double-dispatching (returns already_dispatched with the
 *   existing AWB if the lot was already dispatched).
 *   Required: finishedGoodId, courierName, awb, dispatchedBy
 *   Optional: cartonCount, totalWeightKg
 *   Types: FinishedGood
 *   Reads:  users/{businessId}/finished_goods/{finishedGoodId}
 *   Writes: users/{businessId}/finished_goods/{finishedGoodId}
 *
 * =============================================================================
 * SECTION 6 — READ / QUERY
 * =============================================================================
 *
 * POST /api/business/b2b/get-order-dashboard
 *   Returns the full order detail view in one call.
 *   Fetches the order doc and all its lots in parallel.
 *   Returns: order data, lots grouped by currentStage (for Kanban column view),
 *   and a tnaSummary per lot (for the TNA table — stage name, planned date,
 *   actual date, status per stage).
 *   Required: orderId
 *   Types: Order, Lot, LotStage
 *   Reads:  users/{businessId}/orders/{orderId}
 *           users/{businessId}/lots (query: orderId)
 *
 * =============================================================================
 * SECTION 7 — BACKGROUND TRIGGERS
 * =============================================================================
 *
 * syncOrderStatsOnLotChange  [onDocumentWritten: users/{businessId}/lots/{lotId}]
 *   Fires on every lot write. Re-aggregates lotsCompleted, lotsInProduction, and
 *   lotsDelayed on the parent order by querying all lots for that orderId.
 *   Auto-sets order status to COMPLETED when all lots are in a terminal state
 *   (all COMPLETED) — but only if the order is currently IN_PRODUCTION, so a
 *   CANCELLED order is never accidentally flipped to COMPLETED.
 *   Note: cancelled lots with isDelayed: true would inflate lotsDelayed if not
 *   handled — cancel-lot and cancel-order reset isDelayed to false on cancellation.
 *   Types: Lot, Order
 *   Reads:  users/{businessId}/lots (query: orderId)
 *           users/{businessId}/orders/{orderId}
 *   Writes: users/{businessId}/orders/{orderId}
 *           (lotsCompleted, lotsInProduction, lotsDelayed, optionally status)
 *
 * appendLotStageHistoryOnStageAdvance  [onDocumentWritten: users/{businessId}/lots/{lotId}]
 *   Fires on every lot write. Writes a LotStageHistory doc when either:
 *     (a) currentSequence advances (normal stage progression), or
 *     (b) lot status flips to COMPLETED (last stage — currentSequence does not
 *         change on the final advance, so condition (a) alone would miss it)
 *   The completedStage is read from after.stages[before.currentSequence - 1],
 *   which correctly points to the stage that was just finished in both cases.
 *   movedBy and movedAt are taken from the stage's completedBy and actualDate fields.
 *   Types: Lot, LotStageHistory
 *   Reads:  (event data only — no additional Firestore reads)
 *   Writes: users/{businessId}/lot_stage_history/{historyId}
 *
 * createFinishedGoodOnLotCompleted  [onDocumentWritten: users/{businessId}/lots/{lotId}]
 *   Fires on every lot write. Creates a FinishedGood doc when the lot status
 *   flips to COMPLETED for the first time. Includes a duplicate guard —
 *   queries finished_goods by lotId before writing to handle trigger retries
 *   or any edge case where the lot flips to COMPLETED more than once.
 *   The FinishedGood doc represents the physical packed inventory ready to ship.
 *   isDispatched starts false — updated by dispatch-finished-good when shipped.
 *   Types: Lot, FinishedGood
 *   Reads:  users/{businessId}/finished_goods (query: lotId, limit 1 — duplicate check)
 *   Writes: users/{businessId}/finished_goods/{finishedGoodId}
 *
 * syncMaterialStockOnReservationChange  [onDocumentWritten: users/{businessId}/material_reservations/{reservationId}]
 *   Fires on every reservation write. Sole owner of reservedStock, availableStock,
 *   and totalStock updates for the reservation lifecycle. Routes never touch
 *   these fields directly for RESERVATION / CONSUMPTION / RETURN events.
 *   Three transitions handled:
 *     Created (no before) → status RESERVED:
 *       reservedStock↑ qty, availableStock↓ qty
 *       (stock committed — physically still in warehouse)
 *     RESERVED → CONSUMED:
 *       reservedStock↓ qty, totalStock↓ qty
 *       (stock physically used up at the stage)
 *     RESERVED → RELEASED:
 *       reservedStock↓ qty, availableStock↑ qty
 *       (commitment cancelled — stock freed back)
 *   All other transitions (e.g. already CONSUMED → no-op) are ignored.
 *   Types: MaterialReservation, RawMaterial
 *   Reads:  (event data only — no additional Firestore reads)
 *   Writes: users/{businessId}/raw_materials/{materialId}
 *
 * =============================================================================
 * SECTION 8 — SCHEDULED
 * =============================================================================
 *
 * recomputeLotDelays  [onSchedule: daily 9am IST (03:00 UTC)]
 *   Iterates all businesses and all ACTIVE lots in chunks of 100 using
 *   cursor-based pagination. Recomputes isDelayed and delayDays for each lot
 *   by comparing plannedDate of PENDING and IN_PROGRESS stages against today.
 *   Only writes if the value has actually changed — avoids unnecessary Firestore
 *   writes and prevents triggering downstream triggers on unchanged lots.
 *   Runs daily to catch lots that became delayed overnight without any user action.
 *   Types: Lot, LotStage
 *   Reads:  users (all businesses)
 *           users/{businessId}/lots (query: status ACTIVE, paginated in chunks of 100)
 *   Writes: users/{businessId}/lots/{lotId} (only if isDelayed or delayDays changed)
 *
 * =============================================================================
 */

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue, QueryDocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebaseAdmin";
import { Lot, LotStage, MaterialReservation, FinishedGood, LotStageHistory } from "../types";

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

function computeDelayStatus(stages: LotStage[]): { isDelayed: boolean; delayDays: number } {
  const now = Timestamp.now().toDate();
  let maxDelay = 0;

  for (const stage of stages) {
    if (stage.status === "PENDING" || stage.status === "IN_PROGRESS") {
      const planned = stage.plannedDate.toDate();
      const diff = Math.floor((now.getTime() - planned.getTime()) / (1000 * 60 * 60 * 24));
      if (diff > 0) maxDelay = Math.max(maxDelay, diff);
    }
  }

  return { isDelayed: maxDelay > 0, delayDays: maxDelay };
}

// ============================================================================
// SECTION 6 — BACKGROUND (TRIGGERS + SCHEDULED)
//
// Triggers on lots/:
//   syncOrderStatsOnLotChange            → re-aggregates order stats on every lot write
//   appendLotStageHistoryOnStageAdvance  → writes LotStageHistory when currentSequence changes
//   createFinishedGoodOnLotCompleted     → creates finished_goods doc when lot → COMPLETED
//
// Trigger on material_reservations/:
//   syncMaterialStockOnReservationChange → keeps reservedStock / availableStock / totalStock
//                                          in sync on every reservation status change
//
// Scheduled:
//   recomputeLotDelays                   → daily 9am IST, recomputes isDelayed/delayDays
// ============================================================================

export const syncOrderStatsOnLotChange = onDocumentWritten(
  "users/{businessId}/lots/{lotId}",
  async (event) => {
    const businessId = event.params.businessId;
    const after = event.data?.after?.data() as Lot | undefined;
    const before = event.data?.before?.data() as Lot | undefined;

    const orderId = after?.orderId ?? before?.orderId;
    if (!orderId) return;

    const lotsSnap = await db
      .collection(`users/${businessId}/lots`)
      .where("orderId", "==", orderId)
      .get();

    let lotsCompleted = 0;
    let lotsInProduction = 0;
    let lotsDelayed = 0;

    for (const doc of lotsSnap.docs) {
      const lot = doc.data() as Lot;
      if (lot.status === "COMPLETED") lotsCompleted++;
      else if (lot.status === "ACTIVE") lotsInProduction++;
      if (lot.isDelayed) lotsDelayed++;
    }

    const allCompleted = lotsCompleted === lotsSnap.size && lotsSnap.size > 0;

    // Only touch status if the order is currently IN_PRODUCTION.
    // Do NOT override CANCELLED or COMPLETED status.
    const orderRef = db.doc(`users/${businessId}/orders/${orderId}`);
    const orderSnap = await orderRef.get();
    const currentStatus = orderSnap.data()?.status;

    const update: Record<string, unknown> = {
      lotsCompleted,
      lotsInProduction,
      lotsDelayed,
      updatedAt: Timestamp.now(),
    };

    if (currentStatus === "IN_PRODUCTION" && allCompleted) {
      update.status = "COMPLETED";
    }

    await orderRef.update(update);
  },
);

// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------

export const appendLotStageHistoryOnStageAdvance = onDocumentWritten(
  "users/{businessId}/lots/{lotId}",
  async (event) => {
    const businessId = event.params.businessId;
    const lotId = event.params.lotId;

    const before = event.data?.before?.data() as Lot | undefined;
    const after = event.data?.after?.data() as Lot | undefined;

    // Only fire when currentSequence advances
    if (!before || !after) return;
    const sequenceAdvanced = after.currentSequence !== before.currentSequence;
    const lastStageCompleted = before.status !== "COMPLETED" && after.status === "COMPLETED";

    if (!sequenceAdvanced && !lastStageCompleted) return;

    // For last stage, completedStage is still at before.currentSequence - 1
    const completedStage = after.stages[before.currentSequence - 1];
    if (!completedStage) return;

    const historyRef = db.collection(`users/${businessId}/lot_stage_history`).doc();
    await historyRef.set({
      id: historyRef.id,
      lotId,
      lotNumber: after.lotNumber,
      orderId: after.orderId,
      fromStage: before.currentStage,
      toStage: after.currentStage,
      fromSequence: before.currentSequence,
      toSequence: after.currentSequence,
      movedBy: completedStage.completedBy ?? null,
      movedAt: completedStage.actualDate ?? Timestamp.now(),
      note: completedStage.note ?? null,
    } satisfies LotStageHistory);
  },
);

// ----------------------------------------------------------------------------

export const createFinishedGoodOnLotCompleted = onDocumentWritten(
  "users/{businessId}/lots/{lotId}",
  async (event) => {
    const businessId = event.params.businessId;
    const lotId = event.params.lotId;

    const before = event.data?.before?.data() as Lot | undefined;
    const after = event.data?.after?.data() as Lot | undefined;

    // Only fire when status flips to COMPLETED
    if (!after || after.status !== "COMPLETED") return;
    if (before?.status === "COMPLETED") return;

    // Guard against duplicate creation (e.g. trigger retry)
    const existing = await db
      .collection(`users/${businessId}/finished_goods`)
      .where("lotId", "==", lotId)
      .limit(1)
      .get();

    if (!existing.empty) return;

    const now = Timestamp.now();
    const fgRef = db.collection(`users/${businessId}/finished_goods`).doc();

    await fgRef.set({
      id: fgRef.id,
      lotId,
      lotNumber: after.lotNumber,
      orderId: after.orderId,
      orderNumber: after.orderNumber,
      buyerId: after.buyerId,
      buyerName: after.buyerName,
      productId: after.productId,
      productName: after.productName,
      productSku: after.productSku,
      color: after.color,
      size: after.size ?? null,
      quantity: after.quantity,
      cartonCount: null,
      totalWeightKg: null,
      packedAt: now,
      dispatchedAt: null,
      isDispatched: false,
      courierName: null,
      awb: null,
      createdAt: now,
      updatedAt: now,
    } satisfies FinishedGood);
  },
);

// ----------------------------------------------------------------------------

export const syncMaterialStockOnReservationChange = onDocumentWritten(
  "users/{businessId}/material_reservations/{reservationId}",
  async (event) => {
    const businessId = event.params.businessId;

    const before = event.data?.before?.data() as MaterialReservation | undefined;
    const after = event.data?.after?.data() as MaterialReservation | undefined;

    const materialId = after?.materialId ?? before?.materialId;
    if (!materialId) return;

    const materialRef = db.doc(`users/${businessId}/raw_materials/${materialId}`);
    const now = Timestamp.now();

    const beforeStatus = before?.status ?? null;
    const afterStatus = after?.status ?? null;
    const qty = after?.quantityRequired ?? before?.quantityRequired ?? 0;

    // Created → RESERVED
    if (!before && afterStatus === "RESERVED") {
      await materialRef.update({
        reservedStock: FieldValue.increment(qty),
        availableStock: FieldValue.increment(-qty),
        updatedAt: now,
      });
      return;
    }

    // RESERVED → CONSUMED (stage completed, material physically used up)
    if (beforeStatus === "RESERVED" && afterStatus === "CONSUMED") {
      await materialRef.update({
        reservedStock: FieldValue.increment(-qty),
        totalStock: FieldValue.increment(-qty),
        updatedAt: now,
      });
      return;
    }

    // RESERVED → RELEASED (lot or order cancelled)
    if (beforeStatus === "RESERVED" && afterStatus === "RELEASED") {
      await materialRef.update({
        reservedStock: FieldValue.increment(-qty),
        availableStock: FieldValue.increment(qty),
        updatedAt: now,
      });
      return;
    }
  },
);

export const recomputeLotDelays = onSchedule(
  { schedule: "0 3 * * *", timeZone: "Asia/Kolkata" }, // 3 UTC = 9 IST
  async () => {
    const CHUNK = 100;
    const businessSnap = await db.collection("users").get();

    for (const bizDoc of businessSnap.docs) {
      const businessId = bizDoc.id;
      let lastDoc: QueryDocumentSnapshot | undefined;
      let hasMore = true;

      while (hasMore) {
        let query = db
          .collection(`users/${businessId}/lots`)
          .where("status", "==", "ACTIVE")
          .limit(CHUNK);

        if (lastDoc) query = query.startAfter(lastDoc);

        const snap = await query.get();
        if (snap.empty) break;

        const batch = db.batch();
        for (const doc of snap.docs) {
          const lot = doc.data() as Lot;
          const { isDelayed, delayDays } = computeDelayStatus(lot.stages);
          if (lot.isDelayed !== isDelayed || lot.delayDays !== delayDays) {
            batch.update(doc.ref, { isDelayed, delayDays, updatedAt: Timestamp.now() });
          }
        }
        await batch.commit();

        lastDoc = snap.docs[snap.docs.length - 1];
        if (snap.size < CHUNK) hasMore = false;
      }
    }
  },
);
