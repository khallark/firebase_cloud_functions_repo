// Cloud Functions for Warehouse Management System
// Handles stats updates, denormalization propagation, and automatic log creation

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import type {
  Warehouse,
  Zone,
  Rack,
  Shelf,
  Placement,
  PlacementLog,
  ShelfLog,
  RackLog,
  ZoneLog,
  UPC,
} from "../../config/types";
import {
  createMovement,
  createRackLog,
  createShelfLog,
  createUPCsForPlacement,
  createZoneLog,
  getChanges,
  propagateRackLocationChange,
  propagateShelfLocationChange,
  propagateZoneLocationChange,
  transferProductStats,
  transferRackStats,
  transferZoneStats,
  updateLocationStatsInTransaction,
  updateRackCountsInTransaction,
  updateShelfCountsInTransaction,
  updateZoneCountsInTransaction,
} from "./helpers";
import { db } from "../../firebaseAdmin";
import { FieldValue, Timestamp, Transaction } from "firebase-admin/firestore";
import { TASKS_SECRET } from "../../config";

// Helper to extract the loggable snapshot from a UPC
function getUPCSnapshot(upc: UPC) {
  return {
    putAway: upc.putAway,
    warehouseId: upc.warehouseId ?? null,
    zoneId: upc.zoneId ?? null,
    rackId: upc.rackId ?? null,
    shelfId: upc.shelfId ?? null,
    placementId: upc.placementId ?? null,
    storeId: upc.storeId,
    orderId: upc.orderId,
  };
}

const TRACKED_FIELDS = [
  "putAway",
  "warehouseId",
  "zoneId",
  "rackId",
  "shelfId",
  "placementId",
] as const;

function hasTrackedFieldChanged(before: UPC, after: UPC): boolean {
  return TRACKED_FIELDS.some((field) => before[field] !== after[field]);
}

async function writeUPCLog(
  businessId: string,
  upcId: string,
  productId: string,
  grnRef: string | null,
  snapshot: ReturnType<typeof getUPCSnapshot>,
) {
  const batch = db.batch();
  const timestamp = Timestamp.now();

  const logRef = db.collection(`users/${businessId}/upcs/${upcId}/logs`).doc();
  batch.set(logRef, { timestamp, snapshot });

  const flatLogRef = db.collection("users").doc(businessId).collection("upcsLogs").doc(logRef.id);
  batch.set(flatLogRef, { timestamp, upcId, productId, grnRef, snapshot });

  await batch.commit();
}

// ─── Retry helper: wraps a Firestore transaction with outer exponential backoff ───
async function runTransactionWithRetry<T>(
  label: string,
  fn: (tx: Transaction) => Promise<T>,
  outerAttempts = 8,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= outerAttempts; attempt++) {
    try {
      // Inner retry is handled by Firestore itself (maxAttempts: 25)
      return await db.runTransaction(fn, { maxAttempts: 25 });
    } catch (err) {
      lastError = err;
      const jitter = Math.random() * 200;
      const delayMs = Math.min(150 * Math.pow(2, attempt) + jitter, 15_000);
      console.warn(
        `⚠️ [${label}] Transaction outer attempt ${attempt}/${outerAttempts} failed. ` +
        `Retrying in ${Math.round(delayMs)}ms…`,
        err,
      );
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  throw lastError;
}

export const onUpcWritten = onDocumentWritten(
  {
    document: "users/{businessId}/upcs/{upcId}",
    secrets: [TASKS_SECRET],
    memory: "4GiB",
    timeoutSeconds: 540,
    // Cap parallelism — fewer concurrent instances = less contention on hot product docs
    maxInstances: 100,
  },
  async (event) => {
    const before = event.data?.before?.data() as UPC | undefined;
    const after = event.data?.after?.data() as UPC | undefined;
    const { businessId, upcId } = event.params;

    // ============================================================
    // CASE 1: UPC Created
    // ============================================================
    if (!before && after) {
      // Log and inventory update are independent — isolate failures
      try {
        await writeUPCLog(businessId, upcId, after.productId, after.grnRef, getUPCSnapshot(after));
      } catch (err) {
        console.error(`⚠️ [CASE 1] Failed to write creation log for UPC ${upcId}:`, err);
        // Non-fatal — continue to inventory update
      }

      if (after.putAway === "inbound") {
        console.log(`UPC ${upcId} created with 'inbound' putAway - incrementing inventory`);

        await runTransactionWithRetry(`CASE1:${upcId}`, async (transaction) => {
          const productRef = db.doc(`users/${businessId}/products/${after.productId}`);
          const productDoc = await transaction.get(productRef);

          if (!productDoc.exists) {
            console.warn(`⚠️ Product ${after.productId} not found for UPC ${upcId}`);
            return;
          }

          if (after.storeId?.length && after.orderId?.length) {
            transaction.update(productRef, {
              "inventory.autoAddition": FieldValue.increment(1),
            });
          } else {
            transaction.update(productRef, {
              "inventory.inwardAddition": FieldValue.increment(1),
            });
          }
        });
      }

      return;
    }

    // ============================================================
    // CASE 2: UPC Deleted
    // ============================================================
    if (before && !after) {
      if (before.putAway !== "none") {
        console.log(`🗑️ UPC ${upcId} deleted but not in the warehouse:`, before);
        return;
      }

      console.log(`🗑️ UPC ${upcId} deleted - decrementing placement quantity`);

      await runTransactionWithRetry(`CASE2:${upcId}`, async (transaction) => {
        const placementRef = db.doc(`users/${businessId}/placements/${before.placementId}`);
        transaction.update(placementRef, {
          quantity: FieldValue.increment(-1),
        });
      });

      return;
    }

    // ============================================================
    // CASE 3: UPC Updated
    // ============================================================
    if (before && after) {
      // Log independently — don't let it block or fail the inventory update
      if (hasTrackedFieldChanged(before, after)) {
        try {
          await writeUPCLog(
            businessId,
            upcId,
            after.productId,
            after.grnRef,
            getUPCSnapshot(after),
          );
        } catch (err) {
          console.error(`⚠️ [CASE 3] Failed to write update log for UPC ${upcId}:`, err);
          // Non-fatal — continue
        }
      }

      if (before.putAway === after.putAway) {
        console.log(`⏭️ UPC ${upcId} - no putAway change, skipping`);
        return;
      }

      console.log(`📦 UPC ${upcId} putAway changed: ${before.putAway} → ${after.putAway}`);

      await runTransactionWithRetry(`CASE3:${upcId}`, async (transaction) => {
        // --------------------------------------------------------
        // Handle placement quantity changes
        // --------------------------------------------------------
        if (after.putAway === "none" && before.putAway !== "none") {
          const productRef = db.doc(`users/${businessId}/products/${after.productId}`);
          const productSnap = await transaction.get(productRef);

          console.log(`🔍 Product exists: ${productSnap.exists}`);
          console.log(`🔍 Current inShelfQuantity: ${productSnap.data()?.inShelfQuantity}`);
          console.log(`🔍 Product ID: "${after.productId}"`);
          console.log(`🔍 Business ID: "${businessId}"`);

          transaction.update(productRef, {
            inShelfQuantity: FieldValue.increment(1),
          });
          const placementRef = db.doc(`users/${businessId}/placements/${after.placementId}`);
          const placementSnap = await transaction.get(placementRef);

          if (!placementSnap.exists) {
            console.log(
              `🆕 Placement ${after.placementId} doesn't exist — creating it (put-away from 'inbound' → 'none')`,
            );

            const newPlacement: Placement = {
              id: after.placementId,
              productId: after.productId,

              warehouseId: after.warehouseId!,
              zoneId: after.zoneId!,
              rackId: after.rackId!,
              shelfId: after.shelfId,

              quantity: 1,

              createUPCs: false,

              createdAt: Timestamp.now(),
              updatedAt: Timestamp.now(),

              createdBy: after.updatedBy,
              updatedBy: after.updatedBy,

              lastMovementReason: null,
              lastMovementReference: null,
            };

            transaction.set(placementRef, newPlacement);
            console.log(`  ✓ Created placement ${after.placementId}`);
          } else {
            transaction.update(placementRef, {
              quantity: FieldValue.increment(1),
              updatedAt: Timestamp.now(),
              updatedBy: after.updatedBy,
            });
            console.log(`  ✓ Incremented placement quantity for ${after.placementId}`);
          }
        }

        if (after.putAway === "outbound" && before.putAway === "none") {
          const productRef = db.doc(`users/${businessId}/products/${after.productId}`);
          const productSnap = await transaction.get(productRef);

          console.log(`🔍 Product exists: ${productSnap.exists}`);
          console.log(`🔍 Current inShelfQuantity: ${productSnap.data()?.inShelfQuantity}`);
          console.log(`🔍 Product ID: "${after.productId}"`);
          console.log(`🔍 Business ID: "${businessId}"`);

          transaction.update(productRef, {
            inShelfQuantity: FieldValue.increment(-1),
          });
          const placementRef = db.doc(`users/${businessId}/placements/${before.placementId}`);
          transaction.update(placementRef, {
            quantity: FieldValue.increment(-1),
          });
          console.log(`  ✓ Decremented placement quantity for ${before.placementId}`);
        }

        // --------------------------------------------------------
        // Handle inventory auto deduction/addition
        // --------------------------------------------------------
        if (after.putAway === null && before.putAway !== null) {
          if (!after.productId) {
            console.warn(`⚠️ UPC ${upcId} has no productId, skipping autoDeduction`);
            return;
          }

          const productRef = db.doc(`users/${businessId}/products/${after.productId}`);
          const productDoc = await transaction.get(productRef);

          if (!productDoc.exists) {
            console.warn(`⚠️ Product ${after.productId} not found for UPC ${upcId}`);
            return;
          }

          transaction.update(productRef, {
            "inventory.autoDeduction": FieldValue.increment(1),
            "inventory.blockedStock": FieldValue.increment(-1),
          });
          console.log(`  ✅ Incremented autoDeduction for product ${after.productId}`);
        }

        if (after.putAway === "inbound" && before.putAway !== "inbound") {
          if (before.putAway === "outbound" || before.putAway === "none") {
            return;
          }

          if (!after.productId) {
            console.warn(`⚠️ UPC ${upcId} has no productId, skipping autoAddition`);
            return;
          }

          const productRef = db.doc(`users/${businessId}/products/${after.productId}`);
          const productDoc = await transaction.get(productRef);

          if (!productDoc.exists) {
            console.warn(`⚠️ Product ${after.productId} not found for UPC ${upcId}`);
            return;
          }

          transaction.update(productRef, {
            "inventory.autoAddition": FieldValue.increment(1),
          });
          console.log(`  ✅ Incremented autoAddition for product ${after.productId}`);
        }
      });
    }
  },
);

// ============================================================================
// PLACEMENT TRIGGERS → Update Location Stats + Create Logs + Create UPCs
// ============================================================================

export const onPlacementWritten = onDocumentWritten(
  {
    document: "users/{businessId}/placements/{placementId}",
    secrets: [TASKS_SECRET],
    memory: "512MiB", // Heavy due to UPC batch creation
    timeoutSeconds: 120, // 2 minutes for UPC creation
  },
  async (event) => {
    const before = event.data?.before?.data() as Placement | undefined;
    const after = event.data?.after?.data() as Placement | undefined;
    const { businessId, placementId } = event.params;

    // Created → inbound
    if (!before && after) {
      // Stats + Movement + Log in transaction
      await db.runTransaction(async (transaction) => {
        // Update stats
        updateLocationStatsInTransaction(transaction, businessId, after, after.quantity);

        // Create movement (with idempotency check outside transaction)
        const movementId = await createMovement(businessId, "inbound", null, after, after.quantity);

        // Create log
        const logRef = db.collection(`users/${businessId}/placements/${placementId}/logs`).doc();
        const log: PlacementLog = {
          type: "added",
          quantity: after.quantity,
          quantityBefore: null,
          quantityAfter: after.quantity,
          relatedMovementId: movementId,
          note: after.lastMovementReason,
          timestamp: Timestamp.now(),
          userId: after.createdBy,
        };
        Object.keys(log).forEach((key) => {
          if ((log as any)[key] === undefined) delete (log as any)[key];
        });
        transaction.set(logRef, log);
      });

      // Create UPCs if requested (outside transaction due to potential size)
      if (after.createUPCs) {
        await createUPCsForPlacement(businessId, after, after.quantity, after.createdBy);
      }
    }

    // Updated → adjustment only (shelfId can't change with composite ID)
    else if (before && after) {
      const diff = after.quantity - before.quantity;

      // Handle quantity change
      if (diff !== 0) {
        // Stats + Movement + Log in transaction
        await db.runTransaction(async (transaction) => {
          // Update stats
          updateLocationStatsInTransaction(transaction, businessId, after, diff);

          // Create movement (with idempotency check outside transaction)
          const movementId = await createMovement(businessId, "adjustment", before, after, diff);

          // Create log
          const logRef = db.collection(`users/${businessId}/placements/${placementId}/logs`).doc();
          const log: PlacementLog = {
            type: "quantity_adjusted",
            quantity: diff,
            quantityBefore: before.quantity,
            quantityAfter: after.quantity,
            relatedMovementId: movementId,
            note: after.lastMovementReason,
            timestamp: Timestamp.now(),
            userId: after.updatedBy,
          };
          Object.keys(log).forEach((key) => {
            if ((log as any)[key] === undefined) delete (log as any)[key];
          });
          transaction.set(logRef, log);
        });
      }

      // ✅ Create UPCs ONLY if createUPCs flag changed AND diff is positive
      if (before.createUPCs !== after.createUPCs && diff > 0) {
        await createUPCsForPlacement(businessId, after, diff, after.updatedBy);
      }
    }
  },
);

// ============================================================================
// SHELF TRIGGERS → Update Counts + Propagate Changes + Create Logs
// ============================================================================

export const onShelfWritten = onDocumentWritten(
  {
    document: "users/{businessId}/shelves/{shelfId}",
    secrets: [TASKS_SECRET],
    memory: "256MiB", // Medium - queries + transactions
    timeoutSeconds: 60, // 1 minute is sufficient
  },
  async (event) => {
    const before = event.data?.before?.data() as Shelf | undefined;
    const after = event.data?.after?.data() as Shelf | undefined;
    const { businessId, shelfId } = event.params;

    const fieldsToTrack = ["name", "code", "capacity", "position"];

    // Created
    if (!before && after) {
      await db.runTransaction(async (transaction) => {
        updateShelfCountsInTransaction(
          transaction,
          businessId,
          after.rackId,
          after.zoneId,
          after.warehouseId,
          1,
        );

        const logRef = db.collection(`users/${businessId}/shelves/${shelfId}/logs`).doc();
        const log: ShelfLog = {
          type: "created",
          changes: null,
          fromRack: null,
          toRack: null,
          timestamp: Timestamp.now(),
          userId: after.createdBy,
        };
        Object.keys(log).forEach((key) => {
          if ((log as any)[key] === undefined) delete (log as any)[key];
        });
        transaction.set(logRef, log);
      });
    }

    // Hard deleted
    else if (before && !after) {
      if (!before.isDeleted) {
        // Cannot use transaction here as we can't write to deleted subcollection
        await db.runTransaction(async (transaction) => {
          updateShelfCountsInTransaction(
            transaction,
            businessId,
            before.rackId,
            before.zoneId,
            before.warehouseId,
            -1,
          );
        });
      }
    }

    // Updated
    else if (before && after) {
      // Soft delete: active → deleted
      if (!before.isDeleted && after.isDeleted) {
        const placements = await db
          .collection(`users/${businessId}/placements`)
          .where("shelfId", "==", shelfId)
          .limit(1)
          .get();

        if (!placements.empty) {
          console.warn(
            `Shelf ${shelfId} soft deleted with products on it. ` +
            `This should be blocked at API level.`,
          );
        }

        await db.runTransaction(async (transaction) => {
          updateShelfCountsInTransaction(
            transaction,
            businessId,
            after.rackId,
            after.zoneId,
            after.warehouseId,
            -1,
          );

          const logRef = db.collection(`users/${businessId}/shelves/${shelfId}/logs`).doc();
          const log: ShelfLog = {
            type: "deleted",
            changes: null,
            fromRack: null,
            toRack: null,
            timestamp: Timestamp.now(),
            userId: after.updatedBy,
          };
          Object.keys(log).forEach((key) => {
            if ((log as any)[key] === undefined) delete (log as any)[key];
          });
          transaction.set(logRef, log);
        });
      }

      // Restore: deleted → active
      else if (before.isDeleted && !after.isDeleted) {
        await db.runTransaction(async (transaction) => {
          updateShelfCountsInTransaction(
            transaction,
            businessId,
            after.rackId,
            after.zoneId,
            after.warehouseId,
            1,
          );

          const logRef = db.collection(`users/${businessId}/shelves/${shelfId}/logs`).doc();
          const log: ShelfLog = {
            type: "restored",
            changes: null,
            fromRack: null,
            toRack: null,
            timestamp: Timestamp.now(),
            userId: after.updatedBy,
          };
          Object.keys(log).forEach((key) => {
            if ((log as any)[key] === undefined) delete (log as any)[key];
          });
          transaction.set(logRef, log);
        });
      }

      // Moved to different rack
      else if (before.rackId !== after.rackId && !after.isDeleted) {
        // Increment locationVersion
        await db.doc(`users/${businessId}/shelves/${shelfId}`).update({
          locationVersion: FieldValue.increment(1),
        });

        // Stats update in transaction
        await db.runTransaction(async (transaction) => {
          updateShelfCountsInTransaction(
            transaction,
            businessId,
            before.rackId,
            before.zoneId,
            before.warehouseId,
            -1,
          );
          updateShelfCountsInTransaction(
            transaction,
            businessId,
            after.rackId,
            after.zoneId,
            after.warehouseId,
            1,
          );

          const logRef = db.collection(`users/${businessId}/shelves/${shelfId}/logs`).doc();
          const log: ShelfLog = {
            type: "moved",
            changes: null,
            fromRack: { id: before.rackId, zoneId: before.zoneId },
            toRack: { id: after.rackId, zoneId: after.zoneId },
            timestamp: Timestamp.now(),
            userId: after.updatedBy,
          };
          Object.keys(log).forEach((key) => {
            if ((log as any)[key] === undefined) delete (log as any)[key];
          });
          transaction.set(logRef, log);
        });

        // Product stats transfer (also in transaction)
        await transferProductStats(
          businessId,
          shelfId,
          before.rackId,
          before.zoneId,
          before.warehouseId,
          after.rackId,
          after.zoneId,
          after.warehouseId,
        );

        // Propagate location changes (batched - not in transaction)
        await propagateShelfLocationChange(businessId, shelfId, {
          ...after,
          locationVersion: (after.locationVersion || 0) + 1,
        });
      }

      // Other field changes (name, code, capacity, position)
      else if (!after.isDeleted) {
        const changes = getChanges(before, after, fieldsToTrack);
        if (changes) {
          await createShelfLog(
            businessId,
            shelfId,
            "updated",
            after.updatedBy,
            changes,
            null,
            null,
          );
        }
      }

      // Name changed - propagate to placements (batched - not in transaction)
      if (before.name !== after.name) {
        // Increment nameVersion
        await db.doc(`users/${businessId}/shelves/${shelfId}`).update({
          nameVersion: FieldValue.increment(1),
        });
      }
    }
  },
);

// ============================================================================
// RACK TRIGGERS → Update Counts + Propagate Changes + Create Logs
// ============================================================================

export const onRackWritten = onDocumentWritten(
  {
    document: "users/{businessId}/racks/{rackId}",
    secrets: [TASKS_SECRET],
    memory: "512MiB", // Medium-Heavy - multiple queries
    timeoutSeconds: 90, // 1.5 minutes
  },
  async (event) => {
    const before = event.data?.before?.data() as Rack | undefined;
    const after = event.data?.after?.data() as Rack | undefined;
    const { businessId, rackId } = event.params;

    const fieldsToTrack = ["name", "code", "position"];

    // Created
    if (!before && after) {
      await db.runTransaction(async (transaction) => {
        updateRackCountsInTransaction(transaction, businessId, after.zoneId, after.warehouseId, 1);

        const logRef = db.collection(`users/${businessId}/racks/${rackId}/logs`).doc();
        const log: RackLog = {
          type: "created",
          changes: null,
          fromZone: null,
          toZone: null,
          timestamp: Timestamp.now(),
          userId: after.createdBy,
        };
        Object.keys(log).forEach((key) => {
          if ((log as any)[key] === undefined) delete (log as any)[key];
        });
        transaction.set(logRef, log);
      });
    }

    // Hard deleted
    else if (before && !after) {
      if (!before.isDeleted) {
        await db.runTransaction(async (transaction) => {
          updateRackCountsInTransaction(
            transaction,
            businessId,
            before.zoneId,
            before.warehouseId,
            -1,
          );
        });
      }
    }

    // Updated
    else if (before && after) {
      // Soft delete: active → deleted
      if (!before.isDeleted && after.isDeleted) {
        const shelves = await db
          .collection(`users/${businessId}/shelves`)
          .where("rackId", "==", rackId)
          .where("isDeleted", "==", false)
          .limit(1)
          .get();

        if (!shelves.empty) {
          console.warn(
            `Rack ${rackId} soft deleted with shelves on it. ` +
            `This should be blocked at API level.`,
          );
        }

        await db.runTransaction(async (transaction) => {
          updateRackCountsInTransaction(
            transaction,
            businessId,
            after.zoneId,
            after.warehouseId,
            -1,
          );

          const logRef = db.collection(`users/${businessId}/racks/${rackId}/logs`).doc();
          const log: RackLog = {
            type: "deleted",
            changes: null,
            fromZone: null,
            toZone: null,
            timestamp: Timestamp.now(),
            userId: after.updatedBy,
          };
          Object.keys(log).forEach((key) => {
            if ((log as any)[key] === undefined) delete (log as any)[key];
          });
          transaction.set(logRef, log);
        });
      }

      // Restore: deleted → active
      else if (before.isDeleted && !after.isDeleted) {
        await db.runTransaction(async (transaction) => {
          updateRackCountsInTransaction(
            transaction,
            businessId,
            after.zoneId,
            after.warehouseId,
            1,
          );

          const logRef = db.collection(`users/${businessId}/racks/${rackId}/logs`).doc();
          const log: RackLog = {
            type: "restored",
            changes: null,
            fromZone: null,
            toZone: null,
            timestamp: Timestamp.now(),
            userId: after.updatedBy,
          };
          Object.keys(log).forEach((key) => {
            if ((log as any)[key] === undefined) delete (log as any)[key];
          });
          transaction.set(logRef, log);
        });
      }

      // Moved to different zone
      else if (before.zoneId !== after.zoneId && !after.isDeleted) {
        // Increment locationVersion
        await db.doc(`users/${businessId}/racks/${rackId}`).update({
          locationVersion: FieldValue.increment(1),
        });

        // Stats update in transaction
        await db.runTransaction(async (transaction) => {
          updateRackCountsInTransaction(
            transaction,
            businessId,
            before.zoneId,
            before.warehouseId,
            -1,
          );
          updateRackCountsInTransaction(
            transaction,
            businessId,
            after.zoneId,
            after.warehouseId,
            1,
          );

          const logRef = db.collection(`users/${businessId}/racks/${rackId}/logs`).doc();
          const log: RackLog = {
            type: "moved",
            changes: null,
            fromZone: { id: before.zoneId },
            toZone: { id: after.zoneId },
            timestamp: Timestamp.now(),
            userId: after.updatedBy,
          };
          Object.keys(log).forEach((key) => {
            if ((log as any)[key] === undefined) delete (log as any)[key];
          });
          transaction.set(logRef, log);
        });

        // Transfer stats (also in transaction)
        await transferRackStats(
          businessId,
          rackId,
          before.zoneId,
          before.warehouseId,
          after.zoneId,
          after.warehouseId,
        );

        // Propagate location changes (batched - not in transaction)
        await propagateRackLocationChange(businessId, rackId, {
          ...after,
          locationVersion: (after.locationVersion || 0) + 1,
        });
      }

      // Other field changes (name, code, position)
      else if (!after.isDeleted) {
        const changes = getChanges(before, after, fieldsToTrack);
        if (changes) {
          await createRackLog(businessId, rackId, "updated", after.updatedBy, changes, null, null);
        }
      }

      // Name changed - propagate to shelves and placements (batched - not in transaction)
      if (before.name !== after.name) {
        // Increment nameVersion
        await db.doc(`users/${businessId}/racks/${rackId}`).update({
          nameVersion: FieldValue.increment(1),
        });
      }
    }
  },
);

// ============================================================================
// ZONE TRIGGERS → Update Counts + Propagate Changes + Create Logs
// ============================================================================

export const onZoneWritten = onDocumentWritten(
  {
    document: "users/{businessId}/zones/{zoneId}",
    secrets: [TASKS_SECRET],
    memory: "512MiB", // Medium-Heavy - 3 collection queries
    timeoutSeconds: 120, // 2 minutes (most complex)
  },
  async (event) => {
    const before = event.data?.before?.data() as Zone | undefined;
    const after = event.data?.after?.data() as Zone | undefined;
    const { businessId, zoneId } = event.params;

    const fieldsToTrack = ["name", "code", "description"];

    // Created
    if (!before && after) {
      await db.runTransaction(async (transaction) => {
        updateZoneCountsInTransaction(transaction, businessId, after.warehouseId, 1);

        const logRef = db.collection(`users/${businessId}/zones/${zoneId}/logs`).doc();
        const log: ZoneLog = {
          type: "created",
          changes: null,
          note: null,
          timestamp: Timestamp.now(),
          userId: after.createdBy,
        };
        Object.keys(log).forEach((key) => {
          if ((log as any)[key] === undefined) delete (log as any)[key];
        });
        transaction.set(logRef, log);
      });
    }

    // Hard deleted
    else if (before && !after) {
      if (!before.isDeleted) {
        await db.runTransaction(async (transaction) => {
          updateZoneCountsInTransaction(transaction, businessId, before.warehouseId, -1);
        });
      }
    }

    // Updated
    else if (before && after) {
      // Soft delete: active → deleted
      if (!before.isDeleted && after.isDeleted) {
        const racks = await db
          .collection(`users/${businessId}/racks`)
          .where("zoneId", "==", zoneId)
          .where("isDeleted", "==", false)
          .limit(1)
          .get();

        if (!racks.empty) {
          console.warn(
            `Zone ${zoneId} soft deleted with racks in it. ` +
            `This should be blocked at API level.`,
          );
        }

        await db.runTransaction(async (transaction) => {
          updateZoneCountsInTransaction(transaction, businessId, after.warehouseId, -1);

          const logRef = db.collection(`users/${businessId}/zones/${zoneId}/logs`).doc();
          const log: ZoneLog = {
            type: "deleted",
            changes: null,
            note: null,
            timestamp: Timestamp.now(),
            userId: after.updatedBy,
          };
          Object.keys(log).forEach((key) => {
            if ((log as any)[key] === undefined) delete (log as any)[key];
          });
          transaction.set(logRef, log);
        });
      }

      // Restore: deleted → active
      else if (before.isDeleted && !after.isDeleted) {
        await db.runTransaction(async (transaction) => {
          updateZoneCountsInTransaction(transaction, businessId, after.warehouseId, 1);

          const logRef = db.collection(`users/${businessId}/zones/${zoneId}/logs`).doc();
          const log: ZoneLog = {
            type: "restored",
            changes: null,
            note: null,
            timestamp: Timestamp.now(),
            userId: after.updatedBy,
          };
          Object.keys(log).forEach((key) => {
            if ((log as any)[key] === undefined) delete (log as any)[key];
          });
          transaction.set(logRef, log);
        });
      }

      // Moved to different warehouse
      else if (before.warehouseId !== after.warehouseId && !after.isDeleted) {
        // Increment locationVersion
        await db.doc(`users/${businessId}/zones/${zoneId}`).update({
          locationVersion: FieldValue.increment(1),
        });

        // Stats update in transaction
        await db.runTransaction(async (transaction) => {
          updateZoneCountsInTransaction(transaction, businessId, before.warehouseId, -1);
          updateZoneCountsInTransaction(transaction, businessId, after.warehouseId, 1);

          // Log warehouse change as an 'updated' with changes
          const logRef = db.collection(`users/${businessId}/zones/${zoneId}/logs`).doc();
          const log: ZoneLog = {
            type: "updated",
            changes: {
              warehouseId: { from: before.warehouseId, to: after.warehouseId },
            },
            note: null,
            timestamp: Timestamp.now(),
            userId: after.updatedBy,
          };
          Object.keys(log).forEach((key) => {
            if ((log as any)[key] === undefined) delete (log as any)[key];
          });
          transaction.set(logRef, log);
        });

        // Transfer stats (also in transaction)
        await transferZoneStats(businessId, zoneId, before.warehouseId, after.warehouseId);

        // Propagate location changes (batched - not in transaction)
        await propagateZoneLocationChange(businessId, zoneId, {
          ...after,
          locationVersion: (after.locationVersion || 0) + 1,
        });
      }

      // Other field changes (name, code, description)
      else if (!after.isDeleted) {
        const changes = getChanges(before, after, fieldsToTrack);
        if (changes) {
          await createZoneLog(businessId, zoneId, "updated", after.updatedBy, changes, null);
        }
      }

      // Name changed - propagate to racks, shelves, and placements (batched - not in transaction)
      if (before.name !== after.name) {
        // Increment nameVersion
        await db.doc(`users/${businessId}/zones/${zoneId}`).update({
          nameVersion: FieldValue.increment(1),
        });
      }
    }
  },
);

// ============================================================================
// WAREHOUSE TRIGGERS → Propagate Name Changes
// ============================================================================

export const onWarehouseWritten = onDocumentWritten(
  {
    document: "users/{businessId}/warehouses/{warehouseId}",
    secrets: [TASKS_SECRET],
    memory: "256MiB", // Light - minimal operations
    timeoutSeconds: 30, // 30 seconds
  },
  async (event) => {
    const before = event.data?.before?.data() as Warehouse | undefined;
    const after = event.data?.after?.data() as Warehouse | undefined;
    const { businessId, warehouseId } = event.params;

    // Updated
    if (before && after) {
      // Soft delete: active → deleted
      if (!before.isDeleted && after.isDeleted) {
        const zones = await db
          .collection(`users/${businessId}/zones`)
          .where("warehouseId", "==", warehouseId)
          .where("isDeleted", "==", false)
          .limit(1)
          .get();

        if (!zones.empty) {
          console.warn(
            `Warehouse ${warehouseId} soft deleted with zones in it. ` +
            `This should be blocked at API level.`,
          );
        }
      }

      // Name changed - propagate to all children
      if (before.name !== after.name) {
        // Increment nameVersion
        await db.doc(`users/${businessId}/warehouses/${warehouseId}`).update({
          nameVersion: FieldValue.increment(1),
        });
      }
    }
  },
);
