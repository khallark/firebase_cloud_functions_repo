/*
 * =============================================================================
 * B2B OMS — DATA MODEL OVERVIEW
 * =============================================================================
 *
 * STRUCTURAL OVERVIEW
 * -------------------
 *
 *  MASTER DATA (reference / configuration)
 *  ├── ProductionStageConfig   — available stage definitions for the business
 *  ├── Buyer                   — the company placing orders
 *  ├── b2bProduct              — the finished garment SKU (a template, not inventory)
 *  ├── RawMaterial             — fabric, trim, thread, etc. (with live stock counts)
 *  └── BOMEntry                — links one b2bProduct to one RawMaterial;
 *                                defines quantity per piece + which stage consumes it
 *
 *  ORDER LIFECYCLE
 *  └── Order                   — buyer-facing commercial agreement
 *      └── Lot (many)          — one production batch of one SKU/color;
 *                                carries its own stage pipeline (TNA embedded)
 *          ├── LotStageHistory (many)     — immutable log, one entry per stage advance
 *          ├── MaterialReservation (many) — one per lot-material pair;
 *          │                                tracks reserved → consumed / released
 *          └── FinishedGood (one)         — created when the lot's last stage completes;
 *                                           represents physical packed inventory
 *
 *  STOCK AUDIT
 *  └── MaterialTransaction (many per RawMaterial)
 *      — append-only log of every stock movement (purchase, reservation,
 *        consumption, return, adjustment)
 *
 * =============================================================================
 *
 * ENTITY CONNECTIONS (via ID fields)
 * -----------------------------------
 *
 *  ProductionStageConfig
 *    — no foreign IDs; referenced loosely by stage name (StageName string)
 *      on LotStage, BOMEntry, and DraftLotInput
 *
 *  Buyer
 *    — no foreign IDs
 *    — referenced by: Order (buyerId), Lot (buyerId), FinishedGood (buyerId)
 *
 *  b2bProduct
 *    — no foreign IDs
 *    — referenced by: BOMEntry (productId), Lot (productId),
 *                     DraftLotInput (productId), FinishedGood (productId)
 *
 *  RawMaterial
 *    — no foreign IDs
 *    — referenced by: BOMEntry (materialId), MaterialReservation (materialId),
 *                     MaterialTransaction (materialId)
 *
 *  BOMEntry
 *    — productId  → b2bProduct
 *    — materialId → RawMaterial
 *
 *  Order
 *    — buyerId → Buyer
 *    — referenced by: Lot (orderId), MaterialReservation (orderId),
 *                     FinishedGood (orderId)
 *
 *  Lot
 *    — orderId  → Order
 *    — buyerId  → Buyer
 *    — productId → b2bProduct
 *    — referenced by: LotStageHistory (lotId), MaterialReservation (lotId),
 *                     FinishedGood (lotId)
 *
 *  LotStageHistory
 *    — lotId   → Lot
 *    — orderId → Order
 *
 *  MaterialReservation
 *    — lotId      → Lot
 *    — orderId    → Order
 *    — materialId → RawMaterial
 *
 *  MaterialTransaction
 *    — materialId  → RawMaterial
 *    — referenceId → Lot | (loose, depends on referenceType)
 *
 *  FinishedGood
 *    — lotId     → Lot
 *    — orderId   → Order
 *    — buyerId   → Buyer
 *    — productId → b2bProduct
 *
 * =============================================================================
 */

import { Timestamp } from "firebase-admin/firestore";

// ============================================================================
// ENUMS
// ============================================================================

export type LotStageStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "BLOCKED";
export type LotStatus = "ACTIVE" | "COMPLETED" | "CANCELLED" | "ON_HOLD";
export type OrderStatus = "DRAFT" | "CONFIRMED" | "IN_PRODUCTION" | "COMPLETED" | "CANCELLED";
export type ReservationStatus = "RESERVED" | "CONSUMED" | "RELEASED";
export type MaterialTransactionType = "PURCHASE" | "CONSUMPTION" | "ADJUSTMENT" | "RETURN" | "RESERVATION";

// All possible stage names — loosely coupled, just strings on the lot
export type StageName =
  | "DESIGN"
  | "FRAMING"
  | "SAMPLING"
  | "CUTTING"
  | "PRINTING"
  | "EMBROIDERY"
  | "STITCHING"
  | "WASHING"
  | "FINISHING"
  | "PACKING";

// ============================================================================
// STAGE CONFIG  (/{businessId}/production_stage_config/{stageId})
// Seed data — defines available stages for the business.
// Lots copy the stage NAME only, not the ID. Loose coupling.
// ============================================================================

export interface ProductionStageConfig {
  id: string;
  name: StageName;
  label: string;                  // "Embroidery", "Color Cut", etc.
  description: string;
  defaultDurationDays: number;    // used to auto-suggest plannedDates at lot creation
  canBeOutsourced: boolean;
  sortOrder: number;              // display order in the stage picker UI
  createdAt: Timestamp;
}

// ============================================================================
// BUYER  (/{businessId}/buyers/{buyerId})
// ============================================================================

export interface Buyer {
  id: string;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  gstNumber: string | null;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================================================
// PRODUCT  (/{businessId}/b2bProducts/{productId})
// The finished garment SKU — not raw material.
// ============================================================================

export interface Product {
  id: string;
  name: string;
  sku: string;
  category: string;               // "Tshirt", "Denim", "Cargo Pants", etc.
  description: string | null;
  defaultStages: StageName[];     // suggested stage sequence for this product type
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================================================
// BOM (Bill of Materials)  (/{businessId}/bom/{bomId})
// One doc per product-material combination.
// Flat — query by productId to get all materials for a product.
// ============================================================================

export interface BOMEntry {
  id: string;
  productId: string;
  productName: string;            // denormalized
  productSku: string;             // denormalized
  materialId: string;
  materialName: string;           // denormalized
  materialUnit: string;           // denormalized: "metres", "pieces", "grams"
  quantityPerPiece: number;       // e.g. 1.2 (metres of fabric per tshirt)
  consumedAtStage: StageName;     // which stage consumes this material
  wastagePercent: number;         // e.g. 5 → add 5% buffer when reserving
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================================================
// RAW MATERIAL  (/{businessId}/raw_materials/{materialId})
// ============================================================================

export interface RawMaterial {
  id: string;
  name: string;
  sku: string;
  unit: string;                   // "metres", "pieces", "kg", "grams"
  category: string;               // "Fabric", "Trim", "Packaging", "Thread"
  totalStock: number;
  reservedStock: number;          // sum of all RESERVED material_reservations
  availableStock: number;         // totalStock - reservedStock (kept in sync via trigger)
  reorderLevel: number;           // alert when availableStock drops below this
  supplierName: string | null;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================================================
// MATERIAL RESERVATION  (/{businessId}/material_reservations/{reservationId})
// Created when a lot is confirmed. One doc per lot-material combination.
// ============================================================================

export interface MaterialReservation {
  id: string;
  lotId: string;
  lotNumber: string;              // denormalized
  orderId: string;
  orderNumber: string;            // denormalized
  materialId: string;
  materialName: string;           // denormalized
  materialUnit: string;           // denormalized
  quantityRequired: number;       // BOM qty × lot quantity + wastage buffer
  quantityConsumed: number;       // incremented when stage is marked complete
  consumedAtStage: StageName;
  status: ReservationStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================================================
// MATERIAL TRANSACTION  (/{businessId}/material_transactions/{txId})
// Audit log for every raw material stock movement.
// ============================================================================

export interface MaterialTransaction {
  id: string;
  materialId: string;
  materialName: string;           // denormalized
  type: MaterialTransactionType;
  quantity: number;               // positive = in, negative = out
  stockBefore: number | null;
  stockAfter: number | null;
  referenceId: string | null;    // lotId, reservationId, PO number, etc.
  referenceType: "LOT" | "PURCHASE_ORDER" | "ADJUSTMENT" | null;
  note: string | null;
  createdBy: string;
  createdAt: Timestamp;
}

// ============================================================================
// LOT STAGE  (embedded in Lot document — not a separate collection)
// The full TNA is embedded here. No separate tna collection needed.
// ============================================================================

export interface LotStage {
  sequence: number;               // 1-based
  stage: StageName;
  plannedDate: Timestamp;
  actualDate: Timestamp | null;
  status: LotStageStatus;
  isOutsourced: boolean;
  outsourceVendorName: string | null;
  outsourceSentAt: Timestamp | null;
  outsourceReturnedAt: Timestamp | null;
  completedBy: string | null;    // worker/supervisor name
  note: string | null;
}

// ============================================================================
// LOT  (/{businessId}/lots/{lotId})
// Core production unit. Each lot = one batch of one SKU/color moving
// through its own defined stage pipeline.
// ============================================================================

export interface Lot {
  id: string;
  lotNumber: string;              // human-readable, e.g. "877"

  // Order linkage (denormalized for queryability)
  orderId: string;
  orderNumber: string;

  // Buyer (denormalized)
  buyerId: string;
  buyerName: string;

  // Product (denormalized)
  productId: string;
  productName: string;
  productSku: string;
  color: string;
  size: string | null;           // if lot is size-specific

  quantity: number;

  // Stage pipeline — defined at creation, fully flexible per lot
  stages: LotStage[];
  currentStage: StageName;
  currentSequence: number;        // 1-based index into stages[]
  totalStages: number;

  // Dispatch tracking
  shipDate: Timestamp;            // committed to buyer
  isDelayed: boolean;             // true if any upcoming stage is behind plannedDate
  delayDays: number;              // how many days behind (0 if on track)

  status: LotStatus;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================================================
// DRAFT LOT INPUT
// Stored on the Order doc while status is DRAFT.
// Set to null by confirmOrder once lots are created.
// Not a collection — just an embedded array on the order.
// ============================================================================

export interface DraftLotInput {
  productId: string;
  productName: string;
  productSku: string;
  color: string;
  size: string | null;
  quantity: number;
  stages: Array<{
    stage: StageName;
    plannedDate: string;          // ISO string — converted to Timestamp by confirmOrder
    isOutsourced: boolean;
    outsourceVendorName: string | null;
  }>;
}

// ============================================================================
// ORDER  (/{businessId}/orders/{orderId})
// Parent of lots. Buyer-facing entity.
// ============================================================================

export interface Order {
  id: string;
  orderNumber: string;            // e.g. "ORD-2026-001"

  buyerId: string;
  buyerName: string;              // denormalized
  buyerContact: string;           // denormalized

  shipDate: Timestamp;            // overall ship date for the order
  deliveryAddress: string;

  // Only present while status === "DRAFT".
  // Set to null by confirmOrder once lots are created.
  draftLots: DraftLotInput[] | null;

  // Aggregated lot stats (kept in sync via onDocumentWritten on lots)
  totalLots: number;
  totalQuantity: number;
  lotsCompleted: number;
  lotsInProduction: number;
  lotsDelayed: number;

  status: OrderStatus;
  note: string | null;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================================================
// FINISHED GOODS  (/{businessId}/finished_goods/{finishedGoodId})
// Created when a lot's final stage (PACKING) is marked complete.
// Ready for dispatch.
// ============================================================================

export interface FinishedGood {
  id: string;
  lotId: string;
  lotNumber: string;              // denormalized
  orderId: string;
  orderNumber: string;            // denormalized
  buyerId: string;
  buyerName: string;              // denormalized
  productId: string;
  productName: string;            // denormalized
  productSku: string;             // denormalized
  color: string;
  size: string | null;
  quantity: number;
  cartonCount: number | null;
  totalWeightKg: number | null;
  packedAt: Timestamp;
  dispatchedAt: Timestamp | null;
  isDispatched: boolean;
  courierName: string | null;    // handoff to Majime
  awb: string | null;            // filled by Majime after dispatch
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================================================
// LOT STAGE HISTORY  (/{businessId}/lot_stage_history/{historyId})
// Immutable audit log — one doc written every time a lot moves stages.
// Separate from the lot doc so the lot stays lean.
// ============================================================================

export interface LotStageHistory {
  id: string;
  lotId: string;
  lotNumber: string;              // denormalized
  orderId: string;
  fromStage: StageName | null;    // null for first stage entry
  toStage: StageName;
  fromSequence: number | null;
  toSequence: number;
  movedBy: string;
  movedAt: Timestamp;
  note: string | null;
}