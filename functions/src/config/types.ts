// /src/config/types/warehouse.ts

import { Timestamp } from "firebase-admin/firestore";


// /{businessId}/warehouses/{warehouseId}
export interface Warehouse {
    id: string;
    name: string;
    address: string;
    storageCapacity: number;
    operationalHours: number;
    defaultGSTstate: string;
    isDeleted: boolean;
    deletedAt?: Timestamp;
    createdBy: string;
    createdAt: Timestamp;
    updatedAt: Timestamp;

    stats: {
        totalZones: number;
        totalRacks: number;
        totalShelves: number;
        totalProducts: number;
    };
}

// /{businessId}/zones/{zoneId}
export interface Zone {
    id: string;
    name: string;
    code: string;              // e.g.; "Z-001"
    description?: string;
    isDeleted: boolean;
    deletedAt?: Timestamp;
    createdAt: Timestamp;
    updatedAt: Timestamp;
    createdBy: string;
    updatedBy: string;

    warehouseId: string;
    warehouseName: string;     // Denormalized for display

    // Stats (denormalized; update via cloud function)
    stats: {
        totalRacks: number;
        totalShelves: number;
        totalProducts: number;
    };
}

// /{businessId}/zones/{zoneId}/logs/{logsId}
export interface ZoneLog {
    type: 'created' | 'updated' | 'deleted' | 'restored';
    changes?: {
        [field: string]: { from: any; to: any; };
    };
    note?: string;
    timestamp: Timestamp;
    userId: string;
}

// /{businessId}/racks/{rackId}
export interface Rack {
    id: string;
    name: string;
    code: string;              // e.g.; "R-001"
    isDeleted: boolean;
    deletedAt?: Timestamp;
    createdAt: Timestamp;
    updatedAt: Timestamp;
    createdBy: string;
    updatedBy: string;

    warehouseId: string;
    warehouseName: string;     // Denormalized for display

    zoneId: string;
    zoneName: string;
    position: number;          // Order within zone

    stats: {
        totalShelves: number;
        totalProducts: number;
    };
}

// /{businessId}/racks/{rackId}/logs/{logId}
export interface RackLog {
    type: 'created' | 'updated' | 'deleted' | 'restored' | 'moved';
    changes?: {
        [field: string]: { from: any; to: any; };
    };
    // For 'moved' type
    fromZone?: { id: string; name: string; };
    toZone?: { id: string; name: string; };
    timestamp: Timestamp;
    userId: string;
}

// /{businessId}/shelves/{shelfId}
export interface Shelf {
    id: string;
    name: string;
    code: string;              // e.g.; "S-001"
    capacity?: number;         // Max items/weight
    isDeleted: boolean;
    deletedAt?: Timestamp;
    createdAt: Timestamp;
    updatedAt: Timestamp;
    createdBy: string;
    updatedBy: string;

    warehouseId: string;
    warehouseName: string;     // Denormalized for display

    zoneId: string;
    zoneName: string;

    rackId: string;
    rackName: string;
    position: number;          // Order within rack

    // Full path for easy display
    path: string;              // "Zone A > Rack 1 > Shelf 3"

    stats: {
        totalProducts: number;
        currentOccupancy: number;
    };

    coordinates?: {
        aisle: string;      // "A", "B", "C"
        bay: number;        // 1, 2, 3...
        level: number;      // 1=floor, 2=middle, 3=top
    };
}

// /{businessId}/shelves/{shelfId}/logs/{logId}
export interface ShelfLog {
    type: 'created' | 'updated' | 'deleted' | 'restored' | 'moved';
    changes?: {
        [field: string]: { from: any; to: any; };
    };
    fromRack?: { id: string; name: string; zoneId: string; };
    toRack?: { id: string; name: string; zoneId: string; };
    timestamp: Timestamp;
    userId: string;
}

// /{businessId}/placements/{placementId}
export interface Placement {
    id: string;
    quantity: number;
    createdAt: Timestamp;
    updatedAt: Timestamp;
    createdBy: string;
    updatedBy: string;
    coordinates?: {
        aisle: string;
        bay: number;
        level: number;
    };

    // Product reference
    productId: string;
    productSKU: string;        // Denormalized

    // Location (denormalized for queries)
    warehouseId: string;
    warehouseName: string;     // Denormalized for display

    zoneId: string;
    zoneName: string;

    rackId: string;
    rackName: string;

    shelfId: string;
    shelfName: string;

    // Full location path
    locationPath: string;      // "Zone A > Rack 1 > Shelf 3"

    // Optional context for movement tracking
    lastMovementReason?: string;    // "damaged", "order fulfillment", "stock received"
    lastMovementReference?: string; // orderId, PO number, etc.
}

// /{businessId}/placements/{placementId}/logs/{logId}
export interface PlacementLog {
    type: 'added' | 'removed' | 'quantity_adjusted';
    quantity: number;
    quantityBefore?: number;
    quantityAfter?: number;
    relatedMovementId?: string;  // Links to movements collection
    note?: string;
    timestamp: Timestamp;
    userId: string;
}

// /{businessId}/movements/{movementId}
export interface Movement {
    id: string;

    productId: string;
    productSKU: string;        // Denormalized

    type: 'transfer' | 'inbound' | 'outbound' | 'adjustment';

    from: {
        shelfId: string | null;
        shelfName: string | null;
        rackId: string | null;
        rackName: string | null;
        zoneId: string | null;
        zoneName: string | null;
        warehouseId: string | null;
        warehouseName: string | null;
        path: string | null;       // null for inbound
    };

    to: {
        shelfId: string | null;
        shelfName: string | null;
        rackId: string | null;
        rackName: string | null;
        zoneId: string | null;
        zoneName: string | null;
        warehouseId: string | null;
        warehouseName: string | null;
        path: string | null;       // null for outbound
    };

    quantity: number;
    reason?: string;
    reference?: string;        // Order ID, PO number, etc.

    timestamp: Timestamp;
    userId: string;
    userName: string;
}