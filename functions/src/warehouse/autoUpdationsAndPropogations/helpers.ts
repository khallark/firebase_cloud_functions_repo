import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { Movement, Placement, Rack, Shelf, Zone } from "../../config";
import { db } from "../../firebaseAdmin";
import { chunkArray } from "../../helpers";

const increment = FieldValue.increment;

export async function batchedUpdate(
    updates: { ref: FirebaseFirestore.DocumentReference; data: Record<string, any> }[]
) {
    const chunks = chunkArray(updates, 500);

    for (const chunk of chunks) {
        const batch = db.batch();
        chunk.forEach(({ ref, data }) => batch.update(ref, data));
        await batch.commit();
    }
}

// ============================================================================
// PLACEMENT TRIGGERS → Update Location Stats
// ============================================================================

export async function createMovement(
    businessId: string,
    type: 'inbound' | 'outbound' | 'transfer' | 'adjustment',
    from: Placement | null,
    to: Placement | null,
    quantity: number
) {
    const ref = db
        .collection("users")
        .doc(businessId)
        .collection("movements")
        .doc();

    const source = to ?? from;

    const movement: Movement = {
        id: ref.id,
        productId: source!.productId,
        productSKU: source!.productSKU,
        type,
        from: from ? {
            shelfId: from.shelfId,
            shelfName: from.shelfName,
            rackId: from.rackId,
            rackName: from.rackName,
            zoneId: from.zoneId,
            zoneName: from.zoneName,
            warehouseId: from.warehouseId,
            warehouseName: from.warehouseName,
            path: from.locationPath
        } : {
            shelfId: null,
            shelfName: null,
            rackId: null,
            rackName: null,
            zoneId: null,
            zoneName: null,
            warehouseId: null,
            warehouseName: null,
            path: null
        },
        to: to ? {
            shelfId: to.shelfId,
            shelfName: to.shelfName,
            rackId: to.rackId,
            rackName: to.rackName,
            zoneId: to.zoneId,
            zoneName: to.zoneName,
            warehouseId: to.warehouseId,
            warehouseName: to.warehouseName,
            path: to.locationPath
        } : {
            shelfId: null,
            shelfName: null,
            rackId: null,
            rackName: null,
            zoneId: null,
            zoneName: null,
            warehouseId: null,
            warehouseName: null,
            path: null
        },
        quantity,
        reason: source!.lastMovementReason ?? '',
        reference: source!.lastMovementReference ?? '',
        timestamp: Timestamp.now(),
        userId: source!.updatedBy ?? 'system',
        userName: ''
    };

    await ref.set(movement);
}

export async function updateLocationStats(
    businessId: string,
    placement: Placement,
    quantityDelta: number
) {
    const batch = db.batch();

    // Update shelf stats
    batch.update(db.doc(`${businessId}/shelves/${placement.shelfId}`), {
        "stats.totalProducts": increment(quantityDelta),
    });

    // Update rack stats
    batch.update(db.doc(`${businessId}/racks/${placement.rackId}`), {
        "stats.totalProducts": increment(quantityDelta),
    });

    // Update zone stats
    batch.update(db.doc(`${businessId}/zones/${placement.zoneId}`), {
        "stats.totalProducts": increment(quantityDelta),
    });

    // Update warehouse stats
    batch.update(db.doc(`${businessId}/warehouses/${placement.warehouseId}`), {
        "stats.totalProducts": increment(quantityDelta),
    });

    await batch.commit();
}

// ============================================================================
// SHELF TRIGGERS → Update Rack/Zone Shelf Counts + Propagate Name Changes
// ============================================================================

export async function updateShelfCounts(
    businessId: string,
    rackId: string,
    zoneId: string,
    warehouseId: string,
    delta: number
) {
    const batch = db.batch();

    batch.update(db.doc(`${businessId}/racks/${rackId}`), {
        "stats.totalShelves": increment(delta),
    });

    batch.update(db.doc(`${businessId}/zones/${zoneId}`), {
        "stats.totalShelves": increment(delta),
    });

    batch.update(db.doc(`${businessId}/warehouses/${warehouseId}`), {
        "stats.totalShelves": increment(delta),
    });

    await batch.commit();
}

export async function transferProductStats(
    businessId: string,
    shelfId: string,
    fromRackId: string,
    fromZoneId: string,
    fromWarehouseId: string,
    toRackId: string,
    toZoneId: string,
    toWarehouseId: string,
) {
    const placements = await db
        .collection(`${businessId}/placements`)
        .where("shelfId", "==", shelfId)
        .get();

    if (placements.empty) return;

    const totalProducts = placements.docs.reduce(
        (sum, doc) => sum + (doc.data().quantity || 0), 0
    );

    const batch = db.batch();

    // Rack stats
    batch.update(db.doc(`${businessId}/racks/${fromRackId}`), {
        "stats.totalProducts": increment(-totalProducts),
    });
    batch.update(db.doc(`${businessId}/racks/${toRackId}`), {
        "stats.totalProducts": increment(totalProducts),
    });

    // Zone stats (only if changed)
    if (fromZoneId !== toZoneId) {
        batch.update(db.doc(`${businessId}/zones/${fromZoneId}`), {
            "stats.totalProducts": increment(-totalProducts),
        });
        batch.update(db.doc(`${businessId}/zones/${toZoneId}`), {
            "stats.totalProducts": increment(totalProducts),
        });
    }

    // Warehouse stats (only if changed)
    if (fromWarehouseId !== toWarehouseId) {
        batch.update(db.doc(`${businessId}/warehouses/${fromWarehouseId}`), {
            "stats.totalProducts": increment(-totalProducts),
        });
        batch.update(db.doc(`${businessId}/warehouses/${toWarehouseId}`), {
            "stats.totalProducts": increment(totalProducts),
        });
    }

    await batch.commit();
}

export async function propagateShelfNameChange(
    businessId: string,
    shelfId: string,
    shelf: Shelf
) {
    const placements = await db
        .collection(`${businessId}/placements`)
        .where("shelfId", "==", shelfId)
        .get();

    if (placements.empty) return;

    const updates = placements.docs.map((doc) => ({
        ref: doc.ref,
        data: {
            shelfName: shelf.name,
            locationPath: shelf.path,
        },
    }));

    await batchedUpdate(updates);
}

export async function propagateShelfLocationChange(
    businessId: string,
    shelfId: string,
    shelf: Shelf
) {
    const placements = await db
        .collection(`${businessId}/placements`)
        .where("shelfId", "==", shelfId)
        .get();

    if (placements.empty) return;

    const updates = placements.docs.map((doc) => ({
        ref: doc.ref,
        data: {
            rackId: shelf.rackId,
            rackName: shelf.rackName,
            zoneId: shelf.zoneId,
            zoneName: shelf.zoneName,
            warehouseId: shelf.warehouseId,
            warehouseName: shelf.warehouseName,
            locationPath: shelf.path,
        },
    }));

    await batchedUpdate(updates);
}

export async function propagateShelfCoordinatesChange(
    businessId: string,
    shelfId: string,
    shelf: Shelf
) {
    const placements = await db
        .collection(`${businessId}/placements`)
        .where("shelfId", "==", shelfId)
        .get();

    if (placements.empty) return;

    const locationCode = shelf.coordinates
        ? `${shelf.coordinates.aisle}-${String(shelf.coordinates.bay).padStart(2, '0')}-${shelf.coordinates.level}`
        : null;

    const updates = placements.docs.map((doc) => ({
        ref: doc.ref,
        data: {
            coordinates: shelf.coordinates ?? null,
            locationCode,
        },
    }));

    await batchedUpdate(updates);
}

// ============================================================================
// RACK TRIGGERS → Update Zone Rack Counts + Propagate Name Changes
// ============================================================================

export async function updateRackCounts(
    businessId: string,
    zoneId: string,
    warehouseId: string,
    delta: number
) {
    const batch = db.batch();

    batch.update(db.doc(`${businessId}/zones/${zoneId}`), {
        "stats.totalRacks": increment(delta),
    });

    batch.update(db.doc(`${businessId}/warehouses/${warehouseId}`), {
        "stats.totalRacks": increment(delta),
    });

    await batch.commit();
}

export async function transferRackStats(
    businessId: string,
    rackId: string,
    fromZoneId: string,
    fromWarehouseId: string,
    toZoneId: string,
    toWarehouseId: string
) {
    // Get shelves in this rack
    const shelves = await db
        .collection(`${businessId}/shelves`)
        .where("rackId", "==", rackId)
        .where("isDeleted", "==", false)
        .get();

    const totalShelves = shelves.size;

    // Get total products across all shelves in this rack
    const placements = await db
        .collection(`${businessId}/placements`)
        .where("rackId", "==", rackId)
        .get();

    const totalProducts = placements.docs.reduce(
        (sum, doc) => sum + (doc.data().quantity || 0), 0
    );

    if (totalShelves === 0 && totalProducts === 0) return;

    const batch = db.batch();

    // Remove from old zone
    if (totalShelves > 0) {
        batch.update(db.doc(`${businessId}/zones/${fromZoneId}`), {
            "stats.totalShelves": increment(-totalShelves),
        });
        batch.update(db.doc(`${businessId}/zones/${toZoneId}`), {
            "stats.totalShelves": increment(totalShelves),
        });
    }

    if (totalProducts > 0) {
        batch.update(db.doc(`${businessId}/zones/${fromZoneId}`), {
            "stats.totalProducts": increment(-totalProducts),
        });
        batch.update(db.doc(`${businessId}/zones/${toZoneId}`), {
            "stats.totalProducts": increment(totalProducts),
        });
    }

    if (fromWarehouseId !== toWarehouseId) {
        batch.update(db.doc(`${businessId}/warehouses/${fromWarehouseId}`), {
            "stats.totalShelves": increment(-totalShelves),
            "stats.totalProducts": increment(-totalProducts),
        });
        batch.update(db.doc(`${businessId}/warehouses/${toWarehouseId}`), {
            "stats.totalShelves": increment(totalShelves),
            "stats.totalProducts": increment(totalProducts),
        });
    }

    await batch.commit();
}

export async function propagateRackLocationChange(
    businessId: string,
    rackId: string,
    rack: Rack
) {
    // Update shelves
    const shelves = await db
        .collection(`${businessId}/shelves`)
        .where("rackId", "==", rackId)
        .get();

    const shelfUpdates = shelves.docs.map((doc) => {
        const shelf = doc.data() as Shelf;
        return {
            ref: doc.ref,
            data: {
                zoneId: rack.zoneId,
                zoneName: rack.zoneName,
                warehouseId: rack.warehouseId,
                warehouseName: rack.warehouseName,
                path: `${rack.zoneName} > ${rack.name} > ${shelf.name}`,
            },
        };
    });

    // Update placements
    const placements = await db
        .collection(`${businessId}/placements`)
        .where("rackId", "==", rackId)
        .get();

    const placementUpdates = placements.docs.map((doc) => {
        const placement = doc.data() as Placement;
        return {
            ref: doc.ref,
            data: {
                zoneId: rack.zoneId,
                zoneName: rack.zoneName,
                warehouseId: rack.warehouseId,
                warehouseName: rack.warehouseName,
                locationPath: `${rack.zoneName} > ${rack.name} > ${placement.shelfName}`,
            },
        };
    });

    await batchedUpdate([...shelfUpdates, ...placementUpdates]);
}

export async function propagateRackNameChange(
    businessId: string,
    rackId: string,
    rack: Rack
) {
    // Update shelves
    const shelves = await db
        .collection(`${businessId}/shelves`)
        .where("rackId", "==", rackId)
        .get();

    const shelfUpdates = shelves.docs.map((doc) => {
        const shelf = doc.data() as Shelf;
        return {
            ref: doc.ref,
            data: {
                rackName: rack.name,
                path: `${rack.zoneName} > ${rack.name} > ${shelf.name}`,
            },
        };
    });

    // Update placements
    const placements = await db
        .collection(`${businessId}/placements`)
        .where("rackId", "==", rackId)
        .get();

    const placementUpdates = placements.docs.map((doc) => {
        const placement = doc.data() as Placement;
        return {
            ref: doc.ref,
            data: {
                rackName: rack.name,
                locationPath: `${placement.zoneName} > ${rack.name} > ${placement.shelfName}`,
            },
        };
    });

    await batchedUpdate([...shelfUpdates, ...placementUpdates]);
}

// ============================================================================
// ZONE TRIGGERS → Propagate Name Changes
// ============================================================================

export async function updateZoneCounts(
    businessId: string,
    warehouseId: string,
    delta: number
) {
    await db.doc(`${businessId}/warehouses/${warehouseId}`).update({
        "stats.totalZones": increment(delta),
    });
}

export async function transferZoneStats(
    businessId: string,
    zoneId: string,
    fromWarehouseId: string,
    toWarehouseId: string
) {
    // Get racks in this zone
    const racks = await db
        .collection(`${businessId}/racks`)
        .where("zoneId", "==", zoneId)
        .where("isDeleted", "==", false)
        .get();

    const totalRacks = racks.size;

    // Get shelves in this zone
    const shelves = await db
        .collection(`${businessId}/shelves`)
        .where("zoneId", "==", zoneId)
        .where("isDeleted", "==", false)
        .get();

    const totalShelves = shelves.size;

    // Get total products in this zone
    const placements = await db
        .collection(`${businessId}/placements`)
        .where("zoneId", "==", zoneId)
        .get();

    const totalProducts = placements.docs.reduce(
        (sum, doc) => sum + (doc.data().quantity || 0), 0
    );

    if (totalRacks === 0 && totalShelves === 0 && totalProducts === 0) return;

    const batch = db.batch();

    const fromRef = db.doc(`${businessId}/warehouses/${fromWarehouseId}`);
    const toRef = db.doc(`${businessId}/warehouses/${toWarehouseId}`);

    if (totalRacks > 0) {
        batch.update(fromRef, { "stats.totalRacks": increment(-totalRacks) });
        batch.update(toRef, { "stats.totalRacks": increment(totalRacks) });
    }

    if (totalShelves > 0) {
        batch.update(fromRef, { "stats.totalShelves": increment(-totalShelves) });
        batch.update(toRef, { "stats.totalShelves": increment(totalShelves) });
    }

    if (totalProducts > 0) {
        batch.update(fromRef, { "stats.totalProducts": increment(-totalProducts) });
        batch.update(toRef, { "stats.totalProducts": increment(totalProducts) });
    }

    await batch.commit();
}

export async function propagateZoneLocationChange(
    businessId: string,
    zoneId: string,
    zone: Zone,
) {
    // Update racks
    const racks = await db
        .collection(`${businessId}/racks`)
        .where("zoneId", "==", zoneId)
        .get();

    const rackUpdates = racks.docs.map((doc) => ({
        ref: doc.ref,
        data: {
            warehouseId: zone.warehouseId,
            warehouseName: zone.warehouseName,
        },
    }));

    // Update shelves
    const shelves = await db
        .collection(`${businessId}/shelves`)
        .where("zoneId", "==", zoneId)
        .get();

    const shelfUpdates = shelves.docs.map((doc) => ({
        ref: doc.ref,
        data: {
            warehouseId: zone.warehouseId,
            warehouseName: zone.warehouseName,
        },
    }));

    // Update placements
    const placements = await db
        .collection(`${businessId}/placements`)
        .where("zoneId", "==", zoneId)
        .get();

    const placementUpdates = placements.docs.map((doc) => ({
        ref: doc.ref,
        data: {
            warehouseId: zone.warehouseId,
            warehouseName: zone.warehouseName,
        },
    }));

    await batchedUpdate([...rackUpdates, ...shelfUpdates, ...placementUpdates]);
}

export async function propagateZoneNameChange(
    businessId: string,
    zoneId: string,
    newName: string
) {
    // Update racks
    const racks = await db
        .collection(`${businessId}/racks`)
        .where("zoneId", "==", zoneId)
        .get();

    const rackUpdates = racks.docs.map((doc) => ({
        ref: doc.ref,
        data: { zoneName: newName },
    }));

    // Update shelves
    const shelves = await db
        .collection(`${businessId}/shelves`)
        .where("zoneId", "==", zoneId)
        .get();

    const shelfUpdates = shelves.docs.map((doc) => {
        const shelf = doc.data() as Shelf;
        return {
            ref: doc.ref,
            data: {
                zoneName: newName,
                path: `${newName} > ${shelf.rackName} > ${shelf.name}`,
            },
        };
    });

    // Update placements
    const placements = await db
        .collection(`${businessId}/placements`)
        .where("zoneId", "==", zoneId)
        .get();

    const placementUpdates = placements.docs.map((doc) => {
        const placement = doc.data() as Placement;
        return {
            ref: doc.ref,
            data: {
                zoneName: newName,
                locationPath: `${newName} > ${placement.rackName} > ${placement.shelfName}`,
            },
        };
    });

    await batchedUpdate([...rackUpdates, ...shelfUpdates, ...placementUpdates]);
}

// ============================================================================
// WAREHOUSE TRIGGERS → Propagate Name Changes
// ============================================================================

export async function propagateWarehouseNameChange(
    businessId: string,
    warehouseId: string,
    newName: string
) {
    // Update zones
    const zones = await db
        .collection(`${businessId}/zones`)
        .where("warehouseId", "==", warehouseId)
        .get();

    const zoneUpdates = zones.docs.map((doc) => ({
        ref: doc.ref,
        data: { warehouseName: newName },
    }));

    // Update racks
    const racks = await db
        .collection(`${businessId}/racks`)
        .where("warehouseId", "==", warehouseId)
        .get();

    const rackUpdates = racks.docs.map((doc) => ({
        ref: doc.ref,
        data: { warehouseName: newName },
    }));

    // Update shelves
    const shelves = await db
        .collection(`${businessId}/shelves`)
        .where("warehouseId", "==", warehouseId)
        .get();

    const shelfUpdates = shelves.docs.map((doc) => ({
        ref: doc.ref,
        data: { warehouseName: newName },
    }));

    // Update placements
    const placements = await db
        .collection(`${businessId}/placements`)
        .where("warehouseId", "==", warehouseId)
        .get();

    const placementUpdates = placements.docs.map((doc) => ({
        ref: doc.ref,
        data: { warehouseName: newName },
    }));

    await batchedUpdate([
        ...zoneUpdates,
        ...rackUpdates,
        ...shelfUpdates,
        ...placementUpdates,
    ]);
}