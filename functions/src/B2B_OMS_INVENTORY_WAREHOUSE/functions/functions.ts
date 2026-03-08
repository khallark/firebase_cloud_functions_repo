import { onRequest } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebaseAdmin";
import {
  Lot, LotStage, Order, MaterialReservation,
  RawMaterial, FinishedGood, LotStageHistory,
  BOMEntry, StageName, MaterialTransaction, MaterialTransactionType,
} from "../types";
import { requireHeaderSecret } from "../../helpers";
import { ENQUEUE_FUNCTION_SECRET } from "../../config";

// ============================================================================
// HELPERS
// ============================================================================

async function generateLotNumber(businessId: string): Promise<string> {
  const counterRef = db.doc(`${businessId}/counters/lots`);
  const result = await db.runTransaction(async (tx) => {
    const doc = await tx.get(counterRef);
    const current = doc.exists ? (doc.data()!.count as number) : 800;
    tx.set(counterRef, { count: current + 1 }, { merge: true });
    return current + 1;
  });
  return String(result);
}

async function generateOrderNumber(businessId: string): Promise<string> {
  const counterRef = db.doc(`${businessId}/counters/orders`);
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

// ============================================================================
// ORDER LIFECYCLE
// createOrder → cancelOrder
// ============================================================================

interface CreateOrderPayload {
  businessId: string;
  buyerId: string;
  buyerName: string;
  buyerContact: string;
  shipDate: string;               // ISO string
  deliveryAddress: string;
  note?: string;
  createdBy: string;
  lots: Array<{
    productId: string;
    productName: string;
    productSku: string;
    color: string;
    size?: string;
    quantity: number;
    stages: Array<{
      stage: StageName;
      plannedDate: string;        // ISO string
      isOutsourced: boolean;
      outsourceVendorName?: string;
    }>;
  }>;
}

export const createOrder = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 540,  // sequential BOM fetches + stock checks per lot + batch write
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
        businessId, buyerId, buyerName, buyerContact,
        shipDate, deliveryAddress, note, createdBy, lots,
      } = req.body as CreateOrderPayload;

      const orderNumber = await generateOrderNumber(businessId);
      const orderId = db.collection(`${businessId}/orders`).doc().id;
      const shipTimestamp = Timestamp.fromDate(new Date(shipDate));

      // --- Build lot docs + reservation docs in memory first ---

      const lotDocs: Lot[] = [];
      const reservationDocs: MaterialReservation[] = [];

      for (const lotInput of lots) {
        const lotNumber = await generateLotNumber(businessId);
        const lotId = db.collection(`${businessId}/lots`).doc().id;

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

        const lot: Lot = {
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
          shipDate: shipTimestamp,
          isDelayed: false,
          delayDays: 0,
          status: "ACTIVE",
          createdBy,
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now(),
        };

        lotDocs.push(lot);

        // --- Fetch BOM for this product and build reservations ---
        const bomSnap = await db.collection(`${businessId}/bom`)
          .where("productId", "==", lotInput.productId)
          .where("isActive", "==", true)
          .get();

        for (const bomDoc of bomSnap.docs) {
          const bom = bomDoc.data() as BOMEntry;
          const reservationId = db.collection(`${businessId}/material_reservations`).doc().id;
          const qtyRequired = lotInput.quantity * bom.quantityPerPiece * (1 + bom.wastagePercent / 100);

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

      // --- Check material availability before committing ---
      const materialTotals: Record<string, number> = {};
      for (const r of reservationDocs) {
        materialTotals[r.materialId] = (materialTotals[r.materialId] ?? 0) + r.quantityRequired;
      }

      const shortfalls: string[] = [];
      for (const [materialId, required] of Object.entries(materialTotals)) {
        const matDoc = await db.doc(`${businessId}/raw_materials/${materialId}`).get();
        if (!matDoc.exists) { shortfalls.push(materialId); continue; }
        const mat = matDoc.data() as RawMaterial;
        if (mat.availableStock < required) {
          shortfalls.push(`${mat.name} (need ${required} ${mat.unit}, have ${mat.availableStock})`);
        }
      }

      if (shortfalls.length > 0) {
        res.status(400).json({
          error: "insufficient_stock",
          message: `Insufficient raw material stock: ${shortfalls.join(", ")}`,
        });
        return;
      }

      // --- Commit everything in a batch ---
      const batch = db.batch();

      const orderRef = db.doc(`${businessId}/orders/${orderId}`);
      batch.set(orderRef, {
        id: orderId,
        orderNumber,
        buyerId,
        buyerName,
        buyerContact,
        shipDate: shipTimestamp,
        deliveryAddress,
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
        batch.set(db.doc(`${businessId}/lots/${lot.id}`), lot);
      }

      for (const reservation of reservationDocs) {
        batch.set(db.doc(`${businessId}/material_reservations/${reservation.id}`), reservation);
        batch.update(db.doc(`${businessId}/raw_materials/${reservation.materialId}`), {
          reservedStock: FieldValue.increment(reservation.quantityRequired),
          availableStock: FieldValue.increment(-reservation.quantityRequired),
          updatedAt: Timestamp.now(),
        });
      }

      await batch.commit();
      res.status(200).json({ orderId, orderNumber, lotCount: lotDocs.length });

    } catch (error) {
      console.error("createOrder error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  }
);

// ----------------------------------------------------------------------------

export const cancelOrder = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 540,  // multiple lots, each with multiple reservations
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

      const orderRef = db.doc(`${businessId}/orders/${orderId}`);
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

      // Fetch all cancellable lots (skip already cancelled/completed)
      const lotsSnap = await db.collection(`${businessId}/lots`)
        .where("orderId", "==", orderId)
        .get();

      const cancellableLots = lotsSnap.docs.filter(d => {
        const s = (d.data() as Lot).status;
        return s !== "CANCELLED" && s !== "COMPLETED";
      });

      const now = Timestamp.now();
      const batch = db.batch();

      for (const lotDoc of cancellableLots) {
        const lot = lotDoc.data() as Lot;

        batch.update(lotDoc.ref, {
          status: "CANCELLED",
          updatedAt: now,
        });

        const reservationsSnap = await db.collection(`${businessId}/material_reservations`)
          .where("lotId", "==", lotDoc.id)
          .where("status", "==", "RESERVED")
          .get();

        for (const resDoc of reservationsSnap.docs) {
          const reservation = resDoc.data() as MaterialReservation;

          batch.update(resDoc.ref, {
            status: "RELEASED",
            updatedAt: now,
          });

          batch.update(db.doc(`${businessId}/raw_materials/${reservation.materialId}`), {
            reservedStock: FieldValue.increment(-reservation.quantityRequired),
            availableStock: FieldValue.increment(reservation.quantityRequired),
            updatedAt: now,
          });

          const txRef = db.collection(`${businessId}/material_transactions`).doc();
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
  }
);

// ============================================================================
// LOT LIFECYCLE
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
    timeoutSeconds: 120,  // transaction + reservation reads inside
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

      const lotRef = db.doc(`${businessId}/lots/${lotId}`);

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
          if (i === currentIndex) return { ...s, status: "COMPLETED", actualDate: now, completedBy, note: note ?? null };
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

        const historyRef = db.collection(`${businessId}/lot_stage_history`).doc();
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

        const reservationsSnap = await db.collection(`${businessId}/material_reservations`)
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
          tx.update(db.doc(`${businessId}/raw_materials/${reservation.materialId}`), {
            reservedStock: FieldValue.increment(-reservation.quantityRequired),
            totalStock: FieldValue.increment(-reservation.quantityRequired),
            updatedAt: now,
          });
        }

        if (isLastStage) {
          const fgRef = db.collection(`${businessId}/finished_goods`).doc();
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
  }
);

// ----------------------------------------------------------------------------

export const setLotStageBlocked = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,   // single read + single update
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
        businessId: string; lotId: string; blocked: boolean; reason?: string;
      };

      const lotRef = db.doc(`${businessId}/lots/${lotId}`);
      const lotDoc = await lotRef.get();

      if (!lotDoc.exists) {
        res.status(404).json({ error: "lot_not_found" });
        return;
      }

      const lot = lotDoc.data() as Lot;
      const currentIndex = lot.currentSequence - 1;

      const updatedStages = lot.stages.map((s, i) => {
        if (i === currentIndex) return {
          ...s,
          status: blocked ? "BLOCKED" : "IN_PROGRESS",
          note: reason ?? s.note,
        };
        return s;
      });

      await lotRef.update({
        stages: updatedStages,
        updatedAt: Timestamp.now(),
      });

      res.status(200).json({ success: true });

    } catch (error) {
      console.error("setLotStageBlocked error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  }
);

// ----------------------------------------------------------------------------

export const cancelLot = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 120,  // reservation query + writes per material
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

      const lotRef = db.doc(`${businessId}/lots/${lotId}`);

      await db.runTransaction(async (tx) => {
        const lotDoc = await tx.get(lotRef);
        if (!lotDoc.exists) throw new Error("lot_not_found");

        const lot = lotDoc.data() as Lot;
        if (lot.status === "CANCELLED") throw new Error("lot_already_cancelled");
        if (lot.status === "COMPLETED") throw new Error("lot_already_completed");

        const now = Timestamp.now();

        tx.update(lotRef, {
          status: "CANCELLED",
          updatedAt: now,
        });

        const reservationsSnap = await db.collection(`${businessId}/material_reservations`)
          .where("lotId", "==", lotId)
          .where("status", "==", "RESERVED")
          .get();

        for (const resDoc of reservationsSnap.docs) {
          const reservation = resDoc.data() as MaterialReservation;

          tx.update(resDoc.ref, {
            status: "RELEASED",
            updatedAt: now,
          });

          tx.update(db.doc(`${businessId}/raw_materials/${reservation.materialId}`), {
            reservedStock: FieldValue.increment(-reservation.quantityRequired),
            availableStock: FieldValue.increment(reservation.quantityRequired),
            updatedAt: now,
          });

          const txRef = db.collection(`${businessId}/material_transactions`).doc();
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
  }
);

// ============================================================================
// STOCK MANAGEMENT
// addStock (GRN) → adjustStock
// ============================================================================

interface AddStockPayload {
  businessId: string;
  materialId: string;
  quantity: number;
  referenceId: string;    // PO number, GRN number, supplier invoice, etc.
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

      const materialRef = db.doc(`${businessId}/raw_materials/${materialId}`);

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

        const txRef = db.collection(`${businessId}/material_transactions`).doc();
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
  }
);

// ----------------------------------------------------------------------------

interface AdjustStockPayload {
  businessId: string;
  materialId: string;
  quantity: number;       // positive = add, negative = remove
  note: string;           // required for adjustments — must explain why
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
      const { businessId, materialId, quantity, note, createdBy } =
        req.body as AdjustStockPayload;

      if (quantity === 0) {
        res.status(400).json({ error: "quantity_cannot_be_zero" });
        return;
      }

      const materialRef = db.doc(`${businessId}/raw_materials/${materialId}`);

      await db.runTransaction(async (tx) => {
        const matDoc = await tx.get(materialRef);
        if (!matDoc.exists) throw new Error("material_not_found");

        const material = matDoc.data() as RawMaterial;

        // Guard: adjustment cannot push availableStock below zero
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

        const txRef = db.collection(`${businessId}/material_transactions`).doc();
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
  }
);

// ============================================================================
// BACKGROUND — TRIGGERS + SCHEDULED
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

    const lotsSnap = await db.collection(`${businessId}/lots`)
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

    await db.doc(`${businessId}/orders/${orderId}`).update({
      lotsCompleted,
      lotsInProduction,
      lotsDelayed,
      status: allCompleted ? "COMPLETED" : "IN_PRODUCTION",
      updatedAt: Timestamp.now(),
    });
  }
);

// ----------------------------------------------------------------------------

export const recomputeLotDelays = onSchedule(
  { schedule: "0 3 * * *", timeZone: "Asia/Kolkata" },  // 3 UTC = 9 IST
  async () => {
    const CHUNK = 100;
    const businessSnap = await db.collection("users").get();

    for (const bizDoc of businessSnap.docs) {
      const businessId = bizDoc.id;
      let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | undefined;

      do {
        let query = db.collection(`${businessId}/lots`)
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
  }
);

// ============================================================================
// READ / QUERY
// getOrderDashboard
// ============================================================================

export const getOrderDashboard = onRequest(
  {
    secrets: [ENQUEUE_FUNCTION_SECRET],
    cors: true,
    timeoutSeconds: 60,   // two parallel reads + in-memory grouping
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
        db.doc(`${businessId}/orders/${orderId}`).get(),
        db.collection(`${businessId}/lots`).where("orderId", "==", orderId).get(),
      ]);

      if (!orderDoc.exists) {
        res.status(404).json({ error: "order_not_found" });
        return;
      }

      const lots = lotsSnap.docs.map(d => d.data() as Lot);

      const byStage: Record<string, Lot[]> = {};
      for (const lot of lots) {
        if (!byStage[lot.currentStage]) byStage[lot.currentStage] = [];
        byStage[lot.currentStage].push(lot);
      }

      const tnaSummary = lots.map(lot => ({
        lotNumber: lot.lotNumber,
        productName: lot.productName,
        color: lot.color,
        quantity: lot.quantity,
        currentStage: lot.currentStage,
        isDelayed: lot.isDelayed,
        delayDays: lot.delayDays,
        stages: lot.stages.map(s => ({
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
        lotsDelayed: lots.filter(l => l.isDelayed).length,
      });

    } catch (error) {
      console.error("getOrderDashboard error:", error);
      res.status(500).json({ error: "internal", message: (error as Error).message });
    }
  }
);