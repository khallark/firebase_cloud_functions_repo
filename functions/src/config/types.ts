// /src/config/types/warehouse.ts

import { Timestamp } from "firebase-admin/firestore";

// users/{businessId}/warehouses/{warehouseId}
export interface Warehouse {
  id: string;
  name: string;
  code: string;
  address: string;
  storageCapacity: number;
  operationalHours: number;
  defaultGSTstate: string;
  isDeleted: boolean;
  deletedAt: Timestamp | null;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  updatedBy: string;

  stats: {
    totalZones: number;
    totalRacks: number;
    totalShelves: number;
    totalProducts: number;
  };

  nameVersion: number;
}

// users/{businessId}/zones/{zoneId}
export interface Zone {
  id: string;
  name: string;
  code: string;
  description: string | null;
  isDeleted: boolean;
  deletedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy: string;
  updatedBy: string;

  warehouseId: string;

  stats: {
    totalRacks: number;
    totalShelves: number;
    totalProducts: number;
  };

  locationVersion: number;
  nameVersion: number;
}

// users/{businessId}/zones/{zoneId}/logs/{logsId}
export interface ZoneLog {
  type: "created" | "updated" | "deleted" | "restored";
  changes: {
    [field: string]: { from: any; to: any };
  } | null;
  note: string | null;
  timestamp: Timestamp;
  userId: string;
}

// users/{businessId}/racks/{rackId}
export interface Rack {
  id: string;
  name: string;
  code: string;
  isDeleted: boolean;
  deletedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy: string;
  updatedBy: string;

  warehouseId: string;

  zoneId: string;
  position: number;

  stats: {
    totalShelves: number;
    totalProducts: number;
  };

  locationVersion: number;
  nameVersion: number;
}

// users/{businessId}/racks/{rackId}/logs/{logId}
export interface RackLog {
  type: "created" | "updated" | "deleted" | "restored" | "moved";
  changes: {
    [field: string]: { from: any; to: any };
  } | null;
  fromZone: { id: string } | null;
  toZone: { id: string } | null;
  timestamp: Timestamp;
  userId: string;
}

// users/{businessId}/shelves/{shelfId}
export interface Shelf {
  id: string;
  name: string;
  code: string;
  capacity: number | null;
  isDeleted: boolean;
  deletedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy: string;
  updatedBy: string;

  warehouseId: string;

  zoneId: string;

  rackId: string;
  position: number;

  stats: {
    totalProducts: number;
  };

  locationVersion: number;
  nameVersion: number;
}

// users/{businessId}/shelves/{shelfId}/logs/{logId}
export interface ShelfLog {
  type: "created" | "updated" | "deleted" | "restored" | "moved";
  changes: {
    [field: string]: { from: any; to: any };
  } | null;
  fromRack: { id: string; zoneId: string } | null;
  toRack: { id: string; zoneId: string } | null;
  timestamp: Timestamp;
  userId: string;
}

// users/{businessId}/placements/{placementId}
// placementId = `${productId}_${shelfId}` (composite ID)
export interface Placement {
  id: string;
  createUPCs: boolean;
  quantity: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy: string;
  updatedBy: string;

  productId: string;

  warehouseId: string;

  zoneId: string;

  rackId: string;

  shelfId: string;

  lastMovementReason: string | null;
  lastMovementReference: string | null;
}

// users/{businessId}/upcs/{upcId}
export type UPC =
  | {
      id: string;
      createdAt: Timestamp;
      updatedAt: Timestamp;
      createdBy: string;
      updatedBy: string;

      storeId: string | null;
      orderId: string | null;

      grnRef: string | null;
      
      putAway: "none" | "outbound" | null;

      productId: string;
      warehouseId: string;
      zoneId: string;
      rackId: string;
      shelfId: string;
      placementId: string;
    }
  | {
      id: string;
      createdAt: Timestamp;
      updatedAt: Timestamp;
      createdBy: string;
      updatedBy: string;

      storeId: string | null;
      orderId: string | null;

      grnRef: string | null;

      putAway: "inbound";

      productId: string;
      warehouseId: string | null;
      zoneId: string | null;
      rackId: string | null;
      shelfId: string | null;
      placementId: string | null;
    };

// users/{businessId}/placements/{placementId}/logs/{logId}
export interface PlacementLog {
  type: "added" | "removed" | "quantity_adjusted";
  quantity: number;
  quantityBefore: number | null;
  quantityAfter: number | null;
  relatedMovementId: string | null;
  note: string | null;
  timestamp: Timestamp;
  userId: string;
}

// users/{businessId}/movements/{movementId}
export interface Movement {
  id: string;

  productId: string;

  type: "transfer" | "inbound" | "outbound" | "adjustment";

  from: {
    shelfId: string | null;
    rackId: string | null;
    zoneId: string | null;
    warehouseId: string | null;
  };

  to: {
    shelfId: string | null;
    rackId: string | null;
    zoneId: string | null;
    warehouseId: string | null;
  };

  quantity: number;
  reason: string | null;
  reference: string | null;

  timestamp: Timestamp;
  userId: string;
  userName: string;
}

export interface PropagationTask {
  type: "shelf-location" | "rack-location" | "zone-location";

  businessId: string;
  entityId: string; // shelfId, rackId, zoneId, or warehouseId

  // Data needed for propagation
  data: any;

  // Pagination
  chunkIndex: number;
  totalChunks: number;
  chunkSize: number;

  // For idempotency & tracking
  propagationId: string;

  // Version control (prevent applying stale updates)
  version?: number;
}

export interface PropagationTracker {
  id: string; // propagationId
  type: PropagationTask["type"];
  businessId: string;
  entityId: string;
  collection: string;

  status: "pending" | "in_progress" | "completed" | "failed" | "obsolete";

  totalDocuments: number;
  processedDocuments: number;
  failedDocuments: number;

  chunksTotal: number;
  chunksCompleted: number;
  chunksFailed: number;

  startedAt: Timestamp;
  completedAt: Timestamp | null;
  lastError: string | null;

  // For version control
  version?: number;
}
