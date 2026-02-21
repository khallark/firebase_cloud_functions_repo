import {
  FieldValue,
  Timestamp,
  DocumentReference,
  Query,
  Transaction,
} from "firebase-admin/firestore";
import {
  Movement,
  Placement,
  PlacementLog,
  PropagationTask,
  PropagationTracker,
  Rack,
  RackLog,
  Shelf,
  ShelfLog,
  UPC,
  Zone,
  ZoneLog,
} from "../../config/types";
import { db } from "../../firebaseAdmin";
import { chunkArray } from "../../helpers";
import { enqueuePropagationTask } from "../../services";

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
  fromZone: { id: string } | null,
  toZone: { id: string } | null,
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
  fromRack: { id: string; zoneId: string } | null,
  toRack: { id: string; zoneId: string } | null,
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
// PROPAGATION WITH CLOUD TASKS
// ============================================================================

async function createPropagationTasks(
  type: PropagationTask["type"],
  businessId: string,
  entityId: string,
  data: any,
  query: Query,
  version?: number,
) {
  // Check for in-progress propagation
  const existingTrackers = await db
    .collection(`users/${businessId}/propagation_trackers`)
    .where("entityId", "==", entityId)
    .where("type", "==", type)
    .where("collection", "==", data.collection)
    .where("status", "in", ["pending", "in_progress"])
    .limit(1)
    .get();

  if (!existingTrackers.empty) {
    console.log(`Propagation already in progress for ${type} ${entityId}`);
    return;
  }

  // Count total documents
  const snapshot = await query.select().get();
  const totalDocs = snapshot.size;

  if (totalDocs === 0) {
    console.log(`No documents to propagate for ${type} ${entityId} ${data.collection}`);
    return;
  }

  const chunkSize = 500;
  const totalChunks = Math.ceil(totalDocs / chunkSize);

  // Create unique and deterministic propagation ID
  const propagationId = `${businessId}__${type}__${entityId}__${data.collection}__v${version ?? 0}`;

  // Create tracker document
  const doc: PropagationTracker = {
    id: propagationId,
    type,
    businessId,
    entityId,
    collection: data.collection,
    status: "pending",
    totalDocuments: totalDocs,
    processedDocuments: 0,
    failedDocuments: 0,
    chunksTotal: totalChunks,
    chunksCompleted: 0,
    chunksFailed: 0,
    startedAt: Timestamp.now(),
    completedAt: null,
    lastError: null,
    version: version || 0,
  };
  await db.doc(`users/${businessId}/propagation_trackers/${propagationId}`).set(doc);

  // Enqueue tasks for each chunk
  const tasks: Promise<void>[] = [];

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const taskPayload: PropagationTask = {
      type,
      businessId,
      entityId,
      data,
      chunkIndex,
      totalChunks,
      chunkSize,
      propagationId,
      version,
    };

    // Use deterministic task ID for deduplication
    const taskId = `${propagationId}-chunk-${chunkIndex}`;

    tasks.push(enqueuePropagationTask(taskPayload, taskId));
  }

  await Promise.all(tasks);

  console.log(`Enqueued ${totalChunks} tasks for propagation ${propagationId}`);

  // Update tracker status
  await db.doc(`users/${businessId}/propagation_trackers/${propagationId}`).update({
    status: "in_progress",
  });
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
  const source = to ?? from;

  // Create deterministic ID for idempotency
  const timestamp = Date.now();
  const deterministicId = `${type}_${source!.productId}_${source!.shelfId}_${timestamp}`;
  const ref = db.collection(`users/${businessId}/movements`).doc(deterministicId);

  // Check if already exists (idempotency)
  const existing = await ref.get();
  if (existing.exists) {
    return ref.id;
  }

  const movement: Movement = {
    id: ref.id,
    productId: source!.productId,
    type,
    from: from
      ? {
          shelfId: from.shelfId,
          rackId: from.rackId,
          zoneId: from.zoneId,
          warehouseId: from.warehouseId,
        }
      : {
          shelfId: null,
          rackId: null,
          zoneId: null,
          warehouseId: null,
        },
    to: to
      ? {
          shelfId: to.shelfId,
          rackId: to.rackId,
          zoneId: to.zoneId,
          warehouseId: to.warehouseId,
        }
      : {
          shelfId: null,
          rackId: null,
          zoneId: null,
          warehouseId: null,
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

export function updateLocationStatsInTransaction(
  transaction: Transaction,
  businessId: string,
  placement: Placement,
  quantityDelta: number,
) {
  transaction.update(db.doc(`users/${businessId}/shelves/${placement.shelfId}`), {
    "stats.totalProducts": increment(quantityDelta),
  });

  transaction.update(db.doc(`users/${businessId}/racks/${placement.rackId}`), {
    "stats.totalProducts": increment(quantityDelta),
  });

  transaction.update(db.doc(`users/${businessId}/zones/${placement.zoneId}`), {
    "stats.totalProducts": increment(quantityDelta),
  });

  transaction.update(db.doc(`users/${businessId}/warehouses/${placement.warehouseId}`), {
    "stats.totalProducts": increment(quantityDelta),
  });

  transaction.update(db.doc(`users/${businessId}/products/${placement.productId}`), {
    inShelfQuantity: increment(quantityDelta),
  });
}

/**
 * Creates UPC documents for a placement
 * Assumes count <= 500 (transaction limit)
 */
export async function createUPCsForPlacement(
  businessId: string,
  placement: Placement,
  count: number,
  userId: string,
): Promise<void> {
  if (count <= 0) return;
  if (count > 500) {
    console.warn(`UPC count ${count} exceeds 500, skipping UPC creation`);
    return;
  }

  const batch = db.batch();
  const timestamp = Timestamp.now();

  for (let i = 0; i < count; i++) {
    const upcRef = db.collection(`users/${businessId}/upcs`).doc();

    const upc: UPC = {
      id: upcRef.id,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: userId,
      updatedBy: userId,
      storeId: null,
      orderId: null,
      grnRef: null,
      putAway: "none",
      productId: placement.productId,
      warehouseId: placement.warehouseId,
      zoneId: placement.zoneId,
      rackId: placement.rackId,
      shelfId: placement.shelfId,
      placementId: placement.id,
    };

    batch.set(upcRef, upc);
  }

  await batch.commit();
  console.log(`Created ${count} UPCs for placement ${placement.id}`);
}

// ============================================================================
// SHELF TRIGGERS → Update Rack/Zone Shelf Counts + Propagate Name Changes
// ============================================================================

export function updateShelfCountsInTransaction(
  transaction: Transaction,
  businessId: string,
  rackId: string,
  zoneId: string,
  warehouseId: string,
  delta: number,
) {
  transaction.update(db.doc(`users/${businessId}/racks/${rackId}`), {
    "stats.totalShelves": increment(delta),
  });

  transaction.update(db.doc(`users/${businessId}/zones/${zoneId}`), {
    "stats.totalShelves": increment(delta),
  });

  transaction.update(db.doc(`users/${businessId}/warehouses/${warehouseId}`), {
    "stats.totalShelves": increment(delta),
  });
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
  // Query first (outside transaction)
  const placements = await db
    .collection(`users/${businessId}/placements`)
    .where("shelfId", "==", shelfId)
    .get();

  if (placements.empty) return;

  const totalProducts = placements.docs.reduce((sum, doc) => sum + (doc.data().quantity || 0), 0);

  // Use transaction for atomic stats transfer
  await db.runTransaction(async (transaction) => {
    // Rack stats
    transaction.update(db.doc(`users/${businessId}/racks/${fromRackId}`), {
      "stats.totalProducts": increment(-totalProducts),
    });
    transaction.update(db.doc(`users/${businessId}/racks/${toRackId}`), {
      "stats.totalProducts": increment(totalProducts),
    });

    // Zone stats (only if changed)
    if (fromZoneId !== toZoneId) {
      transaction.update(db.doc(`users/${businessId}/zones/${fromZoneId}`), {
        "stats.totalProducts": increment(-totalProducts),
      });
      transaction.update(db.doc(`users/${businessId}/zones/${toZoneId}`), {
        "stats.totalProducts": increment(totalProducts),
      });
    }

    // Warehouse stats (only if changed)
    if (fromWarehouseId !== toWarehouseId) {
      transaction.update(db.doc(`users/${businessId}/warehouses/${fromWarehouseId}`), {
        "stats.totalProducts": increment(-totalProducts),
      });
      transaction.update(db.doc(`users/${businessId}/warehouses/${toWarehouseId}`), {
        "stats.totalProducts": increment(totalProducts),
      });
    }
  });
}

export async function propagateShelfLocationChange(
  businessId: string,
  shelfId: string,
  shelf: Shelf,
) {
  const placementsQuery = db
    .collection(`users/${businessId}/placements`)
    .where("shelfId", "==", shelfId);

  await createPropagationTasks(
    "shelf-location",
    businessId,
    shelfId,
    {
      collection: "placements",
      rackId: shelf.rackId,
      zoneId: shelf.zoneId,
      warehouseId: shelf.warehouseId,
    },
    placementsQuery,
    shelf.locationVersion,
  );

  // Create tasks for upcs
  const upcsQuery = db.collection(`users/${businessId}/upcs`).where("shelfId", "==", shelfId);

  await createPropagationTasks(
    "shelf-location",
    businessId,
    shelfId,
    {
      collection: "upcs",
      rackId: shelf.rackId,
      zoneId: shelf.zoneId,
      warehouseId: shelf.warehouseId,
    },
    upcsQuery,
    shelf.locationVersion,
  );
}

// ============================================================================
// RACK TRIGGERS → Update Zone Rack Counts + Propagate Name Changes
// ============================================================================

export function updateRackCountsInTransaction(
  transaction: Transaction,
  businessId: string,
  zoneId: string,
  warehouseId: string,
  delta: number,
) {
  transaction.update(db.doc(`users/${businessId}/zones/${zoneId}`), {
    "stats.totalRacks": increment(delta),
  });

  transaction.update(db.doc(`users/${businessId}/warehouses/${warehouseId}`), {
    "stats.totalRacks": increment(delta),
  });
}

export async function transferRackStats(
  businessId: string,
  rackId: string,
  fromZoneId: string,
  fromWarehouseId: string,
  toZoneId: string,
  toWarehouseId: string,
) {
  // Query first (outside transaction)
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

  // Use transaction for atomic stats transfer
  await db.runTransaction(async (transaction) => {
    if (totalShelves > 0) {
      transaction.update(db.doc(`users/${businessId}/zones/${fromZoneId}`), {
        "stats.totalShelves": increment(-totalShelves),
      });
      transaction.update(db.doc(`users/${businessId}/zones/${toZoneId}`), {
        "stats.totalShelves": increment(totalShelves),
      });
    }

    if (totalProducts > 0) {
      transaction.update(db.doc(`users/${businessId}/zones/${fromZoneId}`), {
        "stats.totalProducts": increment(-totalProducts),
      });
      transaction.update(db.doc(`users/${businessId}/zones/${toZoneId}`), {
        "stats.totalProducts": increment(totalProducts),
      });
    }

    if (fromWarehouseId !== toWarehouseId) {
      transaction.update(db.doc(`users/${businessId}/warehouses/${fromWarehouseId}`), {
        "stats.totalShelves": increment(-totalShelves),
        "stats.totalProducts": increment(-totalProducts),
      });
      transaction.update(db.doc(`users/${businessId}/warehouses/${toWarehouseId}`), {
        "stats.totalShelves": increment(totalShelves),
        "stats.totalProducts": increment(totalProducts),
      });
    }
  });
}

export async function propagateRackLocationChange(businessId: string, rackId: string, rack: Rack) {
  // Create tasks for shelves
  const shelvesQuery = db.collection(`users/${businessId}/shelves`).where("rackId", "==", rackId);

  await createPropagationTasks(
    "rack-location",
    businessId,
    rackId,
    {
      collection: "shelves",
      zoneId: rack.zoneId,
      warehouseId: rack.warehouseId,
    },
    shelvesQuery,
    rack.locationVersion,
  );

  // Create tasks for placements
  const placementsQuery = db
    .collection(`users/${businessId}/placements`)
    .where("rackId", "==", rackId);

  await createPropagationTasks(
    "rack-location",
    businessId,
    rackId,
    {
      collection: "placements",
      zoneId: rack.zoneId,
      warehouseId: rack.warehouseId,
    },
    placementsQuery,
    rack.locationVersion,
  );

  // Create tasks for upcs
  const upcsQuery = db.collection(`users/${businessId}/upcs`).where("rackId", "==", rackId);

  await createPropagationTasks(
    "rack-location",
    businessId,
    rackId,
    {
      collection: "upcs",
      zoneId: rack.zoneId,
      warehouseId: rack.warehouseId,
    },
    upcsQuery,
    rack.locationVersion,
  );
}

// ============================================================================
// ZONE TRIGGERS → Propagate Name Changes
// ============================================================================

export function updateZoneCountsInTransaction(
  transaction: Transaction,
  businessId: string,
  warehouseId: string,
  delta: number,
) {
  transaction.update(db.doc(`users/${businessId}/warehouses/${warehouseId}`), {
    "stats.totalZones": increment(delta),
  });
}

export async function transferZoneStats(
  businessId: string,
  zoneId: string,
  fromWarehouseId: string,
  toWarehouseId: string,
) {
  // Query first (outside transaction)
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

  // Use transaction for atomic stats transfer
  await db.runTransaction(async (transaction) => {
    const fromRef = db.doc(`users/${businessId}/warehouses/${fromWarehouseId}`);
    const toRef = db.doc(`users/${businessId}/warehouses/${toWarehouseId}`);

    if (totalRacks > 0) {
      transaction.update(fromRef, { "stats.totalRacks": increment(-totalRacks) });
      transaction.update(toRef, { "stats.totalRacks": increment(totalRacks) });
    }

    if (totalShelves > 0) {
      transaction.update(fromRef, { "stats.totalShelves": increment(-totalShelves) });
      transaction.update(toRef, { "stats.totalShelves": increment(totalShelves) });
    }

    if (totalProducts > 0) {
      transaction.update(fromRef, { "stats.totalProducts": increment(-totalProducts) });
      transaction.update(toRef, { "stats.totalProducts": increment(totalProducts) });
    }
  });
}

export async function propagateZoneLocationChange(businessId: string, zoneId: string, zone: Zone) {
  // Create tasks for racks
  const racksQuery = db.collection(`users/${businessId}/racks`).where("zoneId", "==", zoneId);

  await createPropagationTasks(
    "zone-location",
    businessId,
    zoneId,
    {
      collection: "racks",
      warehouseId: zone.warehouseId,
    },
    racksQuery,
    zone.locationVersion,
  );

  // Create tasks for shelves
  const shelvesQuery = db.collection(`users/${businessId}/shelves`).where("zoneId", "==", zoneId);

  await createPropagationTasks(
    "zone-location",
    businessId,
    zoneId,
    {
      collection: "shelves",
      warehouseId: zone.warehouseId,
    },
    shelvesQuery,
    zone.locationVersion,
  );

  // Create tasks for placements
  const placementsQuery = db
    .collection(`users/${businessId}/placements`)
    .where("zoneId", "==", zoneId);

  await createPropagationTasks(
    "zone-location",
    businessId,
    zoneId,
    {
      collection: "placements",
      warehouseId: zone.warehouseId,
    },
    placementsQuery,
    zone.locationVersion,
  );

  // Create tasks for upcs
  const upcsQuery = db.collection(`users/${businessId}/upcs`).where("zoneId", "==", zoneId);

  await createPropagationTasks(
    "zone-location",
    businessId,
    zoneId,
    {
      collection: "upcs",
      warehouseId: zone.warehouseId,
    },
    upcsQuery,
    zone.locationVersion,
  );
}
