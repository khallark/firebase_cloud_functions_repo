import { FieldValue, Timestamp, DocumentReference } from "firebase-admin/firestore";
import {
  Movement,
  Placement,
  PlacementLog,
  Rack,
  RackLog,
  Shelf,
  ShelfLog,
  Zone,
  ZoneLog,
} from "../../config/types";
import { db } from "../../firebaseAdmin";
import { chunkArray } from "../../helpers";

const increment = FieldValue.increment;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export async function batchedUpdate(
  updates: { ref: DocumentReference; data: Record<string, any> }[],
) {
  const chunks = chunkArray(updates, 500);

  for (const chunk of chunks) {
    const batch = db.batch();
    chunk.forEach(({ ref, data }) => batch.update(ref, data));
    await batch.commit();
  }
}

export function getChanges(
  before: Record<string, any>,
  after: Record<string, any>,
  fieldsToTrack: string[],
): Record<string, { from: any; to: any }> | undefined {
  const changes: Record<string, { from: any; to: any }> = {};

  for (const field of fieldsToTrack) {
    const fromVal = before[field];
    const toVal = after[field];

    if (JSON.stringify(fromVal) !== JSON.stringify(toVal)) {
      changes[field] = { from: fromVal, to: toVal };
    }
  }

  return Object.keys(changes).length > 0 ? changes : undefined;
}

// ============================================================================
// LOG CREATION FUNCTIONS
// ============================================================================

export async function createZoneLog(
  businessId: string,
  zoneId: string,
  type: ZoneLog["type"],
  userId: string,
  changes: Record<string, { from: any; to: any }> | null,
  note: string | null,
) {
  const logRef = db.collection(`users/${businessId}/zones/${zoneId}/logs`).doc();

  const log: ZoneLog = {
    type,
    changes,
    note,
    timestamp: Timestamp.now(),
    userId,
  };

  // Remove undefined fields
  Object.keys(log).forEach((key) => {
    if ((log as any)[key] === undefined) {
      delete (log as any)[key];
    }
  });

  await logRef.set(log);
}

export async function createRackLog(
  businessId: string,
  rackId: string,
  type: RackLog["type"],
  userId: string,
  changes: Record<string, { from: any; to: any }> | null,
  fromZone: { id: string; name: string } | null,
  toZone: { id: string; name: string } | null,
) {
  const logRef = db.collection(`users/${businessId}/racks/${rackId}/logs`).doc();

  const log: RackLog = {
    type,
    changes,
    fromZone,
    toZone,
    timestamp: Timestamp.now(),
    userId,
  };

  Object.keys(log).forEach((key) => {
    if ((log as any)[key] === undefined) {
      delete (log as any)[key];
    }
  });

  await logRef.set(log);
}

export async function createShelfLog(
  businessId: string,
  shelfId: string,
  type: ShelfLog["type"],
  userId: string,
  changes: Record<string, { from: any; to: any }> | null,
  fromRack: { id: string; name: string; zoneId: string } | null,
  toRack: { id: string; name: string; zoneId: string } | null,
) {
  const logRef = db.collection(`users/${businessId}/shelves/${shelfId}/logs`).doc();

  const log: ShelfLog = {
    type,
    changes,
    fromRack,
    toRack,
    timestamp: Timestamp.now(),
    userId,
  };

  Object.keys(log).forEach((key) => {
    if ((log as any)[key] === undefined) {
      delete (log as any)[key];
    }
  });

  await logRef.set(log);
}

export async function createPlacementLog(
  businessId: string,
  placementId: string,
  type: PlacementLog["type"],
  userId: string,
  quantity: number,
  quantityBefore: number | null,
  quantityAfter: number | null,
  relatedMovementId: string | null,
  note: string | null,
) {
  const logRef = db.collection(`users/${businessId}/placements/${placementId}/logs`).doc();

  const log: PlacementLog = {
    type,
    quantity,
    quantityBefore,
    quantityAfter,
    relatedMovementId,
    note,
    timestamp: Timestamp.now(),
    userId,
  };

  Object.keys(log).forEach((key) => {
    if ((log as any)[key] === undefined) {
      delete (log as any)[key];
    }
  });

  await logRef.set(log);
}

// ============================================================================
// PLACEMENT TRIGGERS → Update Location Stats
// ============================================================================

export async function createMovement(
  businessId: string,
  type: "inbound" | "outbound" | "transfer" | "adjustment",
  from: Placement | null,
  to: Placement | null,
  quantity: number,
): Promise<string> {
  const ref = db.collection(`users/${businessId}/movements`).doc();

  const source = to ?? from;

  const movement: Movement = {
    id: ref.id,
    productId: source!.productId,
    productSKU: source!.productSKU,
    type,
    from: from
      ? {
          shelfId: from.shelfId,
          shelfName: from.shelfName,
          rackId: from.rackId,
          rackName: from.rackName,
          zoneId: from.zoneId,
          zoneName: from.zoneName,
          warehouseId: from.warehouseId,
          warehouseName: from.warehouseName,
        }
      : {
          shelfId: null,
          shelfName: null,
          rackId: null,
          rackName: null,
          zoneId: null,
          zoneName: null,
          warehouseId: null,
          warehouseName: null,
        },
    to: to
      ? {
          shelfId: to.shelfId,
          shelfName: to.shelfName,
          rackId: to.rackId,
          rackName: to.rackName,
          zoneId: to.zoneId,
          zoneName: to.zoneName,
          warehouseId: to.warehouseId,
          warehouseName: to.warehouseName,
        }
      : {
          shelfId: null,
          shelfName: null,
          rackId: null,
          rackName: null,
          zoneId: null,
          zoneName: null,
          warehouseId: null,
          warehouseName: null,
        },
    quantity,
    reason: source!.lastMovementReason ?? "",
    reference: source!.lastMovementReference ?? "",
    timestamp: Timestamp.now(),
    userId: source!.updatedBy ?? source!.createdBy ?? "system",
    userName: "",
  };

  await ref.set(movement);

  return ref.id;
}

export async function updateLocationStats(
  businessId: string,
  placement: Placement,
  quantityDelta: number,
) {
  const batch = db.batch();

  batch.update(db.doc(`users/${businessId}/shelves/${placement.shelfId}`), {
    "stats.totalProducts": increment(quantityDelta),
  });

  batch.update(db.doc(`users/${businessId}/racks/${placement.rackId}`), {
    "stats.totalProducts": increment(quantityDelta),
  });

  batch.update(db.doc(`users/${businessId}/zones/${placement.zoneId}`), {
    "stats.totalProducts": increment(quantityDelta),
  });

  batch.update(db.doc(`users/${businessId}/warehouses/${placement.warehouseId}`), {
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
  delta: number,
) {
  const batch = db.batch();

  batch.update(db.doc(`users/${businessId}/racks/${rackId}`), {
    "stats.totalShelves": increment(delta),
  });

  batch.update(db.doc(`users/${businessId}/zones/${zoneId}`), {
    "stats.totalShelves": increment(delta),
  });

  batch.update(db.doc(`users/${businessId}/warehouses/${warehouseId}`), {
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
    .collection(`users/${businessId}/placements`)
    .where("shelfId", "==", shelfId)
    .get();

  if (placements.empty) return;

  const totalProducts = placements.docs.reduce((sum, doc) => sum + (doc.data().quantity || 0), 0);

  const batch = db.batch();

  // Rack stats
  batch.update(db.doc(`users/${businessId}/racks/${fromRackId}`), {
    "stats.totalProducts": increment(-totalProducts),
  });
  batch.update(db.doc(`users/${businessId}/racks/${toRackId}`), {
    "stats.totalProducts": increment(totalProducts),
  });

  // Zone stats (only if changed)
  if (fromZoneId !== toZoneId) {
    batch.update(db.doc(`users/${businessId}/zones/${fromZoneId}`), {
      "stats.totalProducts": increment(-totalProducts),
    });
    batch.update(db.doc(`users/${businessId}/zones/${toZoneId}`), {
      "stats.totalProducts": increment(totalProducts),
    });
  }

  // Warehouse stats (only if changed)
  if (fromWarehouseId !== toWarehouseId) {
    batch.update(db.doc(`users/${businessId}/warehouses/${fromWarehouseId}`), {
      "stats.totalProducts": increment(-totalProducts),
    });
    batch.update(db.doc(`users/${businessId}/warehouses/${toWarehouseId}`), {
      "stats.totalProducts": increment(totalProducts),
    });
  }

  await batch.commit();
}

export async function propagateShelfNameChange(businessId: string, shelfId: string, shelf: Shelf) {
  const placements = await db
    .collection(`users/${businessId}/placements`)
    .where("shelfId", "==", shelfId)
    .get();

  if (placements.empty) return;

  const updates = placements.docs.map((doc) => ({
    ref: doc.ref,
    data: {
      shelfName: shelf.name,
    },
  }));

  await batchedUpdate(updates);
}

export async function propagateShelfLocationChange(
  businessId: string,
  shelfId: string,
  shelf: Shelf,
) {
  const placements = await db
    .collection(`users/${businessId}/placements`)
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
    },
  }));

  await batchedUpdate(updates);
}

export async function propagateShelfCoordinatesChange(
  businessId: string,
  shelfId: string,
  shelf: Shelf,
) {
  const placements = await db
    .collection(`users/${businessId}/placements`)
    .where("shelfId", "==", shelfId)
    .get();

  if (placements.empty) return;

  const locationCode = shelf.coordinates
    ? `${shelf.coordinates.aisle}-${String(shelf.coordinates.bay).padStart(2, "0")}-${shelf.coordinates.level}`
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
  delta: number,
) {
  const batch = db.batch();

  batch.update(db.doc(`users/${businessId}/zones/${zoneId}`), {
    "stats.totalRacks": increment(delta),
  });

  batch.update(db.doc(`users/${businessId}/warehouses/${warehouseId}`), {
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
  toWarehouseId: string,
) {
  const shelves = await db
    .collection(`users/${businessId}/shelves`)
    .where("rackId", "==", rackId)
    .where("isDeleted", "==", false)
    .get();

  const totalShelves = shelves.size;

  const placements = await db
    .collection(`users/${businessId}/placements`)
    .where("rackId", "==", rackId)
    .get();

  const totalProducts = placements.docs.reduce((sum, doc) => sum + (doc.data().quantity || 0), 0);

  if (totalShelves === 0 && totalProducts === 0) return;

  const batch = db.batch();

  if (totalShelves > 0) {
    batch.update(db.doc(`users/${businessId}/zones/${fromZoneId}`), {
      "stats.totalShelves": increment(-totalShelves),
    });
    batch.update(db.doc(`users/${businessId}/zones/${toZoneId}`), {
      "stats.totalShelves": increment(totalShelves),
    });
  }

  if (totalProducts > 0) {
    batch.update(db.doc(`users/${businessId}/zones/${fromZoneId}`), {
      "stats.totalProducts": increment(-totalProducts),
    });
    batch.update(db.doc(`users/${businessId}/zones/${toZoneId}`), {
      "stats.totalProducts": increment(totalProducts),
    });
  }

  if (fromWarehouseId !== toWarehouseId) {
    batch.update(db.doc(`users/${businessId}/warehouses/${fromWarehouseId}`), {
      "stats.totalShelves": increment(-totalShelves),
      "stats.totalProducts": increment(-totalProducts),
    });
    batch.update(db.doc(`users/${businessId}/warehouses/${toWarehouseId}`), {
      "stats.totalShelves": increment(totalShelves),
      "stats.totalProducts": increment(totalProducts),
    });
  }

  await batch.commit();
}

export async function propagateRackLocationChange(businessId: string, rackId: string, rack: Rack) {
  const shelves = await db
    .collection(`users/${businessId}/shelves`)
    .where("rackId", "==", rackId)
    .get();

  const shelfUpdates = shelves.docs.map((doc) => {
    return {
      ref: doc.ref,
      data: {
        zoneId: rack.zoneId,
        zoneName: rack.zoneName,
        warehouseId: rack.warehouseId,
        warehouseName: rack.warehouseName,
      },
    };
  });

  const placements = await db
    .collection(`users/${businessId}/placements`)
    .where("rackId", "==", rackId)
    .get();

  const placementUpdates = placements.docs.map((doc) => {
    return {
      ref: doc.ref,
      data: {
        zoneId: rack.zoneId,
        zoneName: rack.zoneName,
        warehouseId: rack.warehouseId,
        warehouseName: rack.warehouseName,
      },
    };
  });

  await batchedUpdate([...shelfUpdates, ...placementUpdates]);
}

export async function propagateRackNameChange(businessId: string, rackId: string, rack: Rack) {
  const shelves = await db
    .collection(`users/${businessId}/shelves`)
    .where("rackId", "==", rackId)
    .get();

  const shelfUpdates = shelves.docs.map((doc) => {
    return {
      ref: doc.ref,
      data: {
        rackName: rack.name,
      },
    };
  });

  const placements = await db
    .collection(`users/${businessId}/placements`)
    .where("rackId", "==", rackId)
    .get();

  const placementUpdates = placements.docs.map((doc) => {
    return {
      ref: doc.ref,
      data: {
        rackName: rack.name,
      },
    };
  });

  await batchedUpdate([...shelfUpdates, ...placementUpdates]);
}

// ============================================================================
// ZONE TRIGGERS → Propagate Name Changes
// ============================================================================

export async function updateZoneCounts(businessId: string, warehouseId: string, delta: number) {
  await db.doc(`users/${businessId}/warehouses/${warehouseId}`).update({
    "stats.totalZones": increment(delta),
  });
}

export async function transferZoneStats(
  businessId: string,
  zoneId: string,
  fromWarehouseId: string,
  toWarehouseId: string,
) {
  const racks = await db
    .collection(`users/${businessId}/racks`)
    .where("zoneId", "==", zoneId)
    .where("isDeleted", "==", false)
    .get();

  const totalRacks = racks.size;

  const shelves = await db
    .collection(`users/${businessId}/shelves`)
    .where("zoneId", "==", zoneId)
    .where("isDeleted", "==", false)
    .get();

  const totalShelves = shelves.size;

  const placements = await db
    .collection(`users/${businessId}/placements`)
    .where("zoneId", "==", zoneId)
    .get();

  const totalProducts = placements.docs.reduce((sum, doc) => sum + (doc.data().quantity || 0), 0);

  if (totalRacks === 0 && totalShelves === 0 && totalProducts === 0) return;

  const batch = db.batch();

  const fromRef = db.doc(`users/${businessId}/warehouses/${fromWarehouseId}`);
  const toRef = db.doc(`users/${businessId}/warehouses/${toWarehouseId}`);

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

export async function propagateZoneLocationChange(businessId: string, zoneId: string, zone: Zone) {
  const racks = await db
    .collection(`users/${businessId}/racks`)
    .where("zoneId", "==", zoneId)
    .get();

  const rackUpdates = racks.docs.map((doc) => ({
    ref: doc.ref,
    data: {
      warehouseId: zone.warehouseId,
      warehouseName: zone.warehouseName,
    },
  }));

  const shelves = await db
    .collection(`users/${businessId}/shelves`)
    .where("zoneId", "==", zoneId)
    .get();

  const shelfUpdates = shelves.docs.map((doc) => ({
    ref: doc.ref,
    data: {
      warehouseId: zone.warehouseId,
      warehouseName: zone.warehouseName,
    },
  }));

  const placements = await db
    .collection(`users/${businessId}/placements`)
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

export async function propagateZoneNameChange(businessId: string, zoneId: string, newName: string) {
  const racks = await db
    .collection(`users/${businessId}/racks`)
    .where("zoneId", "==", zoneId)
    .get();

  const rackUpdates = racks.docs.map((doc) => ({
    ref: doc.ref,
    data: { zoneName: newName },
  }));

  const shelves = await db
    .collection(`users/${businessId}/shelves`)
    .where("zoneId", "==", zoneId)
    .get();

  const shelfUpdates = shelves.docs.map((doc) => {
    return {
      ref: doc.ref,
      data: {
        zoneName: newName,
      },
    };
  });

  const placements = await db
    .collection(`users/${businessId}/placements`)
    .where("zoneId", "==", zoneId)
    .get();

  const placementUpdates = placements.docs.map((doc) => {
    return {
      ref: doc.ref,
      data: {
        zoneName: newName,
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
  newName: string,
) {
  const zones = await db
    .collection(`users/${businessId}/zones`)
    .where("warehouseId", "==", warehouseId)
    .get();

  const zoneUpdates = zones.docs.map((doc) => ({
    ref: doc.ref,
    data: { warehouseName: newName },
  }));

  const racks = await db
    .collection(`users/${businessId}/racks`)
    .where("warehouseId", "==", warehouseId)
    .get();

  const rackUpdates = racks.docs.map((doc) => ({
    ref: doc.ref,
    data: { warehouseName: newName },
  }));

  const shelves = await db
    .collection(`users/${businessId}/shelves`)
    .where("warehouseId", "==", warehouseId)
    .get();

  const shelfUpdates = shelves.docs.map((doc) => ({
    ref: doc.ref,
    data: { warehouseName: newName },
  }));

  const placements = await db
    .collection(`users/${businessId}/placements`)
    .where("warehouseId", "==", warehouseId)
    .get();

  const placementUpdates = placements.docs.map((doc) => ({
    ref: doc.ref,
    data: { warehouseName: newName },
  }));

  await batchedUpdate([...zoneUpdates, ...rackUpdates, ...shelfUpdates, ...placementUpdates]);
}
