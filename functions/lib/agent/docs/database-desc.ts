// import { Timestamp } from "firebase-admin/firestore";

// // =============================================================================
// // WAREHOUSE MODULE — database-desc.ts
// // =============================================================================
// // This module describes every Firestore collection in the Warehouse domain.
// //
// // COLLECTION READ ORDER (most analytically important first):
// //   products → purchaseOrders → grns → upcs → placements
// //   → upcsLogs → inventory_snapshots → parties
// //   → warehouses → zones → racks → shelves
// //
// // FIELD ORDERING WITHIN EACH COLLECTION:
// //   1. Identity fields (document ID, human-readable label)
// //   2. Status / lifecycle (the primary filter field)
// //   3. Foreign keys / relationships (what this doc links to)
// //   4. Core data fields (quantities, amounts, computed totals)
// //   5. Embedded arrays (flattened for per-item analytics)
// //   6. Date fields used for range filtering
// //   7. Metadata (createdAt/By, updatedAt/By) — rarely queried
// //   8. Internal / versioning fields — never query
// //
// // QUERY INTENSITY TAGS (used per field):
// //   QUERY: HIGH   — frequently filtered, grouped, or sorted on
// //   QUERY: MEDIUM — occasionally filtered or used in joins
// //   QUERY: LOW    — display / informational only; avoid in queries
// //   QUERY: NEVER  — internal/trigger field; not useful analytically
// // =============================================================================
 
// interface Business {
//     B2B: {
//         /**
//          * Path: users/{businessId}/b2b/bom/{bomId}
//          */
//         bom: {
//             /**
//              * 
//              */
//             id: string;
//             /**
//              * 
//              */
//             productId: string;
//             /**
//              * 
//              */
//             productName: string;
//             /**
//              * 
//              */
//             productSku: string;
//             /**
//              * 
//              */
//             stages: {
//                 /**
//                  * 
//                  */
//                 stage: string;
//                 /**
//                  * 
//                  */
//                 materials: {
//                     /**
//                      * 
//                      */
//                     materialId: string;
//                     /**
//                      * 
//                      */
//                     materialName: string;
//                     /**
//                      * 
//                      */
//                     materialUnit: string;
//                     /**
//                      * 
//                      */
//                     quantityPerPiece: number;
//                     /**
//                      * 
//                      */
//                     wastagePercent: number;
//                 }[];
//             }[];
//             /**
//              * 
//              */
//             isActive: boolean;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//             /**
//              * 
//              */
//             updatedAt: Timestamp;
//         };
//         /**
//          * Path: users/{businessId}/b2b/buyers/{buyerId}
//          */
//         buyers: {
//             /**
//              * 
//              */
//             id: string;
//             /**
//              * 
//              */
//             name: string;
//             /**
//              * 
//              */
//             contactPerson: string;
//             /**
//              * 
//              */
//             phone: string;
//             /**
//              * 
//              */
//             email: string;
//             /**
//              * 
//              */
//             address: string;
//             /**
//              * 
//              */
//             gstNumber: string | null;
//             /**
//              * 
//              */
//             isActive: boolean;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//             /**
//              * 
//              */
//             updatedAt: Timestamp;
//         };
//         /**
//          * Path: users/{businessId}/b2b/finished_goods/{finished_good_id}
//          */
//         finished_goods: {
//             /**
//              * 
//              */
//             id: string;
//             /**
//              * 
//              */
//             lotId: string;
//             /**
//              * 
//              */
//             lotNumber: string;
//             /**
//              * 
//              */
//             orderId: string;
//             /**
//              * 
//              */
//             orderNumber: string;
//             /**
//              * 
//              */
//             buyerId: string;
//             /**
//              * 
//              */
//             buyerName: string;
//             /**
//              * 
//              */
//             productId: string;
//             /**
//              * 
//              */
//             productName: string;
//             /**
//              * 
//              */
//             productSku: string;
//             /**
//              * 
//              */
//             color: string;
//             /**
//              * 
//              */
//             size: string | null;
//             /**
//              * 
//              */
//             quantity: number;
//             /**
//              * 
//              */
//             cartonCount: number | null;
//             /**
//              * 
//              */
//             totalWeightKg: number | null;
//             /**
//              * 
//              */
//             packedAt: Timestamp;
//             /**
//              * 
//              */
//             dispatchedAt: Timestamp | null;
//             /**
//              * 
//              */
//             isDispatched: boolean;
//             /**
//              * 
//              */
//             courierName: string | null;
//             /**
//              * 
//              */
//             awb: string | null;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//             /**
//              * 
//              */
//             updatedAt: Timestamp;
//         };
//         /**
//          * Path: users/{businessId}/b2b/lot_stage_history/{lot_stage_history_id}
//          */
//         lot_stage_history: {
//             /**
//              * 
//              */
//             id: string;
//             /**
//              * 
//              */
//             lotId: string;
//             /**
//              * 
//              */
//             lotNumber: string;
//             /**
//              * 
//              */
//             orderId: string;
//             /**
//              * 
//              */
//             fromStage: string | null;
//             /**
//              * 
//              */
//             toStage: string;
//             /**
//              * 
//              */
//             fromSequence: number | null;
//             /**
//              * 
//              */
//             toSequence: number;
//             /**
//              * 
//              */
//             movedBy: string | null;
//             /**
//              * 
//              */
//             movedAt: Timestamp;
//             /**
//              * 
//              */
//             note: string | null;
//         };
//         /**
//          * Path: users/{businessId}/b2b/lots/{lotId}
//          */
//         lots: {
//             /**
//              * 
//              */
//             id: string;
//             /**
//              * 
//              */
//             lotNumber: string;
//             /**
//              * 
//              */
//             orderId: string;
//             /**
//              * 
//              */
//             orderNumber: string;
//             /**
//              * 
//              */
//             buyerId: string;
//             /**
//              * 
//              */
//             buyerName: string;
//             /**
//              * 
//              */
//             productId: string;
//             /**
//              * 
//              */
//             productName: string;
//             /**
//              * 
//              */
//             productSku: string;
//             /**
//              * 
//              */
//             color: string;
//             /**
//              * 
//              */
//             size: string | null;
//             /**
//              * 
//              */
//             quantity: number;
//             /**
//              * 
//              */
//             stages: {
//                 /**
//                  * 
//                  */
//                 sequence: number;
//                 /**
//                  * 
//                  */
//                 stage: string;
//                 /**
//                  * 
//                  */
//                 plannedDate: Timestamp;
//                 /**
//                  * 
//                  */
//                 actualDate: Timestamp | null;
//                 /**
//                  * 
//                  */
//                 status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "BLOCKED";
//                 /**
//                  * 
//                  */
//                 isOutsourced: boolean;
//                 /**
//                  * 
//                  */
//                 outsourceVendorName: string | null;
//                 /**
//                  * 
//                  */
//                 outsourceSentAt: Timestamp | null;
//                 /**
//                  * 
//                  */
//                 outsourceReturnedAt: Timestamp | null;
//                 /**
//                  * 
//                  */
//                 completedBy: string | null;
//                 /**
//                  * 
//                  */
//                 note: string | null;
//             }[];
//             /**
//              * 
//              */
//             currentStage: string;
//             /**
//              * 
//              */
//             currentSequence: number;
//             /**
//              * 
//              */
//             totalStages: number;
//             /**
//              * 
//              */
//             shipDate: Timestamp;
//             /**
//              * 
//              */
//             isDelayed: boolean;
//             /**
//              * 
//              */
//             delayDays: number;
//             /**
//              * 
//              */
//             bomId: string | null;
//             /**
//              * 
//              */
//             bomSnapshot: {
//                 /**
//                  * 
//                  */
//                 stage: string;
//                 /**
//                  * 
//                  */
//                 materials: {
//                     /**
//                      * 
//                      */
//                     materialId: string;
//                     /**
//                      * 
//                      */
//                     materialName: string;
//                     /**
//                      * 
//                      */
//                     materialUnit: string;
//                     /**
//                      * 
//                      */
//                     quantityPerPiece: number;
//                     /**
//                      * 
//                      */
//                     wastagePercent: number;
//                     /**
//                      * 
//                      */
//                     totalQuantity: number;
//                 }[];
//             }[];
//             /**
//              * 
//              */
//             status: "ACTIVE" | "COMPLETED" | "CANCELLED" | "ON_HOLD";
//             /**
//              * 
//              */
//             createdBy: string;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//             /**
//              * 
//              */
//             updatedAt: Timestamp;
//         };
//         /**
//          * Path: users/{businessId}/b2b/material_transactions/{material_transactions_id}
//          */
//         material_transactions: {
//             /**
//              * 
//              */
//             id: string;
//             /**
//              * 
//              */
//             materialId: string;
//             /**
//              * 
//              */
//             materialName: string;
//             /**
//              * 
//              */
//             type: "PURCHASE" | "ADJUSTMENT";
//             /**
//              * 
//              */
//             quantity: number;
//             /**
//              * 
//              */
//             stockBefore: number;
//             /**
//              * 
//              */
//             stockAfter: number;
//             /**
//              * 
//              */
//             referenceId: string | null;
//             /**
//              * 
//              */
//             referenceType: "PURCHASE" | "ADJUSTMENT" | null;
//             /**
//              * 
//              */
//             note: string | null;
//             /**
//              * 
//              */
//             createdBy: string;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//         };
//         /**
//          * Path: users/{businessId}/b2b/orders/{orderId}
//          */
//         orders: {
//             /**
//              * 
//              */
//             id: string;
//             /**
//              * 
//              */
//             orderNumber: string;
//             /**
//              * 
//              */
//             buyerId: string;
//             /**
//              * 
//              */
//             buyerName: string;
//             /**
//              * 
//              */
//             buyerContact: string;
//             /**
//              * 
//              */
//             shipDate: Timestamp;
//             /**
//              * 
//              */
//             deliveryAddress: string;
//             /**
//              * 
//              */
//             draftLots: {
//                 /**
//                  * 
//                  */
//                 productId: string;
//                 /**
//                  * 
//                  */
//                 productName: string;
//                 /**
//                  * 
//                  */
//                 productSku: string;
//                 /**
//                  * 
//                  */
//                 color: string;
//                 /**
//                  * 
//                  */
//                 size: string | null;
//                 /**
//                  * 
//                  */
//                 quantity: number;
//                 /**
//                  * 
//                  */
//                 stages: Array<{
//                     /**
//                      * 
//                      */
//                     stage: string;
//                     /**
//                      * 
//                      */
//                     plannedDate: string;  // ISO string
//                     /**
//                      * 
//                      */
//                     isOutsourced: boolean;
//                     /**
//                      * 
//                      */
//                     outsourceVendorName: string | null;
//                 }>;
//                 /**
//                  * 
//                  */
//                 bomId: string | null;
//                 /**
//                  * 
//                  */
//                 customBOM: {
//                     /**
//                      * 
//                      */
//                     stage: string;
//                     /**
//                      * 
//                      */
//                     materials: {
//                         /**
//                          * 
//                          */
//                         materialId: string;
//                         /**
//                          * 
//                          */
//                         materialName: string;
//                         /**
//                          * 
//                          */
//                         materialUnit: string;
//                         /**
//                          * 
//                          */
//                         quantityPerPiece: number;
//                         /**
//                          * 
//                          */
//                         wastagePercent: number;
//                         /**
//                          * 
//                          */
//                         totalQuantity: number;
//                     }[];
//                 }[] | null;
//             }[] | null;
//             /**
//              * 
//              */
//             totalLots: number;
//             /**
//              * 
//              */
//             totalQuantity: number;
//             /**
//              * 
//              */
//             lotsCompleted: number;
//             /**
//              * 
//              */
//             lotsInProduction: number;
//             /**
//              * 
//              */
//             lotsDelayed: number;
//             /**
//              * 
//              */
//             status: "DRAFT" | "CONFIRMED" | "IN_PRODUCTION" | "COMPLETED" | "CANCELLED";
//             /**
//              * 
//              */
//             note: string | null;
//             /**
//              * 
//              */
//             createdBy: string;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//             /**
//              * 
//              */
//             updatedAt: Timestamp;
//         };
//         /**
//          * Path: users/{businessId}/b2b/production_stage_config/{production_stage_config_id}
//          */
//         production_stage_config: {
//             /**
//              * 
//              */
//             id: string;
//             /**
//              * 
//              */
//             name: string;
//             /**
//              * 
//              */
//             label: string;
//             /**
//              * 
//              */
//             description: string;
//             /**
//              * 
//              */
//             defaultDurationDays: number;
//             /**
//              * 
//              */
//             canBeOutsourced: boolean;
//             /**
//              * 
//              */
//             sortOrder: number;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//         };
//         /**
//          * Path: users/{businessId}/b2b/raw_materials/{raw_material_id}
//          */
//         raw_materials: {
//             /**
//              * 
//              */
//             id: string;
//             /**
//              * 
//              */
//             name: string;
//             /**
//              * 
//              */
//             sku: string;
//             /**
//              * 
//              */
//             unit: string;
//             /**
//              * 
//              */
//             category: string;
//             /**
//              * 
//              */
//             totalStock: number;
//             /**
//              * 
//              */
//             availableStock: number;
//             /**
//              * 
//              */
//             reorderLevel: number;
//             /**
//              * 
//              */
//             supplierName: string | null;
//             /**
//              * 
//              */
//             isActive: boolean;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//             /**
//              * 
//              */
//             updatedAt: Timestamp;
//         };
//     };
//     /**
//      * Warehouse module — all collections related to physical inventory,
//      * warehouse structure, stock management, procurement, and UPC tracking.
//      */
//     Warehouse: {
 
//         // =====================================================================
//         // COLLECTION: products
//         // Path: users/{businessId}/products/{sku}
//         // =====================================================================
//         // The central product record for the warehouse system. Document ID = SKU.
//         // Every other warehouse entity (UPCs, placements, GRNs, PO items,
//         // inventory snapshots) references this document via the `sku` / `productId` field.
//         //
//         // STOCK FORMULAS (derive from inventory counters — never store separately):
//         //   physicalStock  = openingStock + inwardAddition + autoAddition
//         //                    - deduction - autoDeduction
//         //   availableStock = physicalStock - blockedStock
//         //   inShelfQuantity is a separately maintained real-time count of units
//         //   physically sitting on shelves (putAway: "none"), distinct from physicalStock.
//         //
//         // CHANGE FLOW:
//         //   An order item change → check if mapped to this product via mappedVariants
//         //     → (yes) UPC doc update → onUpcWritten trigger → updates inventory counters here
//         //     → (no)  nothing
//         //
//         // TYPICAL QUERIES:
//         //   - Fetch all products for a category filter
//         //   - Look up price/taxRate/hsn for gross profit calculations
//         //   - Read inShelfQuantity to check pickup eligibility
//         //   - Read inventory counters to compute physicalStock / availableStock
//         // =====================================================================
//         products: {
 
//             // -- IDENTITY -----------------------------------------------------
 
//             /**
//              * Unique product SKU. Also the Firestore document ID.
//              * Always uppercase (e.g. "TSHIRT-BLU-M").
//              * This is the primary join key — referenced as `productId` on UPCs,
//              * placements, inventory_snapshots, GRN items, and PO items.
//              * QUERY: HIGH — use as an equality filter when looking up a specific product.
//              */
//             sku: string;
 
//             /**
//              * Human-readable product name (e.g. "Cotton Crew Neck T-Shirt – Blue M").
//              * QUERY: LOW — display only; search by sku instead.
//              */
//             name: string;
 
//             /**
//              * Product category (e.g. "T-Shirts", "Denim", "Accessories").
//              * QUERY: HIGH — group by category for category-level inventory or sales reports.
//              *               Filter by category to narrow product lists.
//              */
//             category: string;
 
//             // -- LIVE STOCK COUNTS --------------------------------------------
 
//             /**
//              * Real-time count of units physically sitting on warehouse shelves
//              * and immediately available for pickup (putAway == "none").
//              * Incremented when any UPC for this product transitions to putAway "none";
//              * decremented when any UPC leaves "none" (picked up or moved out).
//              * Used by the order pickup flow to determine if a Confirmed order
//              * has enough physical units to proceed.
//              * NOTE: Reflects shelf stock only — does not include inbound units (awaiting put-away).
//              *       physicalStock (computed from inventory counters) is the authoritative total.
//              * QUERY: HIGH — filter inShelfQuantity > 0 to find products available for pickup;
//              *               sort descending to see most stocked items.
//              */
//             inShelfQuantity: number;
 
//             /**
//              * Embedded inventory counters maintained exclusively by Firestore triggers.
//              * Never update these directly. Use them to derive physicalStock and availableStock.
//              * All fields are cumulative running totals — they are never reset.
//              * QUERY: MEDIUM — read as a group to compute stock figures; individual sub-fields
//              *                 are rarely useful as Firestore filters in isolation.
//              */
//             inventory: {
 
//                 /**
//                  * Always initialized to 0 and has no role in stock computation.
//                  * Retained for schema consistency only. Will be deprecated.
//                  * QUERY: NEVER
//                  */
//                 openingStock: number;
 
//                 /**
//                  * Cumulative units received into stock from GRN put-away.
//                  * Incremented when a GRN-sourced UPC (grnRef set, no storeId/orderId)
//                  * transitions from putAway "inbound" → "none".
//                  * This is the primary source of net-new stock from supplier purchases.
//                  * QUERY: NEVER — use totalReceivedValue on GRN docs for purchase analytics instead.
//                  */
//                 inwardAddition: number;
 
//                 /**
//                  * Cumulative units deducted via credit note dispatch.
//                  * Incremented by onUpcWritten when a UPC transitions outbound → null
//                  * and creditNoteRef is set on that UPC.
//                  * Unlike autoDeduction, no blockedStock change accompanies this counter.
//                  * QUERY: NEVER — use the credit_notes collection for CN analytics instead.
//                  */
//                 deduction: number;
 
//                 /**
//                  * Cumulative units deducted when an order shipment leaves the warehouse.
//                  * Incremented by onUpcWritten when a UPC transitions outbound → null
//                  * and creditNoteRef is absent (i.e., the unit was dispatched via courier).
//                  * Always decremented alongside blockedStock.
//                  * QUERY: NEVER — use order collections for sales analytics instead.
//                  */
//                 autoDeduction: number;
 
//                 /**
//                  * Cumulative units added back from order returns
//                  * (RTO Closed and Pending Refunds QC Pass flows).
//                  * Incremented by onUpcWritten when a UPC with storeId + orderId set
//                  * transitions to putAway "inbound".
//                  * QUERY: NEVER — use order return statuses for return analytics instead.
//                  */
//                 autoAddition: number;
 
//                 /**
//                  * Units currently reserved by active orders (New, Confirmed, Ready To Dispatch).
//                  * Incremented when an order enters an active status for a mapped variant;
//                  * decremented on dispatch or cancellation.
//                  * Managed by the updateOrderCounts trigger and fully recomputed by
//                  * onProductWritten whenever mappedVariants changes.
//                  * Used in formula: availableStock = physicalStock - blockedStock.
//                  * QUERY: NEVER — read as part of the inventory object; not a useful filter in isolation.
//                  */
//                 blockedStock: number;
//             };
 
//             /**
//              * Shopify variant mappings for this product. Each entry links this SKU
//              * to one variant on one Shopify store. A product can map to many variants
//              * across many stores simultaneously.
//              *
//              * This mapping drives three things:
//              *   1. Inventory blocking: when a mapped variant's order arrives, blockedStock increments.
//              *   2. Shopify sync: onProductWritten pushes stock levels to Shopify on mapping change.
//              *   3. UPC assignment: during order pickup, UPCs are linked to the order via storeId/orderId.
//              *
//              * The same mapping is stored bidirectionally on accounts/{storeId}/products/{productId}
//              * under variantMappingDetails[variantId].
//              *
//              * QUERY: MEDIUM — rarely filtered directly; used for cross-referencing orders to products.
//              */
//             mappedVariants: {
//                 /**
//                  * Shopify store domain (e.g. "my-store.myshopify.com").
//                  * Links to accounts/{storeId}. Use alongside variantId to locate order line items.
//                  * QUERY: MEDIUM — filter by storeId when scoping to a single store's products.
//                  */
//                 storeId: string;
 
//                 /**
//                  * Shopify variant ID (numeric). Primary join key between order line items and products.
//                  * Order line items carry this as raw.line_items[].variant_id.
//                  * To resolve a line item to a business product:
//                  *   accounts/{storeId}/products/{productId}.variantMappingDetails[variantId].businessProductSku
//                  * QUERY: MEDIUM — equality filter when tracing a specific variant back to its SKU.
//                  */
//                 variantId: number;
 
//                 /**
//                  * Shopify product document ID.
//                  * Links to accounts/{storeId}/products/{productId}.
//                  * QUERY: LOW — only needed when reading the store-side product document.
//                  */
//                 productId: string;
 
//                 /**
//                  * Shopify product title (denormalized). Display only.
//                  * QUERY: NEVER
//                  */
//                 productTitle: string;
 
//                 /**
//                  * Shopify variant SKU (denormalized). May differ from the business SKU.
//                  * QUERY: NEVER
//                  */
//                 variantSku: string;
 
//                 /**
//                  * Shopify variant title (e.g. "Blue / M"). Display only.
//                  * QUERY: NEVER
//                  */
//                 variantTitle: string;
 
//                 /**
//                  * ISO string timestamp of when this variant was mapped to this product.
//                  * QUERY: LOW — can sort mappings by date if needed.
//                  */
//                 mappedAt: string;
//             }[];
 
//             // -- FINANCIAL / LOGISTICS ATTRIBUTES ----------------------------
 
//             /**
//              * COGS (Cost of Goods Sold) per unit in INR, ex-tax.
//              * Used in the gross profit report for opening stock and closing stock valuation.
//              * QUERY: MEDIUM — read when computing stock value; multiply by physicalStock.
//              */
//             price: number;

//             /**
//              * GST tax rate as a percentage (e.g. 5, 12, 18, 28).
//              * Applied as: taxable_amount × taxRate / 100.
//              * Used in GRN bill PDFs and the gross profit Purchase row tax calculation.
//              * QUERY: MEDIUM — read when computing tax-inclusive purchase values.
//              */
//             taxRate: number;
 
//             /**
//              * HSN (Harmonised System of Nomenclature) code for GST classification.
//              * Always uppercase (e.g. "6109"). Used in GRN bills, tax reports, and GP reports.
//              * QUERY: MEDIUM — group by hsn for HSN-level tax summaries.
//              */
//             hsn: string;
 
//             /**
//              * Product weight in grams. Used in courier weight calculations during dispatch.
//              * QUERY: LOW — informational; rarely filtered analytically.
//              */
//             weight: number;
 
//             /**
//              * Optional free-text description. May be null.
//              * QUERY: NEVER — display only.
//              */
//             description: string | null;
 
//             // -- METADATA -----------------------------------------------------
 
//             /**
//              * Firestore Timestamp. When this product doc was first created.
//              * QUERY: LOW — can filter products created in a date range.
//              */
//             createdAt: Timestamp;
 
//             /**
//              * UID of the user who created this product.
//              * QUERY: NEVER
//              */
//             createdBy: string;
 
//             /**
//              * Firestore Timestamp. When this product was last updated.
//              * QUERY: NEVER
//              */
//             updatedAt: Timestamp;
 
//             /**
//              * UID of the user who last updated this product.
//              * QUERY: NEVER
//              */
//             updatedBy: string;
//         };
 
 
//         // =====================================================================
//         // COLLECTION: purchaseOrders
//         // Path: users/{businessId}/purchaseOrders/{poId}
//         // =====================================================================
//         // A Purchase Order (PO) represents a planned procurement from a supplier.
//         // POs are the prerequisite for GRN creation — a GRN can only be raised
//         // against a PO in "confirmed" or "partially_received" status.
//         // As GRNs are confirmed, they write back into items[].receivedQty here
//         // and the system recalculates the PO's overall status.
//         //
//         // RELATIONSHIPS:
//         //   supplierPartyId → users/{businessId}/parties/{partyId}
//         //   warehouseId     → users/{businessId}/warehouses/{warehouseId}
//         //   items[].sku     → users/{businessId}/products/{sku}
//         //   Referenced by   → users/{businessId}/grns/{grnId}.poId
//         //
//         // TYPICAL QUERIES:
//         //   - Filter by status to find open/pending POs
//         //   - Filter by supplierPartyId to see all POs for a supplier
//         //   - Filter orderedSkus array-contains to find POs for a specific product
//         //   - Sum totalAmount for total purchase commitment in a date range
//         // =====================================================================
//         purchaseOrders: {
 
//             // -- IDENTITY -----------------------------------------------------
 
//             /**
//              * Firestore document ID of this PO.
//              * QUERY: MEDIUM — equality filter when looking up a specific PO.
//              */
//             id: string;
 
//             /**
//              * Human-readable PO number (e.g. "PO-00042"). Auto-generated sequentially.
//              * Denormalized onto grns.poNumber so GRN lists display the PO reference
//              * without an extra read.
//              * QUERY: MEDIUM — equality filter when the user searches by PO number.
//              */
//             poNumber: string;
 
//             /**
//              * The business this PO belongs to. Always matches the path segment.
//              * QUERY: NEVER — implicit in the collection path.
//              */
//             businessId: string;
 
//             // -- STATUS -------------------------------------------------------
 
//             /**
//              * Current lifecycle status.
//              * "draft"              — created, not yet approved or sent to supplier.
//              * "confirmed"          — approved; GRNs can now be raised against this PO.
//              * "partially_received" — at least one item partially received across one or more GRNs.
//              * "fully_received"     — all items fully received (receivedQty >= expectedQty).
//              * "closed"             — manually closed; no further GRNs accepted.
//              * "cancelled"          — voided; no GRNs allowed.
//              * QUERY: HIGH — primary filter. Filter status == "confirmed" | "partially_received"
//              *               to find open POs. Filter "cancelled" | "closed" for historical analysis.
//              */
//             status: 'draft' | 'confirmed' | 'partially_received' | 'fully_received' | 'closed' | 'cancelled';
 
//             // -- RELATIONSHIPS ------------------------------------------------
 
//             /**
//              * Supplier party ID. Links to users/{businessId}/parties/{partyId}.
//              * Must be a party with type "supplier" or "both" and isActive: true at creation time.
//              * QUERY: HIGH — filter by supplierPartyId to see all POs from a specific supplier.
//              *               Group by supplierPartyId for per-supplier purchase summaries.
//              */
//             supplierPartyId: string;
 
//             /**
//              * Denormalized supplier name from parties.name.
//              * Stored to avoid a join when rendering PO lists.
//              * QUERY: LOW — use supplierPartyId for filtering; name is for display.
//              */
//             supplierName: string;
 
//             /**
//              * ID of the destination warehouse. Links to users/{businessId}/warehouses/{warehouseId}.
//              * QUERY: MEDIUM — filter by warehouseId to scope POs to a specific warehouse.
//              */
//             warehouseId: string;
 
//             /**
//              * Denormalized warehouse name. Null if not available at creation time.
//              * QUERY: NEVER — display only.
//              */
//             warehouseName: string | null;
 
//             // -- CORE DATA ----------------------------------------------------
 
//             /**
//              * Flat array of all SKUs in this PO (one entry per distinct SKU in items[]).
//              * Useful for "which POs include SKU X?" without flattening items[].
//              * Each value links to users/{businessId}/products/{sku}.
//              * QUERY: HIGH — use array-contains filter: orderedSkus array-contains "SKU-X"
//              *               to find all POs that include a given product.
//              */
//             orderedSkus: string[];
 
//             /**
//              * Count of distinct SKUs ordered. Always equals items.length.
//              * QUERY: LOW — informational count; rarely filtered on.
//              */
//             itemCount: number;
 
//             /**
//              * Total PO value: sum of (items[].expectedQty × items[].unitCost).
//              * Pre-computed at creation and on edits. Use directly — do not recompute.
//              * Does not include tax.
//              * QUERY: MEDIUM — sum this field across filtered POs for total purchase commitment.
//              */
//             totalAmount: number;
 
//             /**
//              * Currency code (e.g. "INR"). Null if not specified (defaults to INR in practice).
//              * QUERY: NEVER — all values are INR in practice.
//              */
//             currency: string | null;
 
//             // -- EMBEDDED ITEMS -----------------------------------------------
 
//             /**
//              * Line items — one entry per distinct SKU ordered.
//              * Updated in place by the GRN confirmation flow (receivedQty and notReceivedQty
//              * are incremented each time a GRN against this PO is completed).
//              * Flatten with flattenArrayField("items") to aggregate at the item level.
//              * QUERY: MEDIUM — flatten and groupBy sku for per-product received quantity analysis.
//              */
//             items: {
//                 /**
//                  * Product SKU. Links to users/{businessId}/products/{sku}.
//                  * QUERY: HIGH (within flattened items) — primary groupBy key.
//                  */
//                 sku: string;
 
//                 /**
//                  * Denormalized product name. Display only.
//                  * QUERY: NEVER
//                  */
//                 productName: string;
 
//                 /**
//                  * Cost per unit (ex-tax, INR). Copied to GRN items at GRN creation time.
//                  * QUERY: MEDIUM (within flattened items) — multiply by receivedQty for line total.
//                  */
//                 unitCost: number;
 
//                 /**
//                  * Quantity ordered from supplier for this SKU.
//                  * QUERY: MEDIUM — sum expectedQty across items to compare against receivedQty.
//                  */
//                 expectedQty: number;
 
//                 /**
//                  * Quantity received so far across all GRNs for this PO.
//                  * Incremented by the grns/confirm-put-away API on each GRN completion.
//                  * QUERY: MEDIUM — compare with expectedQty to identify shortfalls.
//                  */
//                 receivedQty: number;
 
//                 /**
//                  * expectedQty − receivedQty. Maintained automatically.
//                  * QUERY: MEDIUM — filter notReceivedQty > 0 to find items with outstanding delivery.
//                  */
//                 notReceivedQty: number;
 
//                 /**
//                  * Per-item receipt status.
//                  * "pending"            — nothing received yet.
//                  * "partially_received" — some received, more expected.
//                  * "fully_received"     — all ordered units received.
//                  * "closed"             — manually closed without full receipt.
//                  * QUERY: MEDIUM (within flattened items) — filter by status to count pending items.
//                  */
//                 status: 'pending' | 'partially_received' | 'fully_received' | 'closed';
//             }[];
 
//             // -- DATE FIELDS --------------------------------------------------
 
//             /**
//              * Expected delivery date. Firestore Timestamp.
//              * QUERY: MEDIUM — sort or filter to identify overdue POs (expectedDate < today).
//              */
//             expectedDate: Timestamp;
 
//             /**
//              * When the PO was moved to "confirmed" status. Null until confirmed.
//              * QUERY: LOW — rarely filtered on directly.
//              */
//             confirmedAt: Timestamp | null;
 
//             /**
//              * When the PO was fully received or manually closed. Null until then.
//              * QUERY: LOW — use for closure date analysis if needed.
//              */
//             completedAt: Timestamp | null;
 
//             /**
//              * When the PO was cancelled. Null unless cancelled.
//              * QUERY: LOW
//              */
//             cancelledAt: Timestamp | null;
 
//             /**
//              * Reason provided when cancelling. Null if not cancelled.
//              * QUERY: NEVER — display only.
//              */
//             cancelReason: string | null;
 
//             /**
//              * Free-text notes. Null if not set.
//              * QUERY: NEVER
//              */
//             notes: string | null;
 
//             // -- METADATA -----------------------------------------------------
 
//             /**
//              * Firestore Timestamp. When this PO was created.
//              * QUERY: MEDIUM — filter createdAt range to find POs raised in a period.
//              */
//             createdAt: Timestamp;
 
//             /**
//              * UID of the user who created this PO.
//              * QUERY: NEVER
//              */
//             createdBy: string;
 
//             /**
//              * Firestore Timestamp. When this PO was last updated.
//              * QUERY: NEVER
//              */
//             updatedAt: Timestamp;
//         };
 
 
//         // =====================================================================
//         // COLLECTION: grns
//         // Path: users/{businessId}/grns/{grnId}
//         // =====================================================================
//         // A Goods Receipt Note (GRN) records the physical receipt of goods against a PO.
//         // One PO can have multiple GRNs (partial deliveries).
//         // On "Confirm Put Away", UPC documents are batch-created for each received unit
//         // (putAway: "inbound") and the parent PO's receivedQty is updated.
//         //
//         // RELATIONSHIPS:
//         //   poId        → users/{businessId}/purchaseOrders/{poId}
//         //   warehouseId → users/{businessId}/warehouses/{warehouseId}
//         //   items[].sku → users/{businessId}/products/{sku}
//         //   Creates     → users/{businessId}/upcs/{upcId} (one per received unit)
//         //   Referenced by → users/{businessId}/upcs/{upcId}.grnRef
//         //
//         // PRE-COMPUTED TOTALS — use directly, do not re-sum items[]:
//         //   totalReceivedValue, totalExpectedQty, totalReceivedQty, totalNotReceivedQty
//         //
//         // TYPICAL QUERIES:
//         //   - Filter status == "completed" + receivedAt range for purchase-by-period reports
//         //   - Sum totalReceivedValue across completed GRNs for total spend
//         //   - Filter receivedSkus array-contains "SKU-X" to find GRNs for a product
//         //   - Flatten items[] and groupBy sku for per-product received quantity
//         // =====================================================================
//         grns: {
 
//             // -- IDENTITY -----------------------------------------------------
 
//             /**
//              * Firestore document ID.
//              * QUERY: MEDIUM — equality filter when looking up a specific GRN.
//              */
//             id: string;
 
//             /**
//              * Human-readable GRN number (e.g. "GRN-00015"). Auto-generated sequentially.
//              * Denormalized onto upcs.grnRef for display.
//              * QUERY: MEDIUM — equality filter when searching by GRN number.
//              */
//             grnNumber: string;
 
//             /**
//              * Business this GRN belongs to. Matches the path segment.
//              * QUERY: NEVER — implicit in the collection path.
//              */
//             businessId: string;
 
//             /**
//              * Supplier's invoice/bill number for this delivery.
//              * Must be unique across all GRNs in the business. Used in PDF bill filenames.
//              * QUERY: MEDIUM — equality filter when reconciling against a supplier invoice.
//              */
//             billNumber: string;
 
//             // -- STATUS -------------------------------------------------------
 
//             /**
//              * Lifecycle status.
//              * "draft"     — GRN created; put-away not yet confirmed; UPCs do NOT exist yet.
//              * "completed" — Put-away confirmed; UPCs created (putAway: "inbound");
//              *               PO receivedQty updated. Terminal — cannot be edited.
//              * "cancelled" — Voided; PO receivedQty reverted.
//              * QUERY: HIGH — always filter status == "completed" for purchase analytics.
//              *               Draft GRNs have no UPCs and must be excluded from reports.
//              */
//             status: 'draft' | 'completed' | 'cancelled';
 
//             // -- RELATIONSHIPS ------------------------------------------------
 
//             /**
//              * ID of the linked Purchase Order. A GRN cannot exist without a PO.
//              * Links to users/{businessId}/purchaseOrders/{poId}.
//              * QUERY: HIGH — filter by poId to fetch all GRNs for a specific PO.
//              *               Group by poId to count deliveries per PO.
//              */
//             poId: string;
 
//             /**
//              * Denormalized PO number (e.g. "PO-00042"). Display only — avoids a PO read.
//              * QUERY: NEVER
//              */
//             poNumber: string;
 
//             /**
//              * ID of the warehouse where goods were received.
//              * Links to users/{businessId}/warehouses/{warehouseId}.
//              * QUERY: MEDIUM — filter by warehouseId to scope GRN analytics to one warehouse.
//              */
//             warehouseId: string;
 
//             /**
//              * Denormalized warehouse name. Null if not available at creation time.
//              * QUERY: NEVER — display only.
//              */
//             warehouseName: string | null;
 
//             // -- QUERYABLE PRODUCT SHORTCUT -----------------------------------
 
//             /**
//              * Flat array of all SKUs received in this GRN.
//              * Allows filtering GRNs by product without flattening items[].
//              * Each value links to users/{businessId}/products/{sku}.
//              * QUERY: HIGH — array-contains filter: receivedSkus array-contains "SKU-X"
//              *               to find all GRNs that included a given product.
//              */
//             receivedSkus: string[];
 
//             // -- PRE-COMPUTED TOTALS (use directly) ---------------------------
 
//             /**
//              * Sum of all items[].totalCost. Taxable base value (ex-tax) in INR.
//              * Pre-computed at GRN creation. Do not re-sum items[].totalCost.
//              * Used in the gross profit Purchase row for total purchase value.
//              * QUERY: HIGH — sum this field across completed GRNs for total purchase spend.
//              */
//             totalReceivedValue: number;
 
//             /**
//              * Sum of all items[].expectedQty. Pre-computed.
//              * QUERY: LOW — informational; rarely aggregated directly.
//              */
//             totalExpectedQty: number;
 
//             /**
//              * Sum of all items[].receivedQty. Pre-computed.
//              * QUERY: MEDIUM — sum across GRNs to get total units received in a period.
//              */
//             totalReceivedQty: number;
 
//             /**
//              * Sum of all items[].notReceivedQty. Pre-computed.
//              * QUERY: LOW — use for delivery completeness tracking.
//              */
//             totalNotReceivedQty: number;
 
//             // -- EMBEDDED ITEMS -----------------------------------------------
 
//             /**
//              * Line items — one per distinct SKU received.
//              * Only items with receivedQty > 0 generate UPC docs on put-away confirmation.
//              * Flatten with flattenArrayField("items") for per-SKU aggregation.
//              * QUERY: MEDIUM — flatten, groupBy sku, sumGrouped receivedQty for per-product receipt report.
//              */
//             items: {
//                 /**
//                  * Product SKU. Links to users/{businessId}/products/{sku}.
//                  * QUERY: HIGH (within flattened items) — primary groupBy key.
//                  */
//                 sku: string;
 
//                 /**
//                  * Denormalized product name. Display only.
//                  * QUERY: NEVER
//                  */
//                 productName: string;
 
//                 /**
//                  * Cost per unit (ex-tax, INR). Copied from PO items at GRN creation time.
//                  * Used in gross profit: taxable = unitCost × receivedQty.
//                  * QUERY: MEDIUM (within flattened items) — multiply by receivedQty for line total.
//                  */
//                 unitCost: number;
 
//                 /**
//                  * Remaining expected quantity for this item in this GRN delivery.
//                  * QUERY: LOW — informational.
//                  */
//                 expectedQty: number;
 
//                 /**
//                  * Units physically received and confirmed for this line item.
//                  * QUERY: MEDIUM (within flattened items) — sum for per-product received totals.
//                  */
//                 receivedQty: number;
 
//                 /**
//                  * expectedQty − receivedQty. Shortfall for this item in this GRN.
//                  * QUERY: LOW — informational.
//                  */
//                 notReceivedQty: number;
 
//                 /**
//                  * Pre-computed line total: receivedQty × unitCost.
//                  * QUERY: MEDIUM (within flattened items) — sum for per-SKU spend analysis.
//                  */
//                 totalCost: number;
//             }[];
 
//             // -- DATE FIELDS --------------------------------------------------
 
//             /**
//              * When goods were physically received (put-away confirmed). Firestore Timestamp.
//              * This is the CORRECT date field for all purchase-by-period queries.
//              * Always filter on receivedAt — NOT createdAt — for purchase reports.
//              * QUERY: HIGH — primary date filter for all GRN-based analytics.
//              *               e.g. receivedAt >= startDate AND receivedAt <= endDate.
//              */
//             receivedAt: Timestamp;
 
//             /**
//              * When this GRN doc was created (draft stage). Firestore Timestamp.
//              * Not meaningful for analytics — goods may not have arrived yet at this point.
//              * QUERY: NEVER — use receivedAt for all date-based purchase queries.
//              */
//             createdAt: Timestamp;
 
//             /**
//              * When this GRN doc was last updated. Firestore Timestamp.
//              * QUERY: NEVER
//              */
//             updatedAt: Timestamp;
 
//             // -- METADATA -----------------------------------------------------
 
//             /**
//              * UID of the user who confirmed put-away (completed the GRN).
//              * QUERY: NEVER
//              */
//             receivedBy: string;
 
//             /**
//              * Free-text notes (e.g. delivery condition, carrier info). Null if not set.
//              * QUERY: NEVER
//              */
//             notes: string | null;
//         };
 
 
//         // =====================================================================
//         // COLLECTION: upcs
//         // Path: users/{businessId}/upcs/{upcId}
//         // =====================================================================
//         // Each UPC document represents ONE individual physical unit of a product.
//         // Every unit entering or moving through the warehouse has its own doc.
//         // The upcId is also the barcode value printed and scanned during operations.
//         //
//         // UPCs are currently created ONLY via GRN put-away (grnRef set, putAway: "inbound").
//         // Creation via RTO/DTO order returns was discontinued because it generated UPC docs
//         // without a corresponding purchase source, which distorted the gross profit report's
//         // Quantity column — returned units appeared as new incoming stock with no offsetting entry.
//         //
//         // putAway STATE MACHINE:
//         //   "inbound"  — received from GRN; awaiting shelf placement.
//         //                All location fields (warehouseId, zoneId, rackId, shelfId,
//         //                placementId) are null in this state.
//         //   "none"     — placed on a shelf. All location fields populated.
//         //                inShelfQuantity on the product doc increments on → "none",
//         //                decrements on "none" → anything else.
//         //   "outbound" — picked for dispatch (order or credit note).
//         //                If creditNoteRef is set: reserved for credit note removal.
//         //                If creditNoteRef is null + orderId set: reserved for courier dispatch.
//         //   null       — left the warehouse. Terminal state. Doc is never deleted.
//         //                If creditNoteRef was set: CN dispatch → deduction++.
//         //                If creditNoteRef was null: order fulfilled → autoDeduction++ + blockedStock--.
//         //
//         // RELATIONSHIPS:
//         //   productId     → users/{businessId}/products/{sku}           [always set]
//         //   grnRef        → users/{businessId}/grns/{grnId}             [set at creation, never changes]
//         //   creditNoteRef → users/{businessId}/credit_notes/{cnId}      [set when reserved for CN]
//         //   storeId       → accounts/{storeId}                          [set during order pickup]
//         //   orderId       → accounts/{storeId}/orders/{orderId}         [set during order pickup]
//         //   warehouseId   → users/{businessId}/warehouses/{warehouseId} [set when putAway == "none"]
//         //   zoneId        → users/{businessId}/zones/{zoneId}           [set when putAway == "none"]
//         //   rackId        → users/{businessId}/racks/{rackId}           [set when putAway == "none"]
//         //   shelfId       → users/{businessId}/shelves/{shelfId}        [set when putAway == "none"]
//         //   placementId   → users/{businessId}/placements/{productId}_{shelfId}
//         //
//         // TYPICAL QUERIES:
//         //   - Filter putAway == "inbound" to find units awaiting put-away
//         //   - Filter putAway == "none" + productId to count on-shelf stock per product
//         //   - Filter putAway == "none" + shelfId/rackId/zoneId for location audits
//         //   - Filter grnRef + productId to trace a unit back to its receipt
//         //   NOTE: For on-shelf count queries, prefer placements.quantity (pre-aggregated)
//         //         over counting UPC docs directly — it is far more efficient.
//         // =====================================================================
//         upcs: {
 
//             // -- IDENTITY -----------------------------------------------------
 
//             /**
//              * Unique UPC identifier. Also the barcode value scanned during put-away
//              * and packaging operations. Generated as a nanoid at UPC creation.
//              * QUERY: MEDIUM — equality filter when looking up a specific unit by barcode.
//              */
//             id: string;
 
//             // -- STATE --------------------------------------------------------
 
//             /**
//              * Current physical state of this unit in the warehouse.
//              * The single most important field — determines everything about this UPC's context.
//              * See the STATE MACHINE in the collection header above.
//              * Values: "inbound" | "none" | "outbound" | null
//              * QUERY: HIGH — always filter by putAway to scope UPC queries to a lifecycle stage.
//              *               e.g. putAway == "inbound" for pending put-away list.
//              *               e.g. putAway == "none" for on-shelf stock audit.
//              *               NOTE: querying putAway == null is valid — Firestore treats null
//              *               as an explicit stored value (use == null operator).
//              */
//             putAway: "inbound" | "none" | "outbound" | null;
 
//             // -- RELATIONSHIPS ------------------------------------------------
 
//             /**
//              * SKU of the product this unit represents.
//              * Links to users/{businessId}/products/{sku}.
//              * QUERY: HIGH — always include when grouping UPCs by product.
//              *               Filter productId == "SKU-X" to count units of a specific product.
//              */
//             productId: string;
 
//             /**
//              * GRN document ID this UPC was created from.
//              * Set at creation time (GRN put-away) and never changes afterward.
//              * Links to users/{businessId}/grns/{grnId}.
//              * QUERY: MEDIUM — filter by grnRef to find all units received in a specific GRN.
//              */
//             grnRef: string | null;
 
//             /**
//              * Credit note document ID, set when this UPC is reserved for a CN return dispatch.
//              * Null for all order-dispatched or shelf-resting UPCs.
//              * Links to users/{businessId}/credit_notes/{cnId}.
//              * QUERY: MEDIUM — filter creditNoteRef != null to find units reserved for CN dispatch.
//              */
//             creditNoteRef: string | null;
 
//             /**
//              * Shopify store domain, set during order pickup when a Confirmed order
//              * claims this UPC for dispatch. Null until claimed.
//              * Links to accounts/{storeId}.
//              * QUERY: MEDIUM — filter by storeId to scope UPCs to a specific store.
//              */
//             storeId: string | null;
 
//             /**
//              * Shopify order ID, set alongside storeId during order pickup.
//              * Null until an order claims this UPC.
//              * Links to accounts/{storeId}/orders/{orderId}.
//              * QUERY: MEDIUM — filter by orderId to find all units dispatched for a specific order.
//              */
//             orderId: string | null;
 
//             // -- LOCATION FIELDS (populated only when putAway == "none") ------
 
//             /**
//              * Warehouse where this unit is currently located.
//              * Populated when putAway transitions to "none". Null in all other states.
//              * Links to users/{businessId}/warehouses/{warehouseId}.
//              * QUERY: MEDIUM — filter to scope a stock audit to a specific warehouse.
//              */
//             warehouseId: string | null;
 
//             /**
//              * Zone within the warehouse.
//              * Populated when putAway == "none". Null otherwise.
//              * Links to users/{businessId}/zones/{zoneId}.
//              * QUERY: MEDIUM — filter for zone-level stock audit.
//              */
//             zoneId: string | null;
 
//             /**
//              * Rack within the zone.
//              * Populated when putAway == "none". Null otherwise.
//              * Links to users/{businessId}/racks/{rackId}.
//              * QUERY: LOW — rarely filtered at rack level.
//              */
//             rackId: string | null;
 
//             /**
//              * Shelf within the rack.
//              * Populated when putAway == "none". Null otherwise.
//              * Links to users/{businessId}/shelves/{shelfId}.
//              * QUERY: MEDIUM — filter shelfId to audit contents of a specific shelf.
//              */
//             shelfId: string | null;
 
//             /**
//              * Placement document ID: format "{productId}_{shelfId}".
//              * Populated when putAway == "none". Null otherwise.
//              * Links to users/{businessId}/placements/{placementId}.
//              * QUERY: LOW — use placements collection directly for placement-level stock counts.
//              */
//             placementId: string | null;
 
//             // -- METADATA -----------------------------------------------------
 
//             /**
//              * Firestore Timestamp. When this UPC was created.
//              * QUERY: MEDIUM — filter createdAt range to find UPCs received in a period.
//              */
//             createdAt: Timestamp;
 
//             /**
//              * Firestore Timestamp. When this UPC last changed state (putAway transition).
//              * QUERY: LOW — useful for identifying stale inbound UPCs not yet put away.
//              */
//             updatedAt: Timestamp;
 
//             /**
//              * UID of the user or system that created this UPC.
//              * QUERY: NEVER
//              */
//             createdBy: string;
 
//             /**
//              * UID of the user or system that last updated this UPC.
//              * QUERY: NEVER
//              */
//             updatedBy: string;
//         };
 
 
//         // =====================================================================
//         // COLLECTION: placements
//         // Path: users/{businessId}/placements/{placementId}
//         // =====================================================================
//         // A placement is a pre-aggregated stock count for one product at one shelf.
//         // Document ID format: "{productId}_{shelfId}" — deterministic, not random.
//         // quantity reflects the live count of UPCs with putAway == "none" at this location.
//         // Maintained by the onUpcWritten trigger — no manual writes needed.
//         //
//         // PREFER placements over counting UPC docs for stock-at-location queries.
//         // Reading one placement doc is O(1); counting UPCs is O(n).
//         //
//         // RELATIONSHIPS:
//         //   productId   → users/{businessId}/products/{sku}
//         //   warehouseId → users/{businessId}/warehouses/{warehouseId}
//         //   zoneId      → users/{businessId}/zones/{zoneId}
//         //   rackId      → users/{businessId}/racks/{rackId}
//         //   shelfId     → users/{businessId}/shelves/{shelfId}
//         //   Referenced by → users/{businessId}/upcs/{upcId}.placementId
//         //
//         // TYPICAL QUERIES:
//         //   - Filter productId to find all shelf locations for a product
//         //   - Filter shelfId to see all products on a shelf
//         //   - Filter warehouseId + productId + quantity > 0 for non-empty placements
//         //   - Sum quantity across placements for a product = total on-shelf stock
//         // =====================================================================
//         placements: {
 
//             // -- IDENTITY -----------------------------------------------------
 
//             /**
//              * Document ID. Format: "{productId}_{shelfId}".
//              * Deterministic — computed from the two foreign keys, not random.
//              * Used as placementId on UPC docs.
//              * QUERY: MEDIUM — equality filter when looking up stock at a specific product+shelf.
//              */
//             id: string;
 
//             // -- CORE DATA ----------------------------------------------------
 
//             /**
//              * Current count of units (UPCs with putAway == "none") at this location.
//              * Maintained by onUpcWritten. Use this instead of counting UPC docs.
//              * QUERY: HIGH — filter quantity > 0 to find occupied placements;
//              *               sum across placements for a product = total on-shelf stock.
//              */
//             quantity: number;
 
//             // -- RELATIONSHIPS ------------------------------------------------
 
//             /**
//              * SKU of the product stored here.
//              * Links to users/{businessId}/products/{sku}.
//              * QUERY: HIGH — filter productId to find all locations for a given product.
//              */
//             productId: string;
 
//             /**
//              * Warehouse containing this placement.
//              * Links to users/{businessId}/warehouses/{warehouseId}.
//              * QUERY: MEDIUM — filter to scope placement queries to a warehouse.
//              */
//             warehouseId: string;
 
//             /**
//              * Zone within the warehouse.
//              * Links to users/{businessId}/zones/{zoneId}.
//              * QUERY: LOW — rarely filtered at zone level for placement queries.
//              */
//             zoneId: string;
 
//             /**
//              * Rack within the zone.
//              * Links to users/{businessId}/racks/{rackId}.
//              * QUERY: LOW
//              */
//             rackId: string;
 
//             /**
//              * Shelf within the rack.
//              * Links to users/{businessId}/shelves/{shelfId}.
//              * QUERY: MEDIUM — filter shelfId to see all products on a shelf.
//              */
//             shelfId: string;
 
//             // -- AUDIT --------------------------------------------------------
 
//             /**
//              * Human-readable reason for the last stock movement (e.g. "put-away", "dispatch").
//              * Null if not recorded.
//              * QUERY: NEVER — informational audit trail.
//              */
//             lastMovementReason: string | null;
 
//             /**
//              * Reference ID for the last movement (e.g. GRN number, order ID). Null if not set.
//              * QUERY: NEVER
//              */
//             lastMovementReference: string | null;
 
//             // -- INTERNAL -----------------------------------------------------
 
//             /**
//              * Internal flag read by the onPlacementWritten trigger.
//              * When true on a write with a positive quantity diff, the trigger
//              * auto-creates UPC docs (one per unit). Irrelevant for analytical queries.
//              * QUERY: NEVER
//              */
//             createUPCs: boolean;
 
//             // -- METADATA -----------------------------------------------------
 
//             /**
//              * Firestore Timestamp. When this placement was first created.
//              * QUERY: NEVER
//              */
//             createdAt: Timestamp;
 
//             /**
//              * Firestore Timestamp. When this placement's quantity last changed.
//              * QUERY: LOW — can identify stale placements (not touched recently).
//              */
//             updatedAt: Timestamp;
 
//             /**
//              * UID of the user who created this placement.
//              * QUERY: NEVER
//              */
//             createdBy: string;
 
//             /**
//              * UID of the user who last updated this placement.
//              * QUERY: NEVER
//              */
//             updatedBy: string;
//         };
 
 
//         // =====================================================================
//         // COLLECTION: upcsLogs
//         // Path: users/{businessId}/upcsLogs/{upcsLogsId}
//         // =====================================================================
//         // Flat audit log of every tracked state change on every UPC.
//         // One entry is written per change event on a UPC's putAway, location,
//         // storeId, or orderId fields.
//         // A parallel copy also exists as a subcollection at:
//         //   users/{businessId}/upcs/{upcId}/logs/{logId}
//         // This flat collection is preferred when querying logs without knowing the upcId.
//         //
//         // RELATIONSHIPS:
//         //   upcId     → users/{businessId}/upcs/{upcId}
//         //   productId → users/{businessId}/products/{sku}
//         //   grnRef    → users/{businessId}/grns/{grnId}  (if applicable)
//         //
//         // TYPICAL QUERIES:
//         //   - Filter upcId to get the full movement history of a unit
//         //   - Filter productId + timestamp range for product-level movement audit
//         //   - Filter grnRef to trace all movements of units from a specific GRN
//         // =====================================================================
//         upcsLogs: {
 
//             // -- RELATIONSHIPS ------------------------------------------------
 
//             /**
//              * The UPC this log entry belongs to.
//              * Links to users/{businessId}/upcs/{upcId}.
//              * QUERY: HIGH — primary filter when tracing the full history of a specific unit.
//              */
//             upcId: string;
 
//             /**
//              * SKU of the product this UPC belongs to.
//              * Links to users/{businessId}/products/{sku}.
//              * QUERY: HIGH — filter by productId + timestamp range for product movement audit.
//              */
//             productId: string;
 
//             /**
//              * GRN document ID if this UPC was received via GRN. Null otherwise.
//              * Links to users/{businessId}/grns/{grnId}.
//              * QUERY: MEDIUM — filter grnRef to trace all movements of units from a GRN.
//              */
//             grnRef: string | null;
 
//             // -- CORE DATA ----------------------------------------------------
 
//             /**
//              * When this log entry was written. Firestore Timestamp.
//              * QUERY: HIGH — sort descending for most-recent-first; filter by range for period audits.
//              */
//             timestamp: Timestamp;
 
//             /**
//              * Snapshot of the UPC's key fields at the moment of this state change.
//              * Captures the state AFTER the triggering change.
//              * QUERY: MEDIUM — read snapshot.putAway to understand the transition recorded here.
//              */
//             snapshot: {
//                 /**
//                  * putAway value after this state change. The transition that triggered the log.
//                  * QUERY: MEDIUM — filter snapshot.putAway to find log entries for a specific state.
//                  */
//                 putAway: "inbound" | "none" | "outbound" | null;
 
//                 /**
//                  * Shopify store domain at log time. Null if not order-linked.
//                  * QUERY: LOW
//                  */
//                 storeId: string | null;
 
//                 /**
//                  * Order ID at log time. Null if not order-linked.
//                  * QUERY: LOW
//                  */
//                 orderId: string | null;
 
//                 /**
//                  * Warehouse ID at log time. Null if UPC was inbound or dispatched.
//                  * QUERY: NEVER
//                  */
//                 warehouseId: string | null;
 
//                 /**
//                  * Zone ID at log time. QUERY: NEVER
//                  */
//                 zoneId: string | null;
 
//                 /**
//                  * Rack ID at log time. QUERY: NEVER
//                  */
//                 rackId: string | null;
 
//                 /**
//                  * Shelf ID at log time. Null if not on a shelf. QUERY: LOW
//                  */
//                 shelfId: string | null;
 
//                 /**
//                  * Placement ID at log time. Null if UPC was inbound or dispatched.
//                  * QUERY: NEVER
//                  */
//                 placementId: string | null;
//             };
//         };
 
 
//         // =====================================================================
//         // COLLECTION: inventory_snapshots
//         // Path: users/{businessId}/inventory_snapshots/{inventory_snapshot_id}
//         // =====================================================================
//         // Daily point-in-time snapshot of one product's stock, captured at 23:59 IST
//         // by the dailyInventorySnapshot scheduled function.
//         // One document per product per date. Document ID: "{productId}_{YYYY-MM-DD}".
//         // Idempotent — safe to re-run for the same date.
//         //
//         // PRIMARY USE CASE: Gross Profit Report
//         //   Opening Stock value = snapshot for (reportStartDate − 1 day) × product.price
//         //   Closing Stock value = snapshot for reportEndDate × product.price
//         //   Net available at that date = stockLevel − exactDocState.inventory.blockedStock
//         //
//         // TYPICAL QUERIES:
//         //   - Filter productId + date == "YYYY-MM-DD" to get stock on a specific date
//         //   - Filter isStockout == true to find stockout events in a range
//         //   - Filter date range + productId for stock trend over time
//         // =====================================================================
//         inventory_snapshots: {
 
//             // -- IDENTITY / RELATIONSHIPS -------------------------------------
 
//             /**
//              * SKU of the product this snapshot belongs to.
//              * Links to users/{businessId}/products/{sku}.
//              * QUERY: HIGH — always include when filtering snapshots by product.
//              */
//             productId: string;
 
//             /**
//              * Date of this snapshot in YYYY-MM-DD format (IST).
//              * Use this field for date-based filtering — NOT the timestamp field.
//              * To find opening stock for a report: filter date == startDate − 1 day.
//              * QUERY: HIGH — primary date filter for all snapshot queries.
//              */
//             date: string;
 
//             // -- CORE DATA ----------------------------------------------------
 
//             /**
//              * Physical stock level at end of day (23:59 IST).
//              * Formula: openingStock + inwardAddition + autoAddition − deduction − autoDeduction.
//              * Raw physical count — NOT adjusted for blockedStock.
//              * For net available stock: stockLevel − exactDocState.inventory.blockedStock.
//              * QUERY: MEDIUM — read to get historical stock level on a date.
//              */
//             stockLevel: number;
 
//             /**
//              * True if stockLevel was 0 at snapshot time (product was out of stock that day).
//              * QUERY: MEDIUM — filter isStockout == true to count stockout days for a product.
//              */
//             isStockout: boolean;
 
//             /**
//              * Units sold on this date across all linked stores.
//              * Derived from order line items with createdAt matching this date.
//              * QUERY: MEDIUM — sum across a date range for total units sold per product.
//              */
//             dailySales: number;
 
//             /**
//              * Full copy of the product's inventory sub-document at snapshot time.
//              * Used by the gross profit report to extract blockedStock at a point in time.
//              * Net available = stockLevel − exactDocState.inventory.blockedStock.
//              * QUERY: LOW — read as a block only when a full counter audit is needed.
//              */
//             exactDocState: {
//                 /**
//                  * Exact state of products.inventory at snapshot time.
//                  * Fields are identical to products.inventory — see that collection for field descriptions.
//                  */
//                 inventory: {
//                     openingStock: number;
//                     inwardAddition: number;
//                     deduction: number;
//                     autoDeduction: number;
//                     autoAddition: number;
//                     /**
//                      * Subtract from stockLevel to get net available stock at this snapshot date.
//                      * QUERY: MEDIUM — used in gross profit report: net = stockLevel - blockedStock.
//                      */
//                     blockedStock: number;
//                 };
//             };
 
//             /**
//              * Firestore Timestamp. When this snapshot was written by the scheduled function.
//              * QUERY: NEVER — use the date (string) field for filtering, not this Timestamp.
//              */
//             timestamp: Timestamp;
//         };
 
 
//         // =====================================================================
//         // COLLECTION: parties
//         // Path: users/{businessId}/parties/{partyId}
//         // =====================================================================
//         // A party is a business contact — supplier, customer, or both.
//         // Referenced by purchaseOrders.supplierPartyId and credit_notes.partyId.
//         // Deactivation (isActive: false) is blocked by the API if open POs reference this party.
//         //
//         // TYPICAL QUERIES:
//         //   - Filter type == "supplier" + isActive == true for PO/CN creation dropdowns
//         //   - Equality filter on id when joining PO or CN supplier details
//         // =====================================================================
//         parties: {
 
//             // -- IDENTITY -----------------------------------------------------
 
//             /**
//              * Firestore document ID.
//              * QUERY: MEDIUM — equality filter when joining PO or CN supplier details.
//              */
//             id: string;
 
//             /**
//              * Display name (e.g. "Reliance Textiles Pvt. Ltd.").
//              * Denormalized into purchaseOrders.supplierName and credit_notes.partyName.
//              * QUERY: LOW — use id for filtering; name is for display only.
//              */
//             name: string;
 
//             /**
//              * Role in the system.
//              * "supplier" — eligible for Purchase Orders and Credit Notes.
//              * "customer" — reserved for future customer-side features.
//              * "both"     — can act as either role.
//              * Immutable after creation.
//              * QUERY: HIGH — filter type == "supplier" when fetching parties for PO creation.
//              */
//             type: 'supplier' | 'customer' | 'both';
 
//             /**
//              * Whether this party is currently active.
//              * Inactive parties do not appear in PO or CN creation dropdowns.
//              * Soft-delete — the document is never removed.
//              * QUERY: HIGH — always filter isActive == true when listing selectable parties.
//              */
//             isActive: boolean;
 
//             // -- CONTACT DETAILS ----------------------------------------------
 
//             /**
//              * Short alphanumeric reference code (e.g. "SUP001"). Null if not set.
//              * QUERY: LOW — occasionally used for search.
//              */
//             code: string | null;
 
//             /**
//              * Name of the primary contact person. Null if not set.
//              * QUERY: NEVER
//              */
//             contactPerson: string | null;
 
//             /**
//              * Phone number. Null if not set.
//              * QUERY: NEVER
//              */
//             phone: string | null;
 
//             /**
//              * Email address. Null if not set.
//              * QUERY: NEVER
//              */
//             email: string | null;
 
//             // -- ADDRESS (used in bill PDFs) ----------------------------------
 
//             /**
//              * Physical address. Used in GRN and Credit Note bill PDFs for the
//              * "Billed By" / "Billed To" block.
//              * address.state determines GST jurisdiction:
//              *   state.toLowerCase() === "punjab" || "pb" → intra-state (CGST + SGST).
//              *   anything else → inter-state (IGST).
//              * Null if not set.
//              * QUERY: NEVER — read for PDF rendering only.
//              */
//             address: {
//                 line1: string | null;
//                 line2: string | null;
//                 city: string | null;
//                 /** Used for intra/inter-state GST determination. */
//                 state: string | null;
//                 pincode: string | null;
//                 country: string;
//             } | null;
 
//             // -- FINANCIAL / TAX IDENTIFIERS ---------------------------------
 
//             /**
//              * GSTIN (15-character alphanumeric). Shown on GRN bill PDFs.
//              * Validated on creation. Null if not provided.
//              * QUERY: NEVER
//              */
//             gstin: string | null;
 
//             /**
//              * PAN (10 characters). Shown on GRN bills. Null if not provided.
//              * QUERY: NEVER
//              */
//             pan: string | null;
 
//             /**
//              * Bank account details for payment processing.
//              * GRN bills: shows this party's bank (business pays supplier here).
//              * Credit note bills: shows the BUSINESS's bank instead (supplier refunds business).
//              * This asymmetry is intentional — do not use party bankDetails for CN bills.
//              * Null if not set.
//              * QUERY: NEVER — read for PDF rendering only.
//              */
//             bankDetails: {
//                 accountName: string | null;
//                 accountNumber: string | null;
//                 ifsc: string | null;
//                 bankName: string | null;
//             } | null;
 
//             /**
//              * Payment terms (e.g. "Net 30", "Immediate"). Informational only — not enforced.
//              * QUERY: NEVER
//              */
//             defaultPaymentTerms: string | null;
 
//             /**
//              * Free-text notes. Null if not set.
//              * QUERY: NEVER
//              */
//             notes: string | null;
 
//             // -- METADATA -----------------------------------------------------
 
//             /**
//              * Firestore Timestamp. When this party was created.
//              * QUERY: LOW
//              */
//             createdAt: Timestamp;
 
//             /**
//              * UID of the user who created this party.
//              * QUERY: NEVER
//              */
//             createdBy: string;
 
//             /**
//              * Firestore Timestamp. When this party was last updated.
//              * QUERY: NEVER
//              */
//             updatedAt: Timestamp;
 
//             /**
//              * UID of the user who last updated this party.
//              * QUERY: NEVER
//              */
//             updatedBy: string;
//         };
 
 
//         // =====================================================================
//         // WAREHOUSE HIERARCHY COLLECTIONS
//         // Order: warehouses → zones → racks → shelves
//         // =====================================================================
//         // These collections describe the physical structure of the warehouse.
//         // They are rarely queried for business analytics. Their primary uses are:
//         //   - Rendering the warehouse map in the UI
//         //   - Providing location labels when displaying UPC or placement data
//         //   - Reading stats.* for high-level capacity overviews
//         // For stock analytics, always prefer placements and upcs.
//         // =====================================================================
 
//         // =====================================================================
//         // COLLECTION: warehouses
//         // Path: users/{businessId}/warehouses/{warehouseId}
//         // =====================================================================
//         warehouses: {
//             /** Document ID = code (uppercase). Immutable. QUERY: MEDIUM */
//             id: string;
//             /** Display name (e.g. "Main Warehouse Ludhiana"). QUERY: LOW */
//             name: string;
//             /** Uppercase code. Same as id. QUERY: NEVER */
//             code: string;
//             /**
//              * True if soft-deleted. Always filter isDeleted == false for active warehouses.
//              * QUERY: HIGH
//              */
//             isDeleted: boolean;
//             /**
//              * Default GST state (e.g. "Punjab").
//              * Determines intra/inter-state for GRN bill tax calculation.
//              * QUERY: NEVER — read for PDF rendering only.
//              */
//             defaultGSTstate: string;
//             /**
//              * Pre-aggregated hierarchy counts. Use for capacity overviews —
//              * do not query child collections to compute these.
//              * QUERY: LOW — read for dashboard-style overview queries.
//              */
//             stats: {
//                 totalZones: number;
//                 totalRacks: number;
//                 totalShelves: number;
//                 totalProducts: number;
//             };
//             address: string;           // Physical address string. QUERY: NEVER
//             storageCapacity: number;   // Informational capacity. QUERY: NEVER
//             operationalHours: number;  // Hours per day. QUERY: NEVER
//             deletedAt: Timestamp | null;
//             createdAt: Timestamp;
//             createdBy: string;
//             updatedAt: Timestamp;
//             updatedBy: string;
//             /** Incremented on name change; used to detect stale denormalized names. QUERY: NEVER */
//             nameVersion: number;
//         };
 
//         // =====================================================================
//         // COLLECTION: zones
//         // Path: users/{businessId}/zones/{zoneId}
//         // HIERARCHY: Warehouse → Zone → Rack → Shelf → Placements → UPCs
//         // =====================================================================
//         zones: {
//             /** Document ID = zone code (uppercase). Immutable. QUERY: MEDIUM */
//             id: string;
//             /** Display name (e.g. "Zone A – Inbound"). QUERY: LOW */
//             name: string;
//             code: string;             // QUERY: NEVER
//             description: string | null; // QUERY: NEVER
//             /** QUERY: HIGH — always filter isDeleted == false. */
//             isDeleted: boolean;
//             /** Parent warehouse. QUERY: HIGH — list all zones in a warehouse. */
//             warehouseId: string;
//             /** Pre-aggregated counts. QUERY: LOW */
//             stats: { totalRacks: number; totalShelves: number; totalProducts: number; };
//             deletedAt: Timestamp | null;
//             createdAt: Timestamp;
//             createdBy: string;
//             updatedAt: Timestamp;
//             updatedBy: string;
//             locationVersion: number; // QUERY: NEVER
//             nameVersion: number;     // QUERY: NEVER
//         };
 
//         // =====================================================================
//         // COLLECTION: racks
//         // Path: users/{businessId}/racks/{rackId}
//         // HIERARCHY: Warehouse → Zone → Rack → Shelf → Placements → UPCs
//         // =====================================================================
//         racks: {
//             /** Document ID = rack code (uppercase). Immutable. QUERY: MEDIUM */
//             id: string;
//             /** Display name (e.g. "Rack B"). QUERY: LOW */
//             name: string;
//             code: string;  // QUERY: NEVER
//             /** QUERY: HIGH — always filter isDeleted == false. */
//             isDeleted: boolean;
//             /** Parent warehouse. QUERY: MEDIUM */
//             warehouseId: string;
//             /** Parent zone. QUERY: HIGH — list all racks in a zone. */
//             zoneId: string;
//             position: number; // Sort order within zone. QUERY: LOW
//             /** Pre-aggregated counts. QUERY: LOW */
//             stats: { totalShelves: number; totalProducts: number; };
//             deletedAt: Timestamp | null;
//             createdAt: Timestamp;
//             createdBy: string;
//             updatedAt: Timestamp;
//             updatedBy: string;
//             locationVersion: number; // QUERY: NEVER
//             nameVersion: number;     // QUERY: NEVER
//         };
 
//         // =====================================================================
//         // COLLECTION: shelves
//         // Path: users/{businessId}/shelves/{shelfId}
//         // HIERARCHY: Warehouse → Zone → Rack → Shelf → Placements → UPCs
//         // The lowest level of the hierarchy. UPCs are placed directly onto shelves.
//         // Referenced by placements.shelfId and upcs.shelfId.
//         // =====================================================================
//         shelves: {
//             /** Document ID = shelf code (uppercase). Immutable. QUERY: MEDIUM */
//             id: string;
//             /** Display name (e.g. "Shelf A1"). QUERY: LOW */
//             name: string;
//             code: string;          // QUERY: NEVER
//             capacity: number | null; // Max units. Informational. QUERY: NEVER
//             /** QUERY: HIGH — always filter isDeleted == false. */
//             isDeleted: boolean;
//             /** Parent warehouse. Updated automatically on move. QUERY: MEDIUM */
//             warehouseId: string;
//             /** Parent zone. QUERY: MEDIUM */
//             zoneId: string;
//             /** Parent rack. QUERY: HIGH — list all shelves in a rack. */
//             rackId: string;
//             position: number; // Sort order within rack. QUERY: LOW
//             /** Distinct products currently placed on this shelf. QUERY: LOW */
//             stats: { totalProducts: number; };
//             deletedAt: Timestamp | null;
//             createdAt: Timestamp;
//             createdBy: string;
//             updatedAt: Timestamp;
//             updatedBy: string;
//             locationVersion: number; // QUERY: NEVER
//             nameVersion: number;     // QUERY: NEVER
//         };
//     };
// }
// interface Store {
//     orders: {};
//     products: {};
// }