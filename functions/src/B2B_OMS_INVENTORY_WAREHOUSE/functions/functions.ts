/*
 * =============================================================================
 * B2B OMS — BACKGROUND TRIGGERS + SCHEDULED FUNCTION
 * =============================================================================
 *
 * All HTTP handlers live as Next.js API routes under /api/business/b2b/.
 * This file contains only onDocumentWritten triggers and the scheduled job.
 *
 * REMOVED in v2:
 *   - syncMaterialStockOnReservationChange — raw material reservations no
 *     longer exist.  Stock (totalStock / availableStock) is updated directly
 *     by add-stock and adjust-stock API routes only.
 *
 * Remaining triggers (all fire on users/{businessId}/lots/{lotId}):
 *   syncOrderStatsOnLotChange          → re-aggregates order stats
 *   appendLotStageHistoryOnStageAdvance → writes LotStageHistory
 *   createFinishedGoodOnLotCompleted    → creates finished_goods doc
 *
 * Scheduled:
 *   recomputeLotDelays                  → daily 9 AM IST
 * =============================================================================
 */

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { QueryDocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebaseAdmin";
import { FinishedGood, Lot, LotStage, LotStageHistory } from "../types";

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
// TRIGGER 1 — syncOrderStatsOnLotChange
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

// ============================================================================
// TRIGGER 2 — appendLotStageHistoryOnStageAdvance
// ============================================================================

export const appendLotStageHistoryOnStageAdvance = onDocumentWritten(
  "users/{businessId}/lots/{lotId}",
  async (event) => {
    const businessId = event.params.businessId;
    const lotId = event.params.lotId;

    const before = event.data?.before?.data() as Lot | undefined;
    const after = event.data?.after?.data() as Lot | undefined;

    if (!before || !after) return;

    const sequenceAdvanced = after.currentSequence !== before.currentSequence;
    const lastStageCompleted = before.status !== "COMPLETED" && after.status === "COMPLETED";

    if (!sequenceAdvanced && !lastStageCompleted) return;

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

// ============================================================================
// TRIGGER 3 — createFinishedGoodOnLotCompleted
// ============================================================================

export const createFinishedGoodOnLotCompleted = onDocumentWritten(
  "users/{businessId}/lots/{lotId}",
  async (event) => {
    const businessId = event.params.businessId;
    const lotId = event.params.lotId;

    const before = event.data?.before?.data() as Lot | undefined;
    const after = event.data?.after?.data() as Lot | undefined;

    if (!after || after.status !== "COMPLETED") return;
    if (before?.status === "COMPLETED") return;

    // Duplicate guard (handle trigger retries)
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

// ============================================================================
// SCHEDULED — recomputeLotDelays  (daily 9 AM IST)
// ============================================================================

export const recomputeLotDelays = onSchedule(
  { schedule: "0 3 * * *", timeZone: "Asia/Kolkata" },
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