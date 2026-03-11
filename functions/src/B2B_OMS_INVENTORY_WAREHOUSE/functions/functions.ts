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
  Order,
  DraftLotInput,
  MaterialReservation,
  RawMaterial,
  FinishedGood,
  LotStageHistory,
  BOMEntry,
  MaterialTransaction,
  MaterialTransactionType,
  Buyer,
  Product,
  ProductionStageConfig,
  StageName,
} from "../types";
import { requireHeaderSecret } from "../../helpers";
import { ENQUEUE_FUNCTION_SECRET } from "../../config";

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

async function generateLotNumber(businessId: string): Promise<string> {
  const counterRef = db.doc(`users/${businessId}/counters/lots`);
  const result = await db.runTransaction(async (tx) => {
    const doc = await tx.get(counterRef);
    const current = doc.exists ? (doc.data()!.count as number) : 800;
    tx.set(counterRef, { count: current + 1 }, { merge: true });
    return current + 1;
  });
  return String(result);
}

async function generateOrderNumber(businessId: string): Promise<string> {
  const counterRef = db.doc(`users/${businessId}/counters/orders`);
  const result = await db.runTransaction(async (tx) => {
    const doc = await tx.get(counterRef);
    const current = doc.exists ? (doc.data()!.count as number) : 0;
    tx.set(counterRef, { count: current + 1 }, { merge: true });
    return current + 1;
  });
  const year = new Date().getFullYear();
  return `ORD-${year}-${String(result).padStart(4, "0")}`;
}

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

async function buildLotsAndReservations(
  businessId: string,
  orderId: string,
  orderNumber: string,
  buyerId: string,
  buyerName: string,
  shipDate: Timestamp,
  createdBy: string,
  lotInputs: DraftLotInput[],
): Promise<{ lotDocs: Lot[]; reservationDocs: MaterialReservation[] }> {
  const lotDocs: Lot[] = [];
  const reservationDocs: MaterialReservation[] = [];

  for (const lotInput of lotInputs) {
    const lotNumber = await generateLotNumber(businessId);
    const lotId = db.collection(`users/${businessId}/lots`).doc().id;

    const builtStages: LotStage[] = lotInput.stages.map((s, i) => ({
      sequence: i + 1,
      stage: s.stage,
      plannedDate: Timestamp.fromDate(new Date(s.plannedDate)),
      actualDate: null,
      status: i === 0 ? "IN_PROGRESS" : "PENDING",
      isOutsourced: s.isOutsourced,
      outsourceVendorName: s.outsourceVendorName ?? null,
      outsourceSentAt: null,
      outsourceReturnedAt: null,
      completedBy: null,
      note: null,
    }));

    lotDocs.push({
      id: lotId,
      lotNumber,
      orderId,
      orderNumber,
      buyerId,
      buyerName,
      productId: lotInput.productId,
      productName: lotInput.productName,
      productSku: lotInput.productSku,
      color: lotInput.color,
      size: lotInput.size ?? null,
      quantity: lotInput.quantity,
      stages: builtStages,
      currentStage: builtStages[0].stage,
      currentSequence: 1,
      totalStages: builtStages.length,
      shipDate,
      isDelayed: false,
      delayDays: 0,
      status: "ACTIVE",
      createdBy,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    const bomSnap = await db
      .collection(`users/${businessId}/bom`)
      .where("productId", "==", lotInput.productId)
      .where("isActive", "==", true)
      .get();

    for (const bomDoc of bomSnap.docs) {
      const bom = bomDoc.data() as BOMEntry;
      const reservationId = db.collection(`users/${businessId}/material_reservations`).doc().id;
      const qtyRequired =
        lotInput.quantity * bom.quantityPerPiece * (1 + bom.wastagePercent / 100);

      reservationDocs.push({
        id: reservationId,
        lotId,
        lotNumber,
        orderId,
        orderNumber,
        materialId: bom.materialId,
        materialName: bom.materialName,
        materialUnit: bom.materialUnit,
        quantityRequired: Math.ceil(qtyRequired * 100) / 100,
        quantityConsumed: 0,
        consumedAtStage: bom.consumedAtStage,
        status: "RESERVED",
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
    }
  }

  return { lotDocs, reservationDocs };
}

async function checkStockShortfalls(
  businessId: string,
  reservationDocs: MaterialReservation[],
): Promise<string[]> {
  const materialTotals: Record<string, number> = {};
  for (const r of reservationDocs) {
    materialTotals[r.materialId] = (materialTotals[r.materialId] ?? 0) + r.quantityRequired;
  }

  const shortfalls: string[] = [];
  for (const [materialId, required] of Object.entries(materialTotals)) {
    const matDoc = await db.doc(`users/${businessId}/raw_materials/${materialId}`).get();
    if (!matDoc.exists) {
      shortfalls.push(materialId);
      continue;
    }
    const mat = matDoc.data() as RawMaterial;
    if (mat.availableStock < required) {
      shortfalls.push(`${mat.name} (need ${required} ${mat.unit}, have ${mat.availableStock})`);
    }
  }

  return shortfalls;
}

// ============================================================================
// SECTION 1 — MASTER DATA
// createBuyer → updateBuyer → createProduct → updateProduct →
// createRawMaterial → updateRawMaterial →
// createBOMEntry → updateBOMEntry → deactivateBOMEntry →
// createStageConfig → updateStageConfig
// ============================================================================

export const createBuyer = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, name, contactPerson, phone, email, address, gstNumber, createdBy } =
        req.body as {
          businessId: string;
          name: string;
          contactPerson: string;
          phone: string;
          email: string;
          address: string;
          gstNumber?: string;
          createdBy: string;
        };

      const buyerId = db.collection(`users/${businessId}/buyers`).doc().id;
      const now = Timestamp.now();

      await db.doc(`users/${businessId}/buyers/${buyerId}`).set({
        id: buyerId,
        name,
        contactPerson,
        phone,
        email,
        address,
        gstNumber: gstNumber ?? null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      } satisfies Buyer);

      res.status(200).json({ buyerId });
    } catch (error) {
      console.error("createBuyer error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ----------------------------------------------------------------------------

export const updateBuyer = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, buyerId, ...fields } = req.body as {
        businessId: string;
        buyerId: string;
        name?: string;
        contactPerson?: string;
        phone?: string;
        email?: string;
        address?: string;
        gstNumber?: string | null;
        isActive?: boolean;
      };

      const buyerRef = db.doc(`users/${businessId}/buyers/${buyerId}`);
      const buyerDoc = await buyerRef.get();

      if (!buyerDoc.exists) {
        res.status(404).json({ error: "buyer_not_found" });
        return;
      }

      // Strip undefined values so we don't write them to Firestore
      const updates = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );

      await buyerRef.update({ ...updates, updatedAt: Timestamp.now() });
      res.status(200).json({ success: true });
    } catch (error) {
      console.error("updateBuyer error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ----------------------------------------------------------------------------

export const createProduct = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, name, sku, category, description, defaultStages } = req.body as {
        businessId: string;
        name: string;
        sku: string;
        category: string;
        description?: string;
        defaultStages: StageName[];
      };

      const productId = db.collection(`users/${businessId}/b2bProducts`).doc().id;
      const now = Timestamp.now();

      await db.doc(`users/${businessId}/b2bProducts/${productId}`).set({
        id: productId,
        name,
        sku,
        category,
        description: description ?? null,
        defaultStages,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      } satisfies Product);

      res.status(200).json({ productId });
    } catch (error) {
      console.error("createProduct error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ----------------------------------------------------------------------------

export const updateProduct = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, productId, ...fields } = req.body as {
        businessId: string;
        productId: string;
        name?: string;
        sku?: string;
        category?: string;
        description?: string | null;
        defaultStages?: StageName[];
        isActive?: boolean;
      };

      const productRef = db.doc(`users/${businessId}/b2bProducts/${productId}`);
      const productDoc = await productRef.get();

      if (!productDoc.exists) {
        res.status(404).json({ error: "product_not_found" });
        return;
      }

      const updates = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );

      await productRef.update({ ...updates, updatedAt: Timestamp.now() });
      res.status(200).json({ success: true });
    } catch (error) {
      console.error("updateProduct error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ----------------------------------------------------------------------------

export const createRawMaterial = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, name, sku, unit, category, reorderLevel, supplierName } =
        req.body as {
          businessId: string;
          name: string;
          sku: string;
          unit: string;
          category: string;
          reorderLevel: number;
          supplierName?: string;
        };

      const materialId = db.collection(`users/${businessId}/raw_materials`).doc().id;
      const now = Timestamp.now();

      await db.doc(`users/${businessId}/raw_materials/${materialId}`).set({
        id: materialId,
        name,
        sku,
        unit,
        category,
        totalStock: 0,
        reservedStock: 0,
        availableStock: 0,
        reorderLevel,
        supplierName: supplierName ?? null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      } satisfies RawMaterial);

      res.status(200).json({ materialId });
    } catch (error) {
      console.error("createRawMaterial error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ----------------------------------------------------------------------------

export const updateRawMaterial = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, materialId, ...fields } = req.body as {
        businessId: string;
        materialId: string;
        name?: string;
        sku?: string;
        unit?: string;
        category?: string;
        reorderLevel?: number;
        supplierName?: string | null;
        isActive?: boolean;
      };

      const materialRef = db.doc(`users/${businessId}/raw_materials/${materialId}`);
      const materialDoc = await materialRef.get();

      if (!materialDoc.exists) {
        res.status(404).json({ error: "material_not_found" });
        return;
      }

      // Explicitly block stock field edits — those go through addStock / adjustStock
      const STOCK_FIELDS = ["totalStock", "reservedStock", "availableStock"];
      for (const f of STOCK_FIELDS) {
        if (f in fields) {
          res.status(400).json({
            error: "stock_fields_not_allowed",
            message: `Cannot update ${f} directly. Use addStock or adjustStock.`,
          });
          return;
        }
      }

      const updates = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );

      await materialRef.update({ ...updates, updatedAt: Timestamp.now() });
      res.status(200).json({ success: true });
    } catch (error) {
      console.error("updateRawMaterial error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ----------------------------------------------------------------------------

export const createBOMEntry = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const {
        businessId,
        productId,
        materialId,
        quantityPerPiece,
        consumedAtStage,
        wastagePercent,
      } = req.body as {
        businessId: string;
        productId: string;
        materialId: string;
        quantityPerPiece: number;
        consumedAtStage: StageName;
        wastagePercent: number;
      };

      // Fetch product and material to denormalize names into the BOM entry
      const [productDoc, materialDoc] = await Promise.all([
        db.doc(`users/${businessId}/b2bProducts/${productId}`).get(),
        db.doc(`users/${businessId}/raw_materials/${materialId}`).get(),
      ]);

      if (!productDoc.exists) {
        res.status(404).json({ error: "product_not_found" });
        return;
      }
      if (!materialDoc.exists) {
        res.status(404).json({ error: "material_not_found" });
        return;
      }

      const product = productDoc.data() as Product;
      const material = materialDoc.data() as RawMaterial;

      // Guard: prevent duplicate active BOM entry for the same product-material pair
      const existingSnap = await db
        .collection(`users/${businessId}/bom`)
        .where("productId", "==", productId)
        .where("materialId", "==", materialId)
        .where("isActive", "==", true)
        .get();

      if (!existingSnap.empty) {
        res.status(400).json({
          error: "bom_entry_already_exists",
          message: `An active BOM entry for this product-material pair already exists. Deactivate it first to replace it.`,
        });
        return;
      }

      const bomId = db.collection(`users/${businessId}/bom`).doc().id;
      const now = Timestamp.now();

      await db.doc(`users/${businessId}/bom/${bomId}`).set({
        id: bomId,
        productId,
        productName: product.name,
        productSku: product.sku,
        materialId,
        materialName: material.name,
        materialUnit: material.unit,
        quantityPerPiece,
        consumedAtStage,
        wastagePercent,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      } satisfies BOMEntry);

      res.status(200).json({ bomId });
    } catch (error) {
      console.error("createBOMEntry error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ----------------------------------------------------------------------------

export const updateBOMEntry = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, bomId, quantityPerPiece, wastagePercent, consumedAtStage } =
        req.body as {
          businessId: string;
          bomId: string;
          quantityPerPiece?: number;
          wastagePercent?: number;
          consumedAtStage?: StageName;
        };

      const bomRef = db.doc(`users/${businessId}/bom/${bomId}`);
      const bomDoc = await bomRef.get();

      if (!bomDoc.exists) {
        res.status(404).json({ error: "bom_entry_not_found" });
        return;
      }

      const updates: Record<string, unknown> = { updatedAt: Timestamp.now() };
      if (quantityPerPiece !== undefined) updates.quantityPerPiece = quantityPerPiece;
      if (wastagePercent !== undefined) updates.wastagePercent = wastagePercent;
      if (consumedAtStage !== undefined) updates.consumedAtStage = consumedAtStage;

      await bomRef.update(updates);
      res.status(200).json({ success: true });
    } catch (error) {
      console.error("updateBOMEntry error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ----------------------------------------------------------------------------

export const deactivateBOMEntry = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, bomId } = req.body as {
        businessId: string;
        bomId: string;
      };

      const bomRef = db.doc(`users/${businessId}/bom/${bomId}`);
      const bomDoc = await bomRef.get();

      if (!bomDoc.exists) {
        res.status(404).json({ error: "bom_entry_not_found" });
        return;
      }

      if (!(bomDoc.data() as BOMEntry).isActive) {
        res.status(400).json({ error: "bom_entry_already_inactive" });
        return;
      }

      await bomRef.update({ isActive: false, updatedAt: Timestamp.now() });
      res.status(200).json({ success: true });
    } catch (error) {
      console.error("deactivateBOMEntry error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ----------------------------------------------------------------------------

export const createStageConfig = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, name, label, description, defaultDurationDays, canBeOutsourced, sortOrder } =
        req.body as {
          businessId: string;
          name: StageName;
          label: string;
          description: string;
          defaultDurationDays: number;
          canBeOutsourced: boolean;
          sortOrder: number;
        };

      const stageId = db.collection(`users/${businessId}/production_stage_config`).doc().id;

      await db.doc(`users/${businessId}/production_stage_config/${stageId}`).set({
        id: stageId,
        name,
        label,
        description,
        defaultDurationDays,
        canBeOutsourced,
        sortOrder,
        createdAt: Timestamp.now(),
      } satisfies ProductionStageConfig);

      res.status(200).json({ stageId });
    } catch (error) {
      console.error("createStageConfig error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ----------------------------------------------------------------------------

export const updateStageConfig = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, stageId, ...fields } = req.body as {
        businessId: string;
        stageId: string;
        label?: string;
        description?: string;
        defaultDurationDays?: number;
        canBeOutsourced?: boolean;
        sortOrder?: number;
      };

      const stageRef = db.doc(`users/${businessId}/production_stage_config/${stageId}`);
      const stageDoc = await stageRef.get();

      if (!stageDoc.exists) {
        res.status(404).json({ error: "stage_config_not_found" });
        return;
      }

      // name is intentionally not updatable — it's the StageName enum value
      // that lots reference by string. Changing it would orphan existing lots.
      if ("name" in fields) {
        res.status(400).json({
          error: "name_not_updatable",
          message: "Stage name cannot be changed as it is referenced by existing lots.",
        });
        return;
      }

      const updates = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );

      await stageRef.update(updates);
      res.status(200).json({ success: true });
    } catch (error) {
      console.error("updateStageConfig error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ============================================================================
// SECTION 2 — ORDER LIFECYCLE
// saveDraftOrder → confirmOrder → createOrder → cancelOrder
// ============================================================================

interface SaveDraftOrderPayload {
  businessId: string;
  buyerId: string;
  buyerName: string;
  buyerContact: string;
  shipDate: string; // ISO string
  deliveryAddress: string;
  note?: string;
  createdBy: string;
  lots: DraftLotInput[];
}

export const saveDraftOrder = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const {
        businessId,
        buyerId,
        buyerName,
        buyerContact,
        shipDate,
        deliveryAddress,
        note,
        createdBy,
        lots,
      } = req.body as SaveDraftOrderPayload;

      const orderNumber = await generateOrderNumber(businessId);
      const orderId = db.collection(`users/${businessId}/orders`).doc().id;

      await db.doc(`users/${businessId}/orders/${orderId}`).set({
        id: orderId,
        orderNumber,
        buyerId,
        buyerName,
        buyerContact,
        shipDate: Timestamp.fromDate(new Date(shipDate)),
        deliveryAddress,
        draftLots: lots,
        totalLots: 0,
        totalQuantity: 0,
        lotsCompleted: 0,
        lotsInProduction: 0,
        lotsDelayed: 0,
        status: "DRAFT",
        note: note ?? null,
        createdBy,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      } satisfies Order);

      res.status(200).json({ orderId, orderNumber });
    } catch (error) {
      console.error("saveDraftOrder error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ----------------------------------------------------------------------------

interface ConfirmOrderPayload {
  businessId: string;
  orderId: string;
  confirmedBy: string;
  lots?: DraftLotInput[];
}

export const confirmOrder = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 540,
    memory: "256MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const {
        businessId,
        orderId,
        confirmedBy,
        lots: incomingLots,
      } = req.body as ConfirmOrderPayload;

      const orderRef = db.doc(`users/${businessId}/orders/${orderId}`);
      const orderDoc = await orderRef.get();

      if (!orderDoc.exists) {
        res.status(404).json({ error: "order_not_found" });
        return;
      }

      const order = orderDoc.data() as Order;

      if (order.status !== "DRAFT") {
        res.status(400).json({
          error: "order_not_draft",
          message: `Order is currently ${order.status}. Only DRAFT orders can be confirmed.`,
        });
        return;
      }

      const lotInputs = incomingLots ?? order.draftLots;

      if (!lotInputs || lotInputs.length === 0) {
        res.status(400).json({ error: "no_lots_defined" });
        return;
      }

      await orderRef.update({ status: "CONFIRMED", updatedAt: Timestamp.now() });

      const { lotDocs, reservationDocs } = await buildLotsAndReservations(
        businessId,
        orderId,
        order.orderNumber,
        order.buyerId,
        order.buyerName,
        order.shipDate,
        confirmedBy,
        lotInputs,
      );

      const shortfalls = await checkStockShortfalls(businessId, reservationDocs);

      if (shortfalls.length > 0) {
        await orderRef.update({ status: "DRAFT", updatedAt: Timestamp.now() });
        res.status(400).json({
          error: "insufficient_stock",
          message: `Insufficient raw material stock: ${shortfalls.join(", ")}`,
        });
        return;
      }

      const batch = db.batch();

      for (const lot of lotDocs) {
        batch.set(db.doc(`users/${businessId}/lots/${lot.id}`), lot);
      }

      for (const reservation of reservationDocs) {
        batch.set(
          db.doc(`users/${businessId}/material_reservations/${reservation.id}`),
          reservation,
        );
        batch.update(db.doc(`users/${businessId}/raw_materials/${reservation.materialId}`), {
          reservedStock: FieldValue.increment(reservation.quantityRequired),
          availableStock: FieldValue.increment(-reservation.quantityRequired),
          updatedAt: Timestamp.now(),
        });
        const txRef = db.collection(`users/${businessId}/material_transactions`).doc();
        batch.set(txRef, {
          id: txRef.id,
          materialId: reservation.materialId,
          materialName: reservation.materialName,
          type: "RESERVATION" as MaterialTransactionType,
          quantity: reservation.quantityRequired,
          referenceId: orderId,
          referenceType: "LOT",
          note: `Stock reserved for Lot ${reservation.lotNumber} (Order ${order.orderNumber})`,
          createdBy: confirmedBy,
          createdAt: Timestamp.now(),
        } satisfies Omit<MaterialTransaction, "stockBefore" | "stockAfter">);
      }

      batch.update(orderRef, {
        status: "IN_PRODUCTION",
        draftLots: null,
        totalLots: lotDocs.length,
        totalQuantity: lotDocs.reduce((s, l) => s + l.quantity, 0),
        lotsInProduction: lotDocs.length,
        updatedAt: Timestamp.now(),
      });

      await batch.commit();
      res.status(200).json({ success: true, lotCount: lotDocs.length });
    } catch (error) {
      console.error("confirmOrder error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ----------------------------------------------------------------------------

interface CreateOrderPayload {
  businessId: string;
  buyerId: string;
  buyerName: string;
  buyerContact: string;
  shipDate: string;
  deliveryAddress: string;
  note?: string;
  createdBy: string;
  lots: DraftLotInput[];
}

export const createOrder = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 540,
    memory: "256MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const {
        businessId,
        buyerId,
        buyerName,
        buyerContact,
        shipDate,
        deliveryAddress,
        note,
        createdBy,
        lots,
      } = req.body as CreateOrderPayload;

      const orderNumber = await generateOrderNumber(businessId);
      const orderId = db.collection(`users/${businessId}/orders`).doc().id;
      const shipTimestamp = Timestamp.fromDate(new Date(shipDate));

      const { lotDocs, reservationDocs } = await buildLotsAndReservations(
        businessId,
        orderId,
        orderNumber,
        buyerId,
        buyerName,
        shipTimestamp,
        createdBy,
        lots,
      );

      const shortfalls = await checkStockShortfalls(businessId, reservationDocs);

      if (shortfalls.length > 0) {
        res.status(400).json({
          error: "insufficient_stock",
          message: `Insufficient raw material stock: ${shortfalls.join(", ")}`,
        });
        return;
      }

      const batch = db.batch();

      const orderRef = db.doc(`users/${businessId}/orders/${orderId}`);
      batch.set(orderRef, {
        id: orderId,
        orderNumber,
        buyerId,
        buyerName,
        buyerContact,
        shipDate: shipTimestamp,
        deliveryAddress,
        draftLots: null,
        totalLots: lotDocs.length,
        totalQuantity: lotDocs.reduce((s, l) => s + l.quantity, 0),
        lotsCompleted: 0,
        lotsInProduction: lotDocs.length,
        lotsDelayed: 0,
        status: "IN_PRODUCTION",
        note: note ?? null,
        createdBy,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      } satisfies Order);

      for (const lot of lotDocs) {
        batch.set(db.doc(`users/${businessId}/lots/${lot.id}`), lot);
      }

      for (const reservation of reservationDocs) {
        batch.set(
          db.doc(`users/${businessId}/material_reservations/${reservation.id}`),
          reservation,
        );
        batch.update(db.doc(`users/${businessId}/raw_materials/${reservation.materialId}`), {
          reservedStock: FieldValue.increment(reservation.quantityRequired),
          availableStock: FieldValue.increment(-reservation.quantityRequired),
          updatedAt: Timestamp.now(),
        });
        const txRef = db.collection(`users/${businessId}/material_transactions`).doc();
        batch.set(txRef, {
          id: txRef.id,
          materialId: reservation.materialId,
          materialName: reservation.materialName,
          type: "RESERVATION" as MaterialTransactionType,
          quantity: reservation.quantityRequired,
          referenceId: orderId,
          referenceType: "LOT",
          note: `Stock reserved for Lot ${reservation.lotNumber} (Order ${orderNumber})`,
          createdBy: createdBy,
          createdAt: Timestamp.now(),
        } satisfies Omit<MaterialTransaction, "stockBefore" | "stockAfter">);
      }

      await batch.commit();
      res.status(200).json({ orderId, orderNumber, lotCount: lotDocs.length });
    } catch (error) {
      console.error("createOrder error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ----------------------------------------------------------------------------

export const cancelOrder = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 540,
    memory: "256MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, orderId, cancelledBy, reason } = req.body as {
        businessId: string;
        orderId: string;
        cancelledBy: string;
        reason: string;
      };

      const orderRef = db.doc(`users/${businessId}/orders/${orderId}`);
      const orderDoc = await orderRef.get();

      if (!orderDoc.exists) {
        res.status(404).json({ error: "order_not_found" });
        return;
      }

      const order = orderDoc.data() as Order;
      if (order.status === "CANCELLED") {
        res.status(400).json({ error: "order_already_cancelled" });
        return;
      }

      // DRAFT orders have no lots or reservations — just flip the status
      if (order.status === "DRAFT") {
        await orderRef.update({ status: "CANCELLED", updatedAt: Timestamp.now() });
        res.status(200).json({ success: true, lotsCancelled: 0 });
        return;
      }

      const lotsSnap = await db
        .collection(`users/${businessId}/lots`)
        .where("orderId", "==", orderId)
        .get();

      const cancellableLots = lotsSnap.docs.filter((d) => {
        const s = (d.data() as Lot).status;
        return s !== "CANCELLED" && s !== "COMPLETED";
      });

      const now = Timestamp.now();
      const batch = db.batch();

      for (const lotDoc of cancellableLots) {
        const lot = lotDoc.data() as Lot;

        batch.update(lotDoc.ref, { status: "CANCELLED", updatedAt: now });

        const reservationsSnap = await db
          .collection(`users/${businessId}/material_reservations`)
          .where("lotId", "==", lotDoc.id)
          .where("status", "==", "RESERVED")
          .get();

        for (const resDoc of reservationsSnap.docs) {
          const reservation = resDoc.data() as MaterialReservation;

          batch.update(resDoc.ref, { status: "RELEASED", updatedAt: now });

          batch.update(db.doc(`users/${businessId}/raw_materials/${reservation.materialId}`), {
            reservedStock: FieldValue.increment(-reservation.quantityRequired),
            availableStock: FieldValue.increment(reservation.quantityRequired),
            updatedAt: now,
          });

          const txRef = db.collection(`users/${businessId}/material_transactions`).doc();
          batch.set(txRef, {
            id: txRef.id,
            materialId: reservation.materialId,
            materialName: reservation.materialName,
            type: "RETURN" as MaterialTransactionType,
            quantity: reservation.quantityRequired,
            referenceId: orderId,
            referenceType: "LOT",
            note: `Order ${order.orderNumber} cancelled — Lot ${lot.lotNumber} reserved stock released. Reason: ${reason}`,
            createdBy: cancelledBy,
            createdAt: now,
          } satisfies Omit<MaterialTransaction, "stockBefore" | "stockAfter">);
        }
      }

      batch.update(orderRef, {
        status: "CANCELLED",
        lotsInProduction: 0,
        updatedAt: now,
      });

      await batch.commit();
      res.status(200).json({ success: true, lotsCancelled: cancellableLots.length });
    } catch (error) {
      console.error("cancelOrder error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ============================================================================
// SECTION 3 — LOT LIFECYCLE
// advanceLotStage → setLotStageBlocked → cancelLot
// ============================================================================

interface AdvanceLotStagePayload {
  businessId: string;
  lotId: string;
  completedBy: string;
  note?: string;
}

export const advanceLotStage = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 120,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, lotId, completedBy, note } = req.body as AdvanceLotStagePayload;

      const lotRef = db.doc(`users/${businessId}/lots/${lotId}`);

      await db.runTransaction(async (tx) => {
        const lotDoc = await tx.get(lotRef);
        if (!lotDoc.exists) throw new Error("lot_not_found");

        const lot = lotDoc.data() as Lot;
        if (lot.status !== "ACTIVE") throw new Error("lot_not_active");

        const currentIndex = lot.currentSequence - 1;
        const currentStage = lot.stages[currentIndex];
        const nextStage = lot.stages[currentIndex + 1];

        const now = Timestamp.now();

        const updatedStages = lot.stages.map((s, i) => {
          if (i === currentIndex)
            return { ...s, status: "COMPLETED", actualDate: now, completedBy, note: note ?? null };
          if (i === currentIndex + 1) return { ...s, status: "IN_PROGRESS" };
          return s;
        });

        const isLastStage = !nextStage;
        const { isDelayed, delayDays } = computeDelayStatus(updatedStages as LotStage[]);

        tx.update(lotRef, {
          stages: updatedStages,
          currentStage: isLastStage ? lot.currentStage : nextStage.stage,
          currentSequence: isLastStage ? lot.currentSequence : lot.currentSequence + 1,
          status: isLastStage ? "COMPLETED" : "ACTIVE",
          isDelayed,
          delayDays,
          updatedAt: now,
        });

        const historyRef = db.collection(`users/${businessId}/lot_stage_history`).doc();
        tx.set(historyRef, {
          id: historyRef.id,
          lotId,
          lotNumber: lot.lotNumber,
          orderId: lot.orderId,
          fromStage: currentStage.stage,
          toStage: nextStage?.stage ?? currentStage.stage,
          fromSequence: lot.currentSequence,
          toSequence: isLastStage ? lot.currentSequence : lot.currentSequence + 1,
          movedBy: completedBy,
          movedAt: now,
          note: note ?? null,
        } satisfies LotStageHistory);

        const reservationsSnap = await db
          .collection(`users/${businessId}/material_reservations`)
          .where("lotId", "==", lotId)
          .where("consumedAtStage", "==", currentStage.stage)
          .where("status", "==", "RESERVED")
          .get();

        for (const resDoc of reservationsSnap.docs) {
          const reservation = resDoc.data() as MaterialReservation;
          tx.update(resDoc.ref, {
            quantityConsumed: reservation.quantityRequired,
            status: "CONSUMED",
            updatedAt: now,
          });
          tx.update(db.doc(`users/${businessId}/raw_materials/${reservation.materialId}`), {
            reservedStock: FieldValue.increment(-reservation.quantityRequired),
            totalStock: FieldValue.increment(-reservation.quantityRequired),
            updatedAt: now,
          });
          const txRef = db.collection(`users/${businessId}/material_transactions`).doc();
          tx.set(txRef, {
            id: txRef.id,
            materialId: reservation.materialId,
            materialName: reservation.materialName,
            type: "CONSUMPTION" as MaterialTransactionType,
            quantity: reservation.quantityRequired,
            referenceId: lotId,
            referenceType: "LOT",
            note: `Consumed at stage ${currentStage.stage} — Lot ${lot.lotNumber}`,
            createdBy: completedBy,
            createdAt: now,
          } satisfies Omit<MaterialTransaction, "stockBefore" | "stockAfter">);
        }

        if (isLastStage) {
          const fgRef = db.collection(`users/${businessId}/finished_goods`).doc();
          tx.set(fgRef, {
            id: fgRef.id,
            lotId,
            lotNumber: lot.lotNumber,
            orderId: lot.orderId,
            orderNumber: lot.orderNumber,
            buyerId: lot.buyerId,
            buyerName: lot.buyerName,
            productId: lot.productId,
            productName: lot.productName,
            productSku: lot.productSku,
            color: lot.color,
            size: lot.size ?? null,
            quantity: lot.quantity,
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
        }
      });

      res.status(200).json({ success: true });
    } catch (error) {
      const message = (error as Error).message;
      if (message === "lot_not_found") {
        res.status(404).json({ error: "lot_not_found" });
      } else if (message === "lot_not_active") {
        res.status(400).json({ error: "lot_not_active" });
      } else {
        console.error("advanceLotStage error:", error);
        res.status(500).json({ error: "internal", message });
      }
    }
  },
);

// ----------------------------------------------------------------------------

export const setLotStageBlocked = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, lotId, blocked, reason } = req.body as {
        businessId: string;
        lotId: string;
        blocked: boolean;
        reason?: string;
      };

      const lotRef = db.doc(`users/${businessId}/lots/${lotId}`);
      const lotDoc = await lotRef.get();

      if (!lotDoc.exists) {
        res.status(404).json({ error: "lot_not_found" });
        return;
      }

      const lot = lotDoc.data() as Lot;
      const currentIndex = lot.currentSequence - 1;

      const updatedStages = lot.stages.map((s, i) => {
        if (i === currentIndex)
          return {
            ...s,
            status: blocked ? "BLOCKED" : "IN_PROGRESS",
            note: reason ?? s.note,
          };
        return s;
      });

      await lotRef.update({ stages: updatedStages, updatedAt: Timestamp.now() });
      res.status(200).json({ success: true });
    } catch (error) {
      console.error("setLotStageBlocked error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ----------------------------------------------------------------------------

export const cancelLot = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 120,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, lotId, cancelledBy, reason } = req.body as {
        businessId: string;
        lotId: string;
        cancelledBy: string;
        reason: string;
      };

      const lotRef = db.doc(`users/${businessId}/lots/${lotId}`);

      await db.runTransaction(async (tx) => {
        const lotDoc = await tx.get(lotRef);
        if (!lotDoc.exists) throw new Error("lot_not_found");

        const lot = lotDoc.data() as Lot;
        if (lot.status === "CANCELLED") throw new Error("lot_already_cancelled");
        if (lot.status === "COMPLETED") throw new Error("lot_already_completed");

        const now = Timestamp.now();

        tx.update(lotRef, { status: "CANCELLED", updatedAt: now });

        const reservationsSnap = await db
          .collection(`users/${businessId}/material_reservations`)
          .where("lotId", "==", lotId)
          .where("status", "==", "RESERVED")
          .get();

        for (const resDoc of reservationsSnap.docs) {
          const reservation = resDoc.data() as MaterialReservation;

          tx.update(resDoc.ref, { status: "RELEASED", updatedAt: now });

          tx.update(db.doc(`users/${businessId}/raw_materials/${reservation.materialId}`), {
            reservedStock: FieldValue.increment(-reservation.quantityRequired),
            availableStock: FieldValue.increment(reservation.quantityRequired),
            updatedAt: now,
          });

          const txRef = db.collection(`users/${businessId}/material_transactions`).doc();
          tx.set(txRef, {
            id: txRef.id,
            materialId: reservation.materialId,
            materialName: reservation.materialName,
            type: "RETURN" as MaterialTransactionType,
            quantity: reservation.quantityRequired,
            referenceId: lotId,
            referenceType: "LOT",
            note: `Lot ${lot.lotNumber} cancelled — reserved stock released. Reason: ${reason}`,
            createdBy: cancelledBy,
            createdAt: now,
          } satisfies Omit<MaterialTransaction, "stockBefore" | "stockAfter">);
        }
      });

      res.status(200).json({ success: true });
    } catch (error) {
      const message = (error as Error).message;
      if (message === "lot_not_found") {
        res.status(404).json({ error: "lot_not_found" });
      } else if (message === "lot_already_cancelled") {
        res.status(400).json({ error: "lot_already_cancelled" });
      } else if (message === "lot_already_completed") {
        res.status(400).json({ error: "lot_already_completed" });
      } else {
        console.error("cancelLot error:", error);
        res.status(500).json({ error: "internal", message });
      }
    }
  },
);

// ============================================================================
// SECTION 4 — STOCK MANAGEMENT
// addStock → adjustStock
// ============================================================================

interface AddStockPayload {
  businessId: string;
  materialId: string;
  quantity: number;
  referenceId: string;
  note?: string;
  createdBy: string;
}

export const addStock = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, materialId, quantity, referenceId, note, createdBy } =
        req.body as AddStockPayload;

      if (quantity <= 0) {
        res.status(400).json({ error: "quantity_must_be_positive" });
        return;
      }

      const materialRef = db.doc(`users/${businessId}/raw_materials/${materialId}`);

      await db.runTransaction(async (tx) => {
        const matDoc = await tx.get(materialRef);
        if (!matDoc.exists) throw new Error("material_not_found");

        const material = matDoc.data() as RawMaterial;
        const stockBefore = material.totalStock;
        const stockAfter = stockBefore + quantity;
        const now = Timestamp.now();

        tx.update(materialRef, {
          totalStock: FieldValue.increment(quantity),
          availableStock: FieldValue.increment(quantity),
          updatedAt: now,
        });

        const txRef = db.collection(`users/${businessId}/material_transactions`).doc();
        tx.set(txRef, {
          id: txRef.id,
          materialId,
          materialName: material.name,
          type: "PURCHASE" as MaterialTransactionType,
          quantity,
          stockBefore,
          stockAfter,
          referenceId,
          referenceType: "PURCHASE_ORDER",
          note: note ?? null,
          createdBy,
          createdAt: now,
        } satisfies MaterialTransaction);
      });

      res.status(200).json({ success: true });
    } catch (error) {
      const message = (error as Error).message;
      if (message === "material_not_found") {
        res.status(404).json({ error: "material_not_found" });
      } else {
        console.error("addStock error:", error);
        res.status(500).json({ error: "internal", message });
      }
    }
  },
);

// ----------------------------------------------------------------------------

interface AdjustStockPayload {
  businessId: string;
  materialId: string;
  quantity: number;
  note: string;
  createdBy: string;
}

export const adjustStock = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, materialId, quantity, note, createdBy } = req.body as AdjustStockPayload;

      if (quantity === 0) {
        res.status(400).json({ error: "quantity_cannot_be_zero" });
        return;
      }

      const materialRef = db.doc(`users/${businessId}/raw_materials/${materialId}`);

      await db.runTransaction(async (tx) => {
        const matDoc = await tx.get(materialRef);
        if (!matDoc.exists) throw new Error("material_not_found");

        const material = matDoc.data() as RawMaterial;

        const projectedAvailable = material.availableStock + quantity;
        if (projectedAvailable < 0) throw new Error("adjustment_exceeds_available_stock");

        const stockBefore = material.totalStock;
        const stockAfter = stockBefore + quantity;
        const now = Timestamp.now();

        tx.update(materialRef, {
          totalStock: FieldValue.increment(quantity),
          availableStock: FieldValue.increment(quantity),
          updatedAt: now,
        });

        const txRef = db.collection(`users/${businessId}/material_transactions`).doc();
        tx.set(txRef, {
          id: txRef.id,
          materialId,
          materialName: material.name,
          type: "ADJUSTMENT" as MaterialTransactionType,
          quantity,
          stockBefore,
          stockAfter,
          referenceId: null,
          referenceType: "ADJUSTMENT",
          note,
          createdBy,
          createdAt: now,
        } satisfies MaterialTransaction);
      });

      res.status(200).json({ success: true });
    } catch (error) {
      const message = (error as Error).message;
      if (message === "material_not_found") {
        res.status(404).json({ error: "material_not_found" });
      } else if (message === "adjustment_exceeds_available_stock") {
        res.status(400).json({ error: "adjustment_exceeds_available_stock" });
      } else {
        console.error("adjustStock error:", error);
        res.status(500).json({ error: "internal", message });
      }
    }
  },
);

// ============================================================================
// SECTION 5 — DISPATCH
// dispatchFinishedGood
// ============================================================================

export const dispatchFinishedGood = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, finishedGoodId, courierName, awb, cartonCount, totalWeightKg, dispatchedBy } =
        req.body as {
          businessId: string;
          finishedGoodId: string;
          courierName: string;
          awb: string;
          cartonCount?: number;
          totalWeightKg?: number;
          dispatchedBy: string;
        };

      const fgRef = db.doc(`users/${businessId}/finished_goods/${finishedGoodId}`);
      const fgDoc = await fgRef.get();

      if (!fgDoc.exists) {
        res.status(404).json({ error: "finished_good_not_found" });
        return;
      }

      const fg = fgDoc.data() as FinishedGood;

      if (fg.isDispatched) {
        res.status(400).json({
          error: "already_dispatched",
          message: `This lot was already dispatched with AWB ${fg.awb}.`,
        });
        return;
      }

      const now = Timestamp.now();

      await fgRef.update({
        isDispatched: true,
        dispatchedAt: now,
        courierName,
        awb,
        ...(cartonCount !== undefined && { cartonCount }),
        ...(totalWeightKg !== undefined && { totalWeightKg }),
        updatedAt: now,
      });

      res.status(200).json({ success: true });
    } catch (error) {
      console.error("dispatchFinishedGood error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);

// ============================================================================
// SECTION 6 — BACKGROUND (TRIGGERS + SCHEDULED)
// syncOrderStatsOnLotChange → recomputeLotDelays
// ============================================================================

export const syncOrderStatsOnLotChange = onDocumentWritten(
  "{businessId}/lots/{lotId}",
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

    const allCompleted = lotsCompleted === lotsSnap.size;

    await db.doc(`users/${businessId}/orders/${orderId}`).update({
      lotsCompleted,
      lotsInProduction,
      lotsDelayed,
      status: allCompleted ? "COMPLETED" : "IN_PRODUCTION",
      updatedAt: Timestamp.now(),
    });
  },
);

// ----------------------------------------------------------------------------

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

// ============================================================================
// SECTION 7 — READ / QUERY
// getOrderDashboard
// ============================================================================

export const getOrderDashboard = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    try {
      const { businessId, orderId } = req.body as { businessId: string; orderId: string };

      const [orderDoc, lotsSnap] = await Promise.all([
        db.doc(`users/${businessId}/orders/${orderId}`).get(),
        db.collection(`users/${businessId}/lots`).where("orderId", "==", orderId).get(),
      ]);

      if (!orderDoc.exists) {
        res.status(404).json({ error: "order_not_found" });
        return;
      }

      const lots = lotsSnap.docs.map((d) => d.data() as Lot);

      const byStage: Record<string, Lot[]> = {};
      for (const lot of lots) {
        if (!byStage[lot.currentStage]) byStage[lot.currentStage] = [];
        byStage[lot.currentStage].push(lot);
      }

      const tnaSummary = lots.map((lot) => ({
        lotNumber: lot.lotNumber,
        productName: lot.productName,
        color: lot.color,
        quantity: lot.quantity,
        currentStage: lot.currentStage,
        isDelayed: lot.isDelayed,
        delayDays: lot.delayDays,
        stages: lot.stages.map((s) => ({
          stage: s.stage,
          status: s.status,
          plannedDate: s.plannedDate,
          actualDate: s.actualDate,
        })),
      }));

      res.status(200).json({
        order: orderDoc.data(),
        lotsByStage: byStage,
        tnaSummary,
        totalLots: lots.length,
        lotsDelayed: lots.filter((l) => l.isDelayed).length,
      });
    } catch (error) {
      console.error("getOrderDashboard error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  },
);