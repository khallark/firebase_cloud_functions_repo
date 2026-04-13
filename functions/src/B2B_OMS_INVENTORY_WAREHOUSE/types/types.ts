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

/** Only two transaction types remain — no reservation / consumption / return. */
export type MaterialTransactionType = "PURCHASE" | "ADJUSTMENT";

export type StageName =
  | "DESIGN" | "FRAMING" | "SAMPLING" | "CUTTING"
  | "PRINTING" | "EMBROIDERY" | "STITCHING"
  | "WASHING" | "FINISHING" | "PACKING";

// ============================================================================
// STAGE CONFIG  (users/{businessId}/production_stage_config/{stageId})
// ============================================================================

export interface ProductionStageConfig {
  id: string;
  name: StageName;
  label: string;
  description: string;
  defaultDurationDays: number;
  canBeOutsourced: boolean;
  sortOrder: number;
  createdAt: Timestamp;
}

// ============================================================================
// BUYER  (users/{businessId}/buyers/{buyerId})
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
// PRODUCT  (users/{businessId}/b2bProducts/{productId})
// ============================================================================

export interface Product {
  id: string;
  name: string;
  sku: string;
  category: string;
  description: string | null;
  defaultStages: StageName[];
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================================================
// BOM — RESTRUCTURED  (users/{businessId}/bom/{bomId})
//
// One BOM doc per product.  At most one active BOM per product at any time.
// Each BOM defines which raw materials are consumed at which stage.
// Same material may appear in multiple stages.
// ============================================================================

export interface BOMStageItem {
  materialId: string;
  materialName: string;     // denormalized
  materialUnit: string;     // denormalized: "metres", "kg", etc.
  quantityPerPiece: number; // how much of this material per finished piece
  wastagePercent: number;   // buffer % added on top when snapshotting
}

export interface BOMStage {
  stage: StageName;
  materials: BOMStageItem[];
}

export interface BOM {
  id: string;
  productId: string;
  productName: string;  // denormalized
  productSku: string;   // denormalized
  stages: BOMStage[];   // ordered list of stages with their material requirements
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================================================
// LOT BOM SNAPSHOT  (embedded inside Lot — not a separate collection)
//
// A snapshot of the BOM is taken at the moment a lot is confirmed / created.
// This freezes the material requirements regardless of future BOM edits.
// ============================================================================

export interface LotBOMItem {
  materialId: string;
  materialName: string;
  materialUnit: string;
  quantityPerPiece: number;
  wastagePercent: number;
  totalQuantity: number;  // quantityPerPiece × lotQuantity × (1 + wastagePercent/100)
}

export interface LotBOMStage {
  stage: StageName;
  materials: LotBOMItem[];
}

// ============================================================================
// RAW MATERIAL  (users/{businessId}/raw_materials/{materialId})
//
// No reservedStock field anymore.  availableStock === totalStock always.
// ============================================================================

export interface RawMaterial {
  id: string;
  name: string;
  sku: string;
  unit: string;
  category: string;
  totalStock: number;
  availableStock: number;  // kept in sync by add-stock / adjust-stock; no reservations
  reorderLevel: number;
  supplierName: string | null;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================================================
// MATERIAL TRANSACTION  (users/{businessId}/material_transactions/{txId})
//
// Append-only audit log.  Only PURCHASE (add-stock) and ADJUSTMENT (adjust-stock)
// are written now.  Reservation / consumption / return transactions are gone.
// ============================================================================

export interface MaterialTransaction {
  id: string;
  materialId: string;
  materialName: string;
  type: MaterialTransactionType;
  quantity: number;
  stockBefore: number;
  stockAfter: number;
  referenceId: string | null;
  referenceType: "PURCHASE_ORDER" | "ADJUSTMENT" | null;
  note: string | null;
  createdBy: string;
  createdAt: Timestamp;
}

// ============================================================================
// LOT STAGE  (embedded in Lot)
// ============================================================================

export interface LotStage {
  sequence: number;
  stage: StageName;
  plannedDate: Timestamp;
  actualDate: Timestamp | null;
  status: LotStageStatus;
  isOutsourced: boolean;
  outsourceVendorName: string | null;
  outsourceSentAt: Timestamp | null;
  outsourceReturnedAt: Timestamp | null;
  completedBy: string | null;
  note: string | null;
}

// ============================================================================
// LOT  (users/{businessId}/lots/{lotId})
// ============================================================================

export interface Lot {
  id: string;
  lotNumber: string;

  orderId: string;
  orderNumber: string;

  buyerId: string;
  buyerName: string;

  productId: string;
  productName: string;
  productSku: string;
  color: string;
  size: string | null;
  quantity: number;

  stages: LotStage[];
  currentStage: StageName;
  currentSequence: number;
  totalStages: number;

  shipDate: Timestamp;
  isDelayed: boolean;
  delayDays: number;

  /** Which predefined BOM doc was used.  null if the user supplied a custom BOM. */
  bomId: string | null;
  /** Snapshot of material requirements captured at lot creation time. */
  bomSnapshot: LotBOMStage[];

  status: LotStatus;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================================================
// DRAFT LOT INPUT  (embedded array on Order while status === DRAFT)
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
    plannedDate: string;  // ISO string
    isOutsourced: boolean;
    outsourceVendorName: string | null;
  }>;
  /** ID of the predefined BOM to use.  null means the user is supplying a custom BOM. */
  bomId: string | null;
  /**
   * Inline BOM supplied by the user when bomId is null.
   * Populated from the order-creation UI.  May be an empty array if the
   * user chose not to track materials for this lot.
   */
  customBOM: LotBOMStage[] | null;
}

// ============================================================================
// ORDER  (users/{businessId}/orders/{orderId})
// ============================================================================

export interface Order {
  id: string;
  orderNumber: string;

  buyerId: string;
  buyerName: string;
  buyerContact: string;

  shipDate: Timestamp;
  deliveryAddress: string;

  draftLots: DraftLotInput[] | null;

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
// FINISHED GOOD  (users/{businessId}/finished_goods/{finishedGoodId})
// ============================================================================

export interface FinishedGood {
  id: string;
  lotId: string;
  lotNumber: string;
  orderId: string;
  orderNumber: string;
  buyerId: string;
  buyerName: string;
  productId: string;
  productName: string;
  productSku: string;
  color: string;
  size: string | null;
  quantity: number;
  cartonCount: number | null;
  totalWeightKg: number | null;
  packedAt: Timestamp;
  dispatchedAt: Timestamp | null;
  isDispatched: boolean;
  courierName: string | null;
  awb: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================================================
// LOT STAGE HISTORY  (users/{businessId}/lot_stage_history/{historyId})
// ============================================================================

export interface LotStageHistory {
  id: string;
  lotId: string;
  lotNumber: string;
  orderId: string;
  fromStage: StageName | null;
  toStage: StageName;
  fromSequence: number | null;
  toSequence: number;
  movedBy: string | null;
  movedAt: Timestamp;
  note: string | null;
}
