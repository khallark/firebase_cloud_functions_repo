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
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { TASKS_SECRET } from "../../config";

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
    memory: "128MiB", // Light - minimal operations
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
