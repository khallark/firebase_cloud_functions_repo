/*
 * =============================================================================
 * B2B OMS — CLOUD FUNCTIONS
 * =============================================================================
 *
 * All functions are HTTP onRequest handlers unless noted otherwise.
 * All write functions require the x-api-key header (ENQUEUE_FUNCTION_SECRET).
 * All paths are scoped under users/{businessId}/...
 *
 * =============================================================================
 * SECTION 1 — MASTER DATA
 * =============================================================================
 *
 * createBuyer
 *   Creates a new buyer record.
 *   Types: Buyer
 *   Writes: users/{businessId}/buyers/{buyerId}
 *
 * updateBuyer
 *   Updates editable fields on an existing buyer (name, contact, address, etc.).
 *   Cannot change id or createdAt.
 *   Types: Buyer
 *   Writes: users/{businessId}/buyers/{buyerId}
 *
 * createProduct
 *   Creates a new finished-garment product with a default stage sequence.
 *   Types: Product
 *   Writes: users/{businessId}/b2bProducts/{productId}
 *
 * updateProduct
 *   Updates editable fields on a product (name, category, defaultStages, etc.).
 *   Types: Product
 *   Writes: users/{businessId}/b2bProducts/{productId}
 *
 * createRawMaterial
 *   Creates a new raw material with zero stock. Stock is added separately via addStock.
 *   Types: RawMaterial
 *   Writes: users/{businessId}/raw_materials/{materialId}
 *
 * updateRawMaterial
 *   Updates metadata on a raw material (name, category, reorderLevel, supplier, etc.).
 *   Does NOT touch stock fields — use addStock / adjustStock for that.
 *   Types: RawMaterial
 *   Writes: users/{businessId}/raw_materials/{materialId}
 *
 * createBOMEntry
 *   Creates a BOM entry linking one product to one raw material.
 *   Defines how much of the material is needed per finished piece,
 *   which production stage consumes it, and the wastage buffer %.
 *   Types: BOMEntry
 *   Reads:  users/{businessId}/b2bProducts/{productId}
 *           users/{businessId}/raw_materials/{materialId}
 *   Writes: users/{businessId}/bom/{bomId}
 *
 * updateBOMEntry
 *   Updates quantityPerPiece, wastagePercent, or consumedAtStage on a BOM entry.
 *   Cannot change which product or material the entry links.
 *   Types: BOMEntry
 *   Writes: users/{businessId}/bom/{bomId}
 *
 * deactivateBOMEntry
 *   Soft-deletes a BOM entry by setting isActive: false.
 *   Deactivated entries are ignored by createOrder / confirmOrder.
 *   Types: BOMEntry
 *   Writes: users/{businessId}/bom/{bomId}
 *
 * createStageConfig
 *   Creates a production stage config entry (seed data for the stage picker UI).
 *   Types: ProductionStageConfig
 *   Writes: users/{businessId}/production_stage_config/{stageId}
 *
 * updateStageConfig
 *   Updates label, description, defaultDurationDays, canBeOutsourced, or sortOrder.
 *   Types: ProductionStageConfig
 *   Writes: users/{businessId}/production_stage_config/{stageId}
 *
 * =============================================================================
 * SECTION 2 — ORDER LIFECYCLE
 * =============================================================================
 *
 * saveDraftOrder
 *   Creates an order in DRAFT status. No lots are created, no materials reserved.
 *   Lot configurations are stored as draftLots[] on the order doc for later editing.
 *   Types: Order, DraftLotInput
 *   Writes: users/{businessId}/orders/{orderId}
 *           users/{businessId}/counters/orders
 *
 * confirmOrder
 *   Moves a DRAFT order to IN_PRODUCTION. Creates lots, fetches BOM per product,
 *   checks material availability, reserves stock, and clears draftLots from the order.
 *   Optionally accepts updated lot configs to allow last-minute changes before confirming.
 *   Rolls back to DRAFT if stock check fails.
 *   Types: Order, DraftLotInput, Lot, LotStage, BOMEntry, MaterialReservation, RawMaterial
 *   Reads:  users/{businessId}/orders/{orderId}
 *           users/{businessId}/bom (query by productId)
 *           users/{businessId}/raw_materials/{materialId}
 *   Writes: users/{businessId}/orders/{orderId}
 *           users/{businessId}/lots/{lotId} (one per lot)
 *           users/{businessId}/material_reservations/{reservationId} (one per lot-material pair)
 *           users/{businessId}/raw_materials/{materialId} (reservedStock / availableStock)
 *           users/{businessId}/counters/lots
 *
 * createOrder
 *   Creates an order and immediately starts production in a single call (no draft step).
 *   Identical to confirmOrder but also creates the order doc in the same batch.
 *   Types: Order, DraftLotInput, Lot, LotStage, BOMEntry, MaterialReservation, RawMaterial
 *   Reads:  users/{businessId}/bom (query by productId)
 *           users/{businessId}/raw_materials/{materialId}
 *   Writes: users/{businessId}/orders/{orderId}
 *           users/{businessId}/lots/{lotId}
 *           users/{businessId}/material_reservations/{reservationId}
 *           users/{businessId}/raw_materials/{materialId}
 *           users/{businessId}/counters/orders
 *           users/{businessId}/counters/lots
 *
 * cancelOrder
 *   Cancels an order and all its active lots.
 *   For DRAFT orders: just flips status, no lot/reservation cleanup needed.
 *   For IN_PRODUCTION orders: cancels all non-completed lots, releases all RESERVED
 *   material reservations, restores availableStock, and writes RETURN transactions.
 *   Types: Order, Lot, MaterialReservation, RawMaterial, MaterialTransaction
 *   Reads:  users/{businessId}/orders/{orderId}
 *           users/{businessId}/lots (query by orderId)
 *           users/{businessId}/material_reservations (query by lotId + status)
 *   Writes: users/{businessId}/orders/{orderId}
 *           users/{businessId}/lots/{lotId}
 *           users/{businessId}/material_reservations/{reservationId}
 *           users/{businessId}/raw_materials/{materialId}
 *           users/{businessId}/material_transactions/{txId}
 *
 * =============================================================================
 * SECTION 3 — LOT LIFECYCLE
 * =============================================================================
 *
 * advanceLotStage
 *   Marks the current stage COMPLETED and moves the lot to the next stage.
 *   Consumes all RESERVED material reservations for the completed stage,
 *   decrementing reservedStock and totalStock on each raw material.
 *   If the completed stage is the last one, creates a finished_goods doc
 *   and marks the lot COMPLETED.
 *   Runs in a Firestore transaction.
 *   Types: Lot, LotStage, LotStageHistory, MaterialReservation, RawMaterial, FinishedGood
 *   Reads:  users/{businessId}/lots/{lotId}
 *           users/{businessId}/material_reservations (query by lotId + stage + status)
 *   Writes: users/{businessId}/lots/{lotId}
 *           users/{businessId}/lot_stage_history/{historyId}
 *           users/{businessId}/material_reservations/{reservationId}
 *           users/{businessId}/raw_materials/{materialId}
 *           users/{businessId}/finished_goods/{finishedGoodId} (if last stage)
 *
 * setLotStageBlocked
 *   Toggles the current stage between BLOCKED and IN_PROGRESS.
 *   Used to flag a lot that needs attention (machine breakdown, outsource delay, etc.)
 *   and to clear that flag when resolved.
 *   Types: Lot, LotStage
 *   Reads:  users/{businessId}/lots/{lotId}
 *   Writes: users/{businessId}/lots/{lotId}
 *
 * cancelLot
 *   Cancels a single lot. Releases all RESERVED reservations for the lot,
 *   restores availableStock, and writes RETURN transactions per material.
 *   Guards against cancelling an already-CANCELLED or COMPLETED lot.
 *   Runs in a Firestore transaction.
 *   Types: Lot, MaterialReservation, RawMaterial, MaterialTransaction
 *   Reads:  users/{businessId}/lots/{lotId}
 *           users/{businessId}/material_reservations (query by lotId + status)
 *   Writes: users/{businessId}/lots/{lotId}
 *           users/{businessId}/material_reservations/{reservationId}
 *           users/{businessId}/raw_materials/{materialId}
 *           users/{businessId}/material_transactions/{txId}
 *
 * =============================================================================
 * SECTION 4 — STOCK MANAGEMENT
 * =============================================================================
 *
 * addStock
 *   Records an inbound stock receipt (GRN / purchase order).
 *   Increments both totalStock and availableStock.
 *   Writes a PURCHASE transaction with stockBefore / stockAfter.
 *   Quantity must be positive.
 *   Types: RawMaterial, MaterialTransaction
 *   Reads:  users/{businessId}/raw_materials/{materialId}
 *   Writes: users/{businessId}/raw_materials/{materialId}
 *           users/{businessId}/material_transactions/{txId}
 *
 * adjustStock
 *   Manual stock correction (positive or negative). Requires a note explaining why.
 *   Only touches totalStock and availableStock — never reservedStock
 *   (reservations are independent commitments and must not be silently changed).
 *   Guards against pushing availableStock below zero.
 *   Writes an ADJUSTMENT transaction with stockBefore / stockAfter.
 *   Types: RawMaterial, MaterialTransaction
 *   Reads:  users/{businessId}/raw_materials/{materialId}
 *   Writes: users/{businessId}/raw_materials/{materialId}
 *           users/{businessId}/material_transactions/{txId}
 *
 * --- MaterialTransaction types and where each is written ---
 *
 *   PURCHASE     → addStock
 *   RESERVATION  → createOrder, confirmOrder  (stock locked for a lot)
 *   CONSUMPTION  → advanceLotStage            (stock physically used up)
 *   RETURN       → cancelOrder, cancelLot     (reserved stock released back)
 *   ADJUSTMENT   → adjustStock
 *
 * =============================================================================
 * SECTION 5 — DISPATCH
 * =============================================================================
 *
 * dispatchFinishedGood
 *   Marks a finished good as dispatched. Sets isDispatched: true, dispatchedAt,
 *   courierName, and awb. This is the handoff point to Majime — after dispatch,
 *   Majime takes over tracking via the AWB.
 *   Guards against double-dispatching.
 *   Types: FinishedGood
 *   Reads:  users/{businessId}/finished_goods/{finishedGoodId}
 *   Writes: users/{businessId}/finished_goods/{finishedGoodId}
 *
 * =============================================================================
 * SECTION 6 — BACKGROUND (TRIGGERS + SCHEDULED)
 * =============================================================================
 *
 * syncOrderStatsOnLotChange  [onDocumentWritten trigger]
 *   Fires on every lot write. Re-aggregates lotsCompleted, lotsInProduction,
 *   and lotsDelayed on the parent order by querying all lots for that order.
 *   Auto-sets order status to COMPLETED when all lots are completed.
 *   Types: Lot, Order
 *   Reads:  users/{businessId}/lots (query by orderId)
 *   Writes: users/{businessId}/orders/{orderId}
 *
 * recomputeLotDelays  [onSchedule — daily at 9am IST]
 *   Iterates all businesses and all ACTIVE lots in chunks of 100.
 *   Recomputes isDelayed and delayDays based on plannedDate vs today.
 *   Only writes if the value has changed, to avoid unnecessary Firestore writes.
 *   Types: Lot, LotStage
 *   Reads:  users (all businesses)
 *           users/{businessId}/lots (query by status ACTIVE, paginated)
 *   Writes: users/{businessId}/lots/{lotId} (only if delay status changed)
 *
 * =============================================================================
 * SECTION 7 — READ / QUERY
 * =============================================================================
 *
 * getOrderDashboard
 *   Returns the full order detail view in one call.
 *   Fetches the order doc and all its lots in parallel.
 *   Returns: order data, lots grouped by currentStage (for Kanban),
 *   and a tnaSummary per lot (for TNA table view).
 *   Types: Order, Lot, LotStage
 *   Reads:  users/{businessId}/orders/{orderId}
 *           users/{businessId}/lots (query by orderId)
 *
 * =============================================================================
 */

import { onRequest } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue, QueryDocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebaseAdmin";
import {
  Lot,
  LotStage,
  MaterialReservation,
  FinishedGood,
  LotStageHistory,
} from "../types";
import { requireHeaderSecret } from "../../helpers";
import { ENQUEUE_FUNCTION_SECRET } from "../../config";

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

      do {
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
        if (snap.size < CHUNK) break;
      } while (true);
    }
  },
);