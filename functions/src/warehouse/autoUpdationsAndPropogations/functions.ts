// Cloud Functions for Warehouse Management System
// Handles stats updates, denormalization propagation, and automatic log creation

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import type { Warehouse, Zone, Rack, Shelf, Placement } from "../../config/types";
import {
  createMovement,
  createPlacementLog,
  createRackLog,
  createShelfLog,
  createZoneLog,
  getChanges,
  propagateRackLocationChange,
  propagateRackNameChange,
  propagateShelfCoordinatesChange,
  propagateShelfLocationChange,
  propagateShelfNameChange,
  propagateWarehouseNameChange,
  propagateZoneLocationChange,
  propagateZoneNameChange,
  transferProductStats,
  transferRackStats,
  transferZoneStats,
  updateLocationStats,
  updateRackCounts,
  updateShelfCounts,
  updateZoneCounts,
} from "./helpers";
import { db } from "../../firebaseAdmin";

// ============================================================================
// PLACEMENT TRIGGERS → Update Location Stats + Create Logs
// ============================================================================

export const onPlacementWritten = onDocumentWritten(
  "users/{businessId}/placements/{placementId}",
  async (event) => {
    const before = event.data?.before?.data() as Placement | undefined;
    const after = event.data?.after?.data() as Placement | undefined;
    const { businessId, placementId } = event.params;

    // Created → inbound
    if (!before && after) {
      await updateLocationStats(businessId, after, after.quantity);
      const movementId = await createMovement(businessId, "inbound", null, after, after.quantity);

      await createPlacementLog(
        businessId,
        placementId,
        "added",
        after.createdBy,
        after.quantity,
        null,
        after.quantity,
        movementId,
        after.lastMovementReason,
      );
    }

    // Deleted → outbound
    else if (before && !after) {
      // await updateLocationStats(businessId, before, -before.quantity);
      // await createMovement(businessId, "outbound", before, null, before.quantity);
      // Note: Cannot create log in deleted document's subcollection
      // The movement record serves as the audit trail for deletions
    }

    // Updated → adjustment only (shelfId can't change with composite ID)
    else if (before && after) {
      const diff = after.quantity - before.quantity;
      if (diff !== 0) {
        await updateLocationStats(businessId, after, diff);
        const movementId = await createMovement(businessId, "adjustment", before, after, diff);

        await createPlacementLog(
          businessId,
          placementId,
          "quantity_adjusted",
          after.updatedBy,
          diff,
          before.quantity,
          after.quantity,
          movementId,
          after.lastMovementReason,
        );
      }
    }
  },
);

// ============================================================================
// SHELF TRIGGERS → Update Counts + Propagate Changes + Create Logs
// ============================================================================

export const onShelfWritten = onDocumentWritten(
  "users/{businessId}/shelves/{shelfId}",
  async (event) => {
    const before = event.data?.before?.data() as Shelf | undefined;
    const after = event.data?.after?.data() as Shelf | undefined;
    const { businessId, shelfId } = event.params;

    const fieldsToTrack = ["name", "code", "capacity", "position", "coordinates"];

    // Created
    if (!before && after) {
      await updateShelfCounts(businessId, after.rackId, after.zoneId, after.warehouseId, 1);
      await createShelfLog(businessId, shelfId, "created", after.createdBy, null, null, null);
    }

    // Hard deleted
    else if (before && !after) {
      if (!before.isDeleted) {
        await updateShelfCounts(businessId, before.rackId, before.zoneId, before.warehouseId, -1);
      }
      // Cannot create log in deleted document's subcollection
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

        await updateShelfCounts(businessId, after.rackId, after.zoneId, after.warehouseId, -1);
        await createShelfLog(businessId, shelfId, "deleted", after.updatedBy, null, null, null);
      }

      // Restore: deleted → active
      else if (before.isDeleted && !after.isDeleted) {
        await updateShelfCounts(businessId, after.rackId, after.zoneId, after.warehouseId, 1);
        await createShelfLog(businessId, shelfId, "restored", after.updatedBy, null, null, null);
      }

      // Moved to different rack
      else if (before.rackId !== after.rackId && !after.isDeleted) {
        await updateShelfCounts(businessId, before.rackId, before.zoneId, before.warehouseId, -1);
        await updateShelfCounts(businessId, after.rackId, after.zoneId, after.warehouseId, 1);

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

        await propagateShelfLocationChange(businessId, shelfId, after);

        await createShelfLog(
          businessId,
          shelfId,
          "moved",
          after.updatedBy,
          null,
          { id: before.rackId, name: before.rackName, zoneId: before.zoneId },
          { id: after.rackId, name: after.rackName, zoneId: after.zoneId },
        );
      }

      // Other field changes (name, code, capacity, position, coordinates)
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

      // Name changed - propagate to placements
      if (before.name !== after.name) {
        await propagateShelfNameChange(businessId, shelfId, after);
      }

      // Coordinates changed - propagate to placements
      if (
        before.coordinates?.aisle !== after.coordinates?.aisle ||
        before.coordinates?.bay !== after.coordinates?.bay ||
        before.coordinates?.level !== after.coordinates?.level
      ) {
        await propagateShelfCoordinatesChange(businessId, shelfId, after);
      }
    }
  },
);

// ============================================================================
// RACK TRIGGERS → Update Counts + Propagate Changes + Create Logs
// ============================================================================

export const onRackWritten = onDocumentWritten(
  "users/{businessId}/racks/{rackId}",
  async (event) => {
    const before = event.data?.before?.data() as Rack | undefined;
    const after = event.data?.after?.data() as Rack | undefined;
    const { businessId, rackId } = event.params;

    const fieldsToTrack = ["name", "code", "position"];

    // Created
    if (!before && after) {
      await updateRackCounts(businessId, after.zoneId, after.warehouseId, 1);
      await createRackLog(businessId, rackId, "created", after.createdBy, null, null, null);
    }

    // Hard deleted
    else if (before && !after) {
      if (!before.isDeleted) {
        await updateRackCounts(businessId, before.zoneId, before.warehouseId, -1);
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

        await updateRackCounts(businessId, after.zoneId, after.warehouseId, -1);
        await createRackLog(businessId, rackId, "deleted", after.updatedBy, null, null, null);
      }

      // Restore: deleted → active
      else if (before.isDeleted && !after.isDeleted) {
        await updateRackCounts(businessId, after.zoneId, after.warehouseId, 1);
        await createRackLog(businessId, rackId, "restored", after.updatedBy, null, null, null);
      }

      // Moved to different zone
      else if (before.zoneId !== after.zoneId && !after.isDeleted) {
        await updateRackCounts(businessId, before.zoneId, before.warehouseId, -1);
        await updateRackCounts(businessId, after.zoneId, after.warehouseId, 1);

        await transferRackStats(
          businessId,
          rackId,
          before.zoneId,
          before.warehouseId,
          after.zoneId,
          after.warehouseId,
        );

        await propagateRackLocationChange(businessId, rackId, after);

        await createRackLog(
          businessId,
          rackId,
          "moved",
          after.updatedBy,
          null,
          { id: before.zoneId, name: before.zoneName },
          { id: after.zoneId, name: after.zoneName },
        );
      }

      // Other field changes (name, code, position)
      else if (!after.isDeleted) {
        const changes = getChanges(before, after, fieldsToTrack);
        if (changes) {
          await createRackLog(businessId, rackId, "updated", after.updatedBy, changes, null, null);
        }
      }

      // Name changed - propagate to shelves and placements
      if (before.name !== after.name) {
        await propagateRackNameChange(businessId, rackId, after);
      }
    }
  },
);

// ============================================================================
// ZONE TRIGGERS → Update Counts + Propagate Changes + Create Logs
// ============================================================================

export const onZoneWritten = onDocumentWritten(
  "users/{businessId}/zones/{zoneId}",
  async (event) => {
    const before = event.data?.before?.data() as Zone | undefined;
    const after = event.data?.after?.data() as Zone | undefined;
    const { businessId, zoneId } = event.params;

    const fieldsToTrack = ["name", "code", "description"];

    // Created
    if (!before && after) {
      await updateZoneCounts(businessId, after.warehouseId, 1);
      await createZoneLog(businessId, zoneId, "created", after.createdBy, null, null);
    }

    // Hard deleted
    else if (before && !after) {
      if (!before.isDeleted) {
        await updateZoneCounts(businessId, before.warehouseId, -1);
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

        await updateZoneCounts(businessId, after.warehouseId, -1);
        await createZoneLog(businessId, zoneId, "deleted", after.updatedBy, null, null);
      }

      // Restore: deleted → active
      else if (before.isDeleted && !after.isDeleted) {
        await updateZoneCounts(businessId, after.warehouseId, 1);
        await createZoneLog(businessId, zoneId, "restored", after.updatedBy, null, null);
      }

      // Moved to different warehouse
      else if (before.warehouseId !== after.warehouseId && !after.isDeleted) {
        await updateZoneCounts(businessId, before.warehouseId, -1);
        await updateZoneCounts(businessId, after.warehouseId, 1);

        await transferZoneStats(businessId, zoneId, before.warehouseId, after.warehouseId);

        await propagateZoneLocationChange(businessId, zoneId, after);

        // Log warehouse change as an 'updated' with changes
        await createZoneLog(
          businessId,
          zoneId,
          "updated",
          after.updatedBy,
          {
            warehouseId: { from: before.warehouseId, to: after.warehouseId },
            warehouseName: { from: before.warehouseName, to: after.warehouseName },
          },
          null,
        );
      }

      // Other field changes (name, code, description)
      else if (!after.isDeleted) {
        const changes = getChanges(before, after, fieldsToTrack);
        if (changes) {
          await createZoneLog(businessId, zoneId, "updated", after.updatedBy, changes, null);
        }
      }

      // Name changed - propagate to racks, shelves, and placements
      if (before.name !== after.name) {
        await propagateZoneNameChange(businessId, zoneId, after.name);
      }
    }
  },
);

// ============================================================================
// WAREHOUSE TRIGGERS → Propagate Name Changes
// ============================================================================

export const onWarehouseWritten = onDocumentWritten(
  "users/{businessId}/warehouses/{warehouseId}",
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
        await propagateWarehouseNameChange(businessId, warehouseId, after.name);
      }
    }
  },
);
