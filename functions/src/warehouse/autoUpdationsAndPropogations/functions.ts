// Cloud Functions for Warehouse Management System
// Handles stats updates and denormalization propagation

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import type { Warehouse, Zone, Rack, Shelf, Placement } from "../../config";
import {
    createMovement,
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
    updateZoneCounts
} from "./helpers";
import { db } from "../../firebaseAdmin";

// ============================================================================
// PLACEMENT TRIGGERS → Update Location Stats
// ============================================================================

export const onPlacementWritten = onDocumentWritten(
    "{businessId}/placements/{placementId}",
    async (event) => {
        const before = event.data?.before?.data() as Placement | undefined;
        const after = event.data?.after?.data() as Placement | undefined;
        const { businessId } = event.params;

        // Created → inbound
        if (!before && after) {
            await updateLocationStats(businessId, after, after.quantity);
            await createMovement(businessId, 'inbound', null, after, after.quantity);
        }

        // Deleted → outbound
        else if (before && !after) {
            await updateLocationStats(businessId, before, -before.quantity);
            await createMovement(businessId, 'outbound', before, null, before.quantity);
        }

        // Updated → adjustment only (shelfId can't change with composite ID)
        else if (before && after) {
            const diff = after.quantity - before.quantity;
            if (diff !== 0) {
                await updateLocationStats(businessId, after, diff);
                await createMovement(businessId, 'adjustment', before, after, diff);
            }
        }
    }
);

// ============================================================================
// SHELF TRIGGERS → Update Rack/Zone Shelf Counts + Propagate Name Changes
// ============================================================================

export const onShelfWritten = onDocumentWritten(
    "{businessId}/shelves/{shelfId}",
    async (event) => {
        const before = event.data?.before?.data() as Shelf | undefined;
        const after = event.data?.after?.data() as Shelf | undefined;
        const { businessId, shelfId } = event.params;

        // Created
        if (!before && after) {
            await updateShelfCounts(businessId, after.rackId, after.zoneId, after.warehouseId, 1);
        }

        // Hard deleted
        else if (before && !after) {
            if (!before.isDeleted) {
                await updateShelfCounts(businessId, before.rackId, before.zoneId, before.warehouseId, -1);
            }
        }

        // Updated
        else if (before && after) {
            // Soft delete: active → deleted
            if (!before.isDeleted && after.isDeleted) {
                // Option A: Warn if shelf has products (blocking should be at API level)
                const placements = await db
                    .collection(`${businessId}/placements`)
                    .where("shelfId", "==", shelfId)
                    .limit(1)
                    .get();

                if (!placements.empty) {
                    console.warn(
                        `Shelf ${shelfId} soft deleted with products on it. ` +
                        `This should be blocked at API level.`
                    );
                }

                await updateShelfCounts(businessId, after.rackId, after.zoneId, after.warehouseId, -1);
            } else if (before.isDeleted && !after.isDeleted) {
                await updateShelfCounts(businessId, after.rackId, after.zoneId, after.warehouseId, 1);
            }

            // Moved to different rack
            else if (before.rackId !== after.rackId && !after.isDeleted) {
                await updateShelfCounts(businessId, before.rackId, before.zoneId, before.warehouseId, -1);
                await updateShelfCounts(businessId, after.rackId, after.zoneId, after.warehouseId, 1);

                // Transfer product stats
                await transferProductStats(
                    businessId,
                    shelfId,
                    before.rackId, before.zoneId, before.warehouseId,
                    after.rackId, after.zoneId, after.warehouseId
                );

                // Update all placements on this shelf
                await propagateShelfLocationChange(businessId, shelfId, after);
            }

            // Name changed - propagate to placements
            if (before.name !== after.name) {
                await propagateShelfNameChange(businessId, shelfId, after);
            }

            // Coordinates changed
            if (
                before.coordinates?.aisle !== after.coordinates?.aisle ||
                before.coordinates?.bay !== after.coordinates?.bay ||
                before.coordinates?.level !== after.coordinates?.level
            ) {
                await propagateShelfCoordinatesChange(businessId, shelfId, after);
            }
        }
    }
);

// ============================================================================
// RACK TRIGGERS → Update Zone Rack Counts + Propagate Name Changes
// ============================================================================

export const onRackWritten = onDocumentWritten(
    "{businessId}/racks/{rackId}",
    async (event) => {
        const before = event.data?.before?.data() as Rack | undefined;
        const after = event.data?.after?.data() as Rack | undefined;
        const { businessId, rackId } = event.params;

        // Created
        if (!before && after) {
            await updateRackCounts(businessId, after.zoneId, after.warehouseId, 1);
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
                // Warn if rack has shelves
                const shelves = await db
                    .collection(`${businessId}/shelves`)
                    .where("rackId", "==", rackId)
                    .where("isDeleted", "==", false)
                    .limit(1)
                    .get();

                if (!shelves.empty) {
                    console.warn(
                        `Rack ${rackId} soft deleted with shelves on it. ` +
                        `This should be blocked at API level.`
                    );
                }

                await updateRackCounts(businessId, after.zoneId, after.warehouseId, -1);
            }

            // Restore: deleted → active
            else if (before.isDeleted && !after.isDeleted) {
                await updateRackCounts(businessId, after.zoneId, after.warehouseId, 1);
            }

            // Moved to different zone
            else if (before.zoneId !== after.zoneId && !after.isDeleted) {
                // Update rack counts
                await updateRackCounts(businessId, before.zoneId, after.warehouseId, -1);
                await updateRackCounts(businessId, after.zoneId, after.warehouseId, 1);

                // Transfer shelf and product stats
                await transferRackStats(
                    businessId,
                    rackId,
                    before.zoneId, before.warehouseId,
                    after.zoneId, after.warehouseId,
                );

                // Propagate location change to shelves and placements
                await propagateRackLocationChange(businessId, rackId, after);
            }

            // Name changed
            if (before.name !== after.name) {
                await propagateRackNameChange(businessId, rackId, after);
            }
        }
    }
);

// ============================================================================
// ZONE TRIGGERS → Propagate Name Changes
// ============================================================================

export const onZoneWritten = onDocumentWritten(
    "{businessId}/zones/{zoneId}",
    async (event) => {
        const before = event.data?.before?.data() as Zone | undefined;
        const after = event.data?.after?.data() as Zone | undefined;
        const { businessId, zoneId } = event.params;

        // Created
        if (!before && after) {
            await updateZoneCounts(businessId, after.warehouseId, 1);
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
                    .collection(`${businessId}/racks`)
                    .where("zoneId", "==", zoneId)
                    .where("isDeleted", "==", false)
                    .limit(1)
                    .get();

                if (!racks.empty) {
                    console.warn(
                        `Zone ${zoneId} soft deleted with racks in it. ` +
                        `This should be blocked at API level.`
                    );
                }

                await updateZoneCounts(businessId, after.warehouseId, -1);
            }

            // Restore: deleted → active
            else if (before.isDeleted && !after.isDeleted) {
                await updateZoneCounts(businessId, after.warehouseId, 1);
            }

            // Moved to different warehouse
            else if (before.warehouseId !== after.warehouseId && !after.isDeleted) {
                await updateZoneCounts(businessId, before.warehouseId, -1);
                await updateZoneCounts(businessId, after.warehouseId, 1);

                // Transfer all stats to new warehouse
                await transferZoneStats(
                    businessId,
                    zoneId,
                    before.warehouseId,
                    after.warehouseId
                );

                // Propagate location change to children
                await propagateZoneLocationChange(businessId, zoneId, after);
            }

            // Name changed
            if (before.name !== after.name) {
                await propagateZoneNameChange(businessId, zoneId, after.name);
            }
        }
    }
);

// ============================================================================
// WAREHOUSE TRIGGERS → Propagate Name Changes
// ============================================================================

export const onWarehouseWritten = onDocumentWritten(
    "{businessId}/warehouses/{warehouseId}",
    async (event) => {
        const before = event.data?.before?.data() as Warehouse | undefined;
        const after = event.data?.after?.data() as Warehouse | undefined;
        const { businessId, warehouseId } = event.params;

        // Updated
        if (before && after) {
            // Soft delete: active → deleted
            if (!before.isDeleted && after.isDeleted) {
                const zones = await db
                    .collection(`${businessId}/zones`)
                    .where("warehouseId", "==", warehouseId)
                    .where("isDeleted", "==", false)
                    .limit(1)
                    .get();

                if (!zones.empty) {
                    console.warn(
                        `Warehouse ${warehouseId} soft deleted with zones in it. ` +
                        `This should be blocked at API level.`
                    );
                }
            }

            // Name changed
            if (before.name !== after.name) {
                await propagateWarehouseNameChange(businessId, warehouseId, after.name);
            }
        }
    }
);
