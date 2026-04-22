// =============================================================================
// BUSINESS MODULE — database-desc.ts
// =============================================================================
// Describes all Firestore collections scoped to a specific business.
// Base path for all collections in this module: users/{businessId}/...
//
// A "business" is the top-level organizational unit in Majime. One business
// can own multiple Shopify stores, multiple warehouses, and multiple members.
// businessId is the Firestore document ID under the users/ collection.
//
// MODULES IN THIS INTERFACE:
//   B2B       — B2B order management, BOM, lot production (section pending)
//   Warehouse — inventory, procurement, UPC tracking, warehouse structure
//
// CROSS-MODULE RELATIONSHIPS:
//   Warehouse.products.mappedVariants[].storeId + variantId
//     → Store.products.variantMappingDetails[variantId]   (bidirectional mapping)
//   Warehouse.upcs.orderId + storeId
//     → Store.orders (UPC linked to a specific order at pickup time)
//   Warehouse.grns → Warehouse.purchaseOrders → Warehouse.parties
//     (procurement chain: party → PO → GRN → UPCs)
//   Warehouse.inventory_snapshots → Warehouse.products
//     (daily snapshot of each product's stock, used in gross profit reports)
//
// QUERY INTENSITY TAGS (used throughout this file and the store module):
//   QUERY: HIGH   — frequently filtered, grouped, or sorted on
//   QUERY: MEDIUM — occasionally filtered or used in joins
//   QUERY: LOW    — display / informational only; avoid in queries
//   QUERY: NEVER  — internal/trigger/dead field; not useful analytically
// =============================================================================
interface Business {

    // =============================================================================
    // B2B MODULE — NOT IN PRODUCTION
    // =============================================================================
    // The B2B module is under active development and has NOT been deployed.
    // No collections, documents, or data exist for this module in the database.
    //
    // AGENT INSTRUCTION (STRICT):
    //   Any user question that directly or indirectly touches B2B — including but
    //   not limited to B2B orders, BOM (Bill of Materials), lot production, B2B
    //   customers, B2B pricing, or B2B reporting — must be rejected immediately.
    //   Do NOT attempt to query any collection, do NOT speculate about data structure,
    //   and do NOT partially answer using other modules as a proxy.
    //
    //   Respond with exactly:
    //   "The B2B module is not yet in production. I can't answer questions related
    //    to B2B orders, BOM, or lot production at this time."
    // 
    //   The related interfaces (along with their future Firestore document paths) are still mentioned inside the B2B module, which may
    //   help you identify if any B2B collection is being used in the queries or not.
    //   Gives more clearity whether to reject the question or not.
    // =============================================================================
    B2B: {
        /**
         * Path: users/{businessId}/b2b/bom/{bomId}
         */
        bom: {
            id: string;
            productId: string;
            productName: string;
            productSku: string;
            stages: {
                stage: string;
                materials: {
                    materialId: string;
                    materialName: string;
                    materialUnit: string;
                    quantityPerPiece: number;
                    wastagePercent: number;
                }[];
            }[];
            isActive: boolean;
            createdAt: Timestamp;
            updatedAt: Timestamp;
        };
        /**
         * Path: users/{businessId}/b2b/buyers/{buyerId}
         */
        buyers: {
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
        };
        /**
         * Path: users/{businessId}/b2b/finished_goods/{finished_good_id}
         */
        finished_goods: {
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
        };
        /**
         * Path: users/{businessId}/b2b/lot_stage_history/{lot_stage_history_id}
         */
        lot_stage_history: {
            id: string;
            lotId: string;
            lotNumber: string;
            orderId: string;
            fromStage: string | null;
            toStage: string;
            fromSequence: number | null;
            toSequence: number;
            movedBy: string | null;
            movedAt: Timestamp;
            note: string | null;
        };
        /**
         * Path: users/{businessId}/b2b/lots/{lotId}
         */
        lots: {
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
            stages: {
                sequence: number;
                stage: string;
                plannedDate: Timestamp;
                actualDate: Timestamp | null;
                status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "BLOCKED";
                isOutsourced: boolean;
                outsourceVendorName: string | null;
                outsourceSentAt: Timestamp | null;
                outsourceReturnedAt: Timestamp | null;
                completedBy: string | null;
                note: string | null;
            }[];
            currentStage: string;
            currentSequence: number;
            totalStages: number;
            shipDate: Timestamp;
            isDelayed: boolean;
            delayDays: number;
            bomId: string | null;
            bomSnapshot: {
                stage: string;
                materials: {
                    materialId: string;
                    materialName: string;
                    materialUnit: string;
                    quantityPerPiece: number;
                    wastagePercent: number;
                    totalQuantity: number;
                }[];
            }[];
            status: "ACTIVE" | "COMPLETED" | "CANCELLED" | "ON_HOLD";
            createdBy: string;
            createdAt: Timestamp;
            updatedAt: Timestamp;
        };
        /**
         * Path: users/{businessId}/b2b/material_transactions/{material_transactions_id}
         */
        material_transactions: {
            id: string;
            materialId: string;
            materialName: string;
            type: "PURCHASE" | "ADJUSTMENT";
            quantity: number;
            stockBefore: number;
            stockAfter: number;
            referenceId: string | null;
            referenceType: "PURCHASE" | "ADJUSTMENT" | null;
            note: string | null;
            createdBy: string;
            createdAt: Timestamp;
        };
        /**
         * Path: users/{businessId}/b2b/orders/{orderId}
         */
        orders: {
            id: string;
            orderNumber: string;
            buyerId: string;
            buyerName: string;
            buyerContact: string;
            shipDate: Timestamp;
            deliveryAddress: string;
            draftLots: {
                productId: string;
                productName: string;
                productSku: string;
                color: string;
                size: string | null;
                quantity: number;
                stages: Array<{
                    stage: string;
                    plannedDate: string;  // ISO string
                    isOutsourced: boolean;
                    outsourceVendorName: string | null;
                }>;
                bomId: string | null;
                customBOM: {
                    stage: string;
                    materials: {
                        materialId: string;
                        materialName: string;
                        materialUnit: string;
                        quantityPerPiece: number;
                        wastagePercent: number;
                        totalQuantity: number;
                    }[];
                }[] | null;
            }[] | null;
            totalLots: number;
            totalQuantity: number;
            lotsCompleted: number;
            lotsInProduction: number;
            lotsDelayed: number;
            status: "DRAFT" | "CONFIRMED" | "IN_PRODUCTION" | "COMPLETED" | "CANCELLED";
            note: string | null;
            createdBy: string;
            createdAt: Timestamp;
            updatedAt: Timestamp;
        };
        /**
         * Path: users/{businessId}/b2b/production_stage_config/{production_stage_config_id}
         */
        production_stage_config: {
            id: string;
            name: string;
            label: string;
            description: string;
            defaultDurationDays: number;
            canBeOutsourced: boolean;
            sortOrder: number;
            createdAt: Timestamp;
        };
        /**
         * Path: users/{businessId}/b2b/raw_materials/{raw_material_id}
         */
        raw_materials: {
            id: string;
            name: string;
            sku: string;
            unit: string;
            category: string;
            totalStock: number;
            availableStock: number;
            reorderLevel: number;
            supplierName: string | null;
            isActive: boolean;
            createdAt: Timestamp;
            updatedAt: Timestamp;
        };
    };

    // =============================================================================
    // WAREHOUSE MODULE — database-desc.ts
    // =============================================================================
    // This module describes every Firestore collection in the Warehouse domain.
    //
    // COLLECTION READ ORDER (most analytically important first):
    //   products → purchaseOrders → grns → upcs → placements
    //   → upcsLogs → inventory_snapshots → parties
    //   → warehouses → zones → racks → shelves
    //
    // FIELD ORDERING WITHIN EACH COLLECTION:
    //   1. Identity fields (document ID, human-readable label)
    //   2. Status / lifecycle (the primary filter field)
    //   3. Foreign keys / relationships (what this doc links to)
    //   4. Core data fields (quantities, amounts, computed totals)
    //   5. Embedded arrays (flattened for per-item analytics)
    //   6. Date fields used for range filtering
    //   7. Metadata (createdAt/By, updatedAt/By) — rarely queried
    //   8. Internal / versioning fields — never query
    //
    // QUERY INTENSITY TAGS (used per field):
    //   QUERY: HIGH   — frequently filtered, grouped, or sorted on
    //   QUERY: MEDIUM — occasionally filtered or used in joins
    //   QUERY: LOW    — display / informational only; avoid in queries
    //   QUERY: NEVER  — internal/trigger field; not useful analytically
    // =============================================================================
    Warehouse: {

        // =====================================================================
        // COLLECTION: products
        // Path: users/{businessId}/products/{sku}
        // =====================================================================
        // The central product record for the warehouse system. Document ID = SKU.
        // Every other warehouse entity (UPCs, placements, GRNs, PO items,
        // inventory snapshots) references this document via the `sku` / `productId` field.
        //
        // STOCK FORMULAS (derive from inventory counters — never store separately):
        //   physicalStock  = openingStock + inwardAddition + autoAddition
        //                    - deduction - autoDeduction
        //   availableStock = physicalStock - blockedStock
        //   inShelfQuantity is a separately maintained real-time count of units
        //   physically sitting on shelves (putAway: "none"), distinct from physicalStock.
        //
        // CHANGE FLOW:
        //   An order item change → check if mapped to this product via mappedVariants
        //     → (yes) UPC doc update → onUpcWritten trigger → updates inventory counters here
        //     → (no)  nothing
        //
        // TYPICAL QUERIES:
        //   - Fetch all products for a category filter
        //   - Look up price/taxRate/hsn for gross profit calculations
        //   - Read inShelfQuantity to check pickup eligibility
        //   - Read inventory counters to compute physicalStock / availableStock
        // =====================================================================
        products: {

            // -- IDENTITY -----------------------------------------------------

            /**
             * Unique product SKU. Also the Firestore document ID.
             * Always uppercase (e.g. "TSHIRT-BLU-M").
             * This is the primary join key — referenced as `productId` on UPCs,
             * placements, inventory_snapshots, GRN items, and PO items.
             * QUERY: HIGH — use as an equality filter when looking up a specific product.
             */
            sku: string;

            /**
             * Human-readable product name (e.g. "Cotton Crew Neck T-Shirt – Blue M").
             * QUERY: LOW — display only; search by sku instead.
             */
            name: string;

            /**
             * Product category (e.g. "T-Shirts", "Denim", "Accessories").
             * QUERY: HIGH — group by category for category-level inventory or sales reports.
             *               Filter by category to narrow product lists.
             */
            category: string;

            // -- LIVE STOCK COUNTS --------------------------------------------

            /**
             * Real-time count of units physically sitting on warehouse shelves
             * and immediately available for pickup (putAway == "none").
             * Incremented when any UPC for this product transitions to putAway "none";
             * decremented when any UPC leaves "none" (picked up or moved out).
             * Used by the order pickup flow to determine if a Confirmed order
             * has enough physical units to proceed.
             * NOTE: Reflects shelf stock only — does not include inbound units (awaiting put-away).
             *       physicalStock (computed from inventory counters) is the authoritative total.
             * QUERY: HIGH — filter inShelfQuantity > 0 to find products available for pickup;
             *               sort descending to see most stocked items.
             */
            inShelfQuantity: number;

            /**
             * Embedded inventory counters maintained exclusively by Firestore triggers.
             * Never update these directly. Use them to derive physicalStock and availableStock.
             * All fields are cumulative running totals — they are never reset.
             * QUERY: MEDIUM — read as a group to compute stock figures; individual sub-fields
             *                 are rarely useful as Firestore filters in isolation.
             */
            inventory: {

                /**
                 * Always initialized to 0 and has no role in stock computation.
                 * Retained for schema consistency only. Will be deprecated.
                 * QUERY: NEVER
                 */
                openingStock: number;

                /**
                 * Cumulative units received into stock from GRN put-away.
                 * Incremented when a GRN-sourced UPC (grnRef set, no storeId/orderId)
                 * transitions from putAway "inbound" → "none".
                 * This is the primary source of net-new stock from supplier purchases.
                 * QUERY: NEVER — use totalReceivedValue on GRN docs for purchase analytics instead.
                 */
                inwardAddition: number;

                /**
                 * Cumulative units deducted via credit note dispatch.
                 * Incremented by onUpcWritten when a UPC transitions outbound → null
                 * and creditNoteRef is set on that UPC.
                 * Unlike autoDeduction, no blockedStock change accompanies this counter.
                 * QUERY: NEVER — use the credit_notes collection for CN analytics instead.
                 */
                deduction: number;

                /**
                 * Cumulative units deducted when an order shipment leaves the warehouse.
                 * Incremented by onUpcWritten when a UPC transitions outbound → null
                 * and creditNoteRef is absent (i.e., the unit was dispatched via courier).
                 * Always decremented alongside blockedStock.
                 * QUERY: NEVER — use order collections for sales analytics instead.
                 */
                autoDeduction: number;

                /**
                 * Cumulative units added back from order returns
                 * (RTO Closed and Pending Refunds QC Pass flows).
                 * Incremented by onUpcWritten when a UPC with storeId + orderId set
                 * transitions to putAway "inbound".
                 * QUERY: NEVER — use order return statuses for return analytics instead.
                 */
                autoAddition: number;

                /**
                 * Units currently reserved by active orders (New, Confirmed, Ready To Dispatch).
                 * Incremented when an order enters an active status for a mapped variant;
                 * decremented on dispatch or cancellation.
                 * Managed by the updateOrderCounts trigger and fully recomputed by
                 * onProductWritten whenever mappedVariants changes.
                 * Used in formula: availableStock = physicalStock - blockedStock.
                 * QUERY: NEVER — read as part of the inventory object; not a useful filter in isolation.
                 */
                blockedStock: number;
            };

            /**
             * Shopify variant mappings for this product. Each entry links this SKU
             * to one variant on one Shopify store. A product can map to many variants
             * across many stores simultaneously.
             *
             * This mapping drives three things:
             *   1. Inventory blocking: when a mapped variant's order arrives, blockedStock increments.
             *   2. Shopify sync: onProductWritten pushes stock levels to Shopify on mapping change.
             *   3. UPC assignment: during order pickup, UPCs are linked to the order via storeId/orderId.
             *
             * The same mapping is stored bidirectionally on accounts/{storeId}/products/{productId}
             * under variantMappingDetails[variantId].
             *
             * QUERY: MEDIUM — rarely filtered directly; used for cross-referencing orders to products.
             */
            mappedVariants: {
                /**
                 * Shopify store domain (e.g. "my-store.myshopify.com").
                 * Links to accounts/{storeId}. Use alongside variantId to locate order line items.
                 * QUERY: MEDIUM — filter by storeId when scoping to a single store's products.
                 */
                storeId: string;

                /**
                 * Shopify variant ID (numeric). Primary join key between order line items and products.
                 * Order line items carry this as raw.line_items[].variant_id.
                 * To resolve a line item to a business product:
                 *   accounts/{storeId}/products/{productId}.variantMappingDetails[variantId].businessProductSku
                 * QUERY: MEDIUM — equality filter when tracing a specific variant back to its SKU.
                 */
                variantId: number;

                /**
                 * Shopify product document ID.
                 * Links to accounts/{storeId}/products/{productId}.
                 * QUERY: LOW — only needed when reading the store-side product document.
                 */
                productId: string;

                /**
                 * Shopify product title (denormalized). Display only.
                 * QUERY: NEVER
                 */
                productTitle: string;

                /**
                 * Shopify variant SKU (denormalized). May differ from the business SKU.
                 * QUERY: NEVER
                 */
                variantSku: string;

                /**
                 * Shopify variant title (e.g. "Blue / M"). Display only.
                 * QUERY: NEVER
                 */
                variantTitle: string;

                /**
                 * ISO string timestamp of when this variant was mapped to this product.
                 * QUERY: LOW — can sort mappings by date if needed.
                 */
                mappedAt: string;
            }[];

            // -- FINANCIAL / LOGISTICS ATTRIBUTES ----------------------------

            /**
             * COGS (Cost of Goods Sold) per unit in INR, ex-tax.
             * Used in the gross profit report for opening stock and closing stock valuation.
             * QUERY: MEDIUM — read when computing stock value; multiply by physicalStock.
             */
            price: number;

            /**
             * GST tax rate as a percentage (e.g. 5, 12, 18, 28).
             * Applied as: taxable_amount × taxRate / 100.
             * Used in GRN bill PDFs and the gross profit Purchase row tax calculation.
             * QUERY: MEDIUM — read when computing tax-inclusive purchase values.
             */
            taxRate: number;

            /**
             * HSN (Harmonised System of Nomenclature) code for GST classification.
             * Always uppercase (e.g. "6109"). Used in GRN bills, tax reports, and GP reports.
             * QUERY: MEDIUM — group by hsn for HSN-level tax summaries.
             */
            hsn: string;

            /**
             * Product weight in grams. Used in courier weight calculations during dispatch.
             * QUERY: LOW — informational; rarely filtered analytically.
             */
            weight: number;

            /**
             * Optional free-text description. May be null.
             * QUERY: NEVER — display only.
             */
            description: string | null;

            // -- METADATA -----------------------------------------------------

            /**
             * Firestore Timestamp. When this product doc was first created.
             * QUERY: LOW — can filter products created in a date range.
             */
            createdAt: Timestamp;

            /**
             * UID of the user who created this product.
             * QUERY: NEVER
             */
            createdBy: string;

            /**
             * Firestore Timestamp. When this product was last updated.
             * QUERY: NEVER
             */
            updatedAt: Timestamp;

            /**
             * UID of the user who last updated this product.
             * QUERY: NEVER
             */
            updatedBy: string;
        };


        // =====================================================================
        // COLLECTION: purchaseOrders
        // Path: users/{businessId}/purchaseOrders/{poId}
        // =====================================================================
        // A Purchase Order (PO) represents a planned procurement from a supplier.
        // POs are the prerequisite for GRN creation — a GRN can only be raised
        // against a PO in "confirmed" or "partially_received" status.
        // As GRNs are confirmed, they write back into items[].receivedQty here
        // and the system recalculates the PO's overall status.
        //
        // RELATIONSHIPS:
        //   supplierPartyId → users/{businessId}/parties/{partyId}
        //   warehouseId     → users/{businessId}/warehouses/{warehouseId}
        //   items[].sku     → users/{businessId}/products/{sku}
        //   Referenced by   → users/{businessId}/grns/{grnId}.poId
        //
        // TYPICAL QUERIES:
        //   - Filter by status to find open/pending POs
        //   - Filter by supplierPartyId to see all POs for a supplier
        //   - Filter orderedSkus array-contains to find POs for a specific product
        //   - Sum totalAmount for total purchase commitment in a date range
        // =====================================================================
        purchaseOrders: {

            // -- IDENTITY -----------------------------------------------------

            /**
             * Firestore document ID of this PO.
             * QUERY: MEDIUM — equality filter when looking up a specific PO.
             */
            id: string;

            /**
             * Human-readable PO number (e.g. "PO-00042"). Auto-generated sequentially.
             * Denormalized onto grns.poNumber so GRN lists display the PO reference
             * without an extra read.
             * QUERY: MEDIUM — equality filter when the user searches by PO number.
             */
            poNumber: string;

            /**
             * The business this PO belongs to. Always matches the path segment.
             * QUERY: NEVER — implicit in the collection path.
             */
            businessId: string;

            // -- STATUS -------------------------------------------------------

            /**
             * Current lifecycle status.
             * "draft"              — created, not yet approved or sent to supplier.
             * "confirmed"          — approved; GRNs can now be raised against this PO.
             * "partially_received" — at least one item partially received across one or more GRNs.
             * "fully_received"     — all items fully received (receivedQty >= expectedQty).
             * "closed"             — manually closed; no further GRNs accepted.
             * "cancelled"          — voided; no GRNs allowed.
             * QUERY: HIGH — primary filter. Filter status == "confirmed" | "partially_received"
             *               to find open POs. Filter "cancelled" | "closed" for historical analysis.
             */
            status: 'draft' | 'confirmed' | 'partially_received' | 'fully_received' | 'closed' | 'cancelled';

            // -- RELATIONSHIPS ------------------------------------------------

            /**
             * Supplier party ID. Links to users/{businessId}/parties/{partyId}.
             * Must be a party with type "supplier" or "both" and isActive: true at creation time.
             * QUERY: HIGH — filter by supplierPartyId to see all POs from a specific supplier.
             *               Group by supplierPartyId for per-supplier purchase summaries.
             */
            supplierPartyId: string;

            /**
             * Denormalized supplier name from parties.name.
             * Stored to avoid a join when rendering PO lists.
             * QUERY: LOW — use supplierPartyId for filtering; name is for display.
             */
            supplierName: string;

            /**
             * ID of the destination warehouse. Links to users/{businessId}/warehouses/{warehouseId}.
             * QUERY: MEDIUM — filter by warehouseId to scope POs to a specific warehouse.
             */
            warehouseId: string;

            /**
             * Denormalized warehouse name. Null if not available at creation time.
             * QUERY: NEVER — display only.
             */
            warehouseName: string | null;

            // -- CORE DATA ----------------------------------------------------

            /**
             * Flat array of all SKUs in this PO (one entry per distinct SKU in items[]).
             * Useful for "which POs include SKU X?" without flattening items[].
             * Each value links to users/{businessId}/products/{sku}.
             * QUERY: HIGH — use array-contains filter: orderedSkus array-contains "SKU-X"
             *               to find all POs that include a given product.
             */
            orderedSkus: string[];

            /**
             * Count of distinct SKUs ordered. Always equals items.length.
             * QUERY: LOW — informational count; rarely filtered on.
             */
            itemCount: number;

            /**
             * Total PO value: sum of (items[].expectedQty × items[].unitCost).
             * Pre-computed at creation and on edits. Use directly — do not recompute.
             * Does not include tax.
             * QUERY: MEDIUM — sum this field across filtered POs for total purchase commitment.
             */
            totalAmount: number;

            /**
             * Currency code (e.g. "INR"). Null if not specified (defaults to INR in practice).
             * QUERY: NEVER — all values are INR in practice.
             */
            currency: string | null;

            // -- EMBEDDED ITEMS -----------------------------------------------

            /**
             * Line items — one entry per distinct SKU ordered.
             * Updated in place by the GRN confirmation flow (receivedQty and notReceivedQty
             * are incremented each time a GRN against this PO is completed).
             * Flatten with flattenArrayField("items") to aggregate at the item level.
             * QUERY: MEDIUM — flatten and groupBy sku for per-product received quantity analysis.
             */
            items: {
                /**
                 * Product SKU. Links to users/{businessId}/products/{sku}.
                 * QUERY: HIGH (within flattened items) — primary groupBy key.
                 */
                sku: string;

                /**
                 * Denormalized product name. Display only.
                 * QUERY: NEVER
                 */
                productName: string;

                /**
                 * Cost per unit (ex-tax, INR). Copied to GRN items at GRN creation time.
                 * QUERY: MEDIUM (within flattened items) — multiply by receivedQty for line total.
                 */
                unitCost: number;

                /**
                 * Quantity ordered from supplier for this SKU.
                 * QUERY: MEDIUM — sum expectedQty across items to compare against receivedQty.
                 */
                expectedQty: number;

                /**
                 * Quantity received so far across all GRNs for this PO.
                 * Incremented by the grns/confirm-put-away API on each GRN completion.
                 * QUERY: MEDIUM — compare with expectedQty to identify shortfalls.
                 */
                receivedQty: number;

                /**
                 * expectedQty − receivedQty. Maintained automatically.
                 * QUERY: MEDIUM — filter notReceivedQty > 0 to find items with outstanding delivery.
                 */
                notReceivedQty: number;

                /**
                 * Per-item receipt status.
                 * "pending"            — nothing received yet.
                 * "partially_received" — some received, more expected.
                 * "fully_received"     — all ordered units received.
                 * "closed"             — manually closed without full receipt.
                 * QUERY: MEDIUM (within flattened items) — filter by status to count pending items.
                 */
                status: 'pending' | 'partially_received' | 'fully_received' | 'closed';
            }[];

            // -- DATE FIELDS --------------------------------------------------

            /**
             * Expected delivery date. Firestore Timestamp.
             * QUERY: MEDIUM — sort or filter to identify overdue POs (expectedDate < today).
             */
            expectedDate: Timestamp;

            /**
             * When the PO was moved to "confirmed" status. Null until confirmed.
             * QUERY: LOW — rarely filtered on directly.
             */
            confirmedAt: Timestamp | null;

            /**
             * When the PO was fully received or manually closed. Null until then.
             * QUERY: LOW — use for closure date analysis if needed.
             */
            completedAt: Timestamp | null;

            /**
             * When the PO was cancelled. Null unless cancelled.
             * QUERY: LOW
             */
            cancelledAt: Timestamp | null;

            /**
             * Reason provided when cancelling. Null if not cancelled.
             * QUERY: NEVER — display only.
             */
            cancelReason: string | null;

            /**
             * Free-text notes. Null if not set.
             * QUERY: NEVER
             */
            notes: string | null;

            // -- METADATA -----------------------------------------------------

            /**
             * Firestore Timestamp. When this PO was created.
             * QUERY: MEDIUM — filter createdAt range to find POs raised in a period.
             */
            createdAt: Timestamp;

            /**
             * UID of the user who created this PO.
             * QUERY: NEVER
             */
            createdBy: string;

            /**
             * Firestore Timestamp. When this PO was last updated.
             * QUERY: NEVER
             */
            updatedAt: Timestamp;
        };


        // =====================================================================
        // COLLECTION: grns
        // Path: users/{businessId}/grns/{grnId}
        // =====================================================================
        // A Goods Receipt Note (GRN) records the physical receipt of goods against a PO.
        // One PO can have multiple GRNs (partial deliveries).
        // On "Confirm Put Away", UPC documents are batch-created for each received unit
        // (putAway: "inbound") and the parent PO's receivedQty is updated.
        //
        // RELATIONSHIPS:
        //   poId        → users/{businessId}/purchaseOrders/{poId}
        //   warehouseId → users/{businessId}/warehouses/{warehouseId}
        //   items[].sku → users/{businessId}/products/{sku}
        //   Creates     → users/{businessId}/upcs/{upcId} (one per received unit)
        //   Referenced by → users/{businessId}/upcs/{upcId}.grnRef
        //
        // PRE-COMPUTED TOTALS — use directly, do not re-sum items[]:
        //   totalReceivedValue, totalExpectedQty, totalReceivedQty, totalNotReceivedQty
        //
        // TYPICAL QUERIES:
        //   - Filter status == "completed" + receivedAt range for purchase-by-period reports
        //   - Sum totalReceivedValue across completed GRNs for total spend
        //   - Filter receivedSkus array-contains "SKU-X" to find GRNs for a product
        //   - Flatten items[] and groupBy sku for per-product received quantity
        // =====================================================================
        grns: {

            // -- IDENTITY -----------------------------------------------------

            /**
             * Firestore document ID.
             * QUERY: MEDIUM — equality filter when looking up a specific GRN.
             */
            id: string;

            /**
             * Human-readable GRN number (e.g. "GRN-00015"). Auto-generated sequentially.
             * Denormalized onto upcs.grnRef for display.
             * QUERY: MEDIUM — equality filter when searching by GRN number.
             */
            grnNumber: string;

            /**
             * Business this GRN belongs to. Matches the path segment.
             * QUERY: NEVER — implicit in the collection path.
             */
            businessId: string;

            /**
             * Supplier's invoice/bill number for this delivery.
             * Must be unique across all GRNs in the business. Used in PDF bill filenames.
             * QUERY: MEDIUM — equality filter when reconciling against a supplier invoice.
             */
            billNumber: string;

            // -- STATUS -------------------------------------------------------

            /**
             * Lifecycle status.
             * "draft"     — GRN created; put-away not yet confirmed; UPCs do NOT exist yet.
             * "completed" — Put-away confirmed; UPCs created (putAway: "inbound");
             *               PO receivedQty updated. Terminal — cannot be edited.
             * "cancelled" — Voided; PO receivedQty reverted.
             * QUERY: HIGH — always filter status == "completed" for purchase analytics.
             *               Draft GRNs have no UPCs and must be excluded from reports.
             */
            status: 'draft' | 'completed' | 'cancelled';

            // -- RELATIONSHIPS ------------------------------------------------

            /**
             * ID of the linked Purchase Order. A GRN cannot exist without a PO.
             * Links to users/{businessId}/purchaseOrders/{poId}.
             * QUERY: HIGH — filter by poId to fetch all GRNs for a specific PO.
             *               Group by poId to count deliveries per PO.
             */
            poId: string;

            /**
             * Denormalized PO number (e.g. "PO-00042"). Display only — avoids a PO read.
             * QUERY: NEVER
             */
            poNumber: string;

            /**
             * ID of the warehouse where goods were received.
             * Links to users/{businessId}/warehouses/{warehouseId}.
             * QUERY: MEDIUM — filter by warehouseId to scope GRN analytics to one warehouse.
             */
            warehouseId: string;

            /**
             * Denormalized warehouse name. Null if not available at creation time.
             * QUERY: NEVER — display only.
             */
            warehouseName: string | null;

            // -- QUERYABLE PRODUCT SHORTCUT -----------------------------------

            /**
             * Flat array of all SKUs received in this GRN.
             * Allows filtering GRNs by product without flattening items[].
             * Each value links to users/{businessId}/products/{sku}.
             * QUERY: HIGH — array-contains filter: receivedSkus array-contains "SKU-X"
             *               to find all GRNs that included a given product.
             */
            receivedSkus: string[];

            // -- PRE-COMPUTED TOTALS (use directly) ---------------------------

            /**
             * Sum of all items[].totalCost. Taxable base value (ex-tax) in INR.
             * Pre-computed at GRN creation. Do not re-sum items[].totalCost.
             * Used in the gross profit Purchase row for total purchase value.
             * QUERY: HIGH — sum this field across completed GRNs for total purchase spend.
             */
            totalReceivedValue: number;

            /**
             * Sum of all items[].expectedQty. Pre-computed.
             * QUERY: LOW — informational; rarely aggregated directly.
             */
            totalExpectedQty: number;

            /**
             * Sum of all items[].receivedQty. Pre-computed.
             * QUERY: MEDIUM — sum across GRNs to get total units received in a period.
             */
            totalReceivedQty: number;

            /**
             * Sum of all items[].notReceivedQty. Pre-computed.
             * QUERY: LOW — use for delivery completeness tracking.
             */
            totalNotReceivedQty: number;

            // -- EMBEDDED ITEMS -----------------------------------------------

            /**
             * Line items — one per distinct SKU received.
             * Only items with receivedQty > 0 generate UPC docs on put-away confirmation.
             * Flatten with flattenArrayField("items") for per-SKU aggregation.
             * QUERY: MEDIUM — flatten, groupBy sku, sumGrouped receivedQty for per-product receipt report.
             */
            items: {
                /**
                 * Product SKU. Links to users/{businessId}/products/{sku}.
                 * QUERY: HIGH (within flattened items) — primary groupBy key.
                 */
                sku: string;

                /**
                 * Denormalized product name. Display only.
                 * QUERY: NEVER
                 */
                productName: string;

                /**
                 * Cost per unit (ex-tax, INR). Copied from PO items at GRN creation time.
                 * Used in gross profit: taxable = unitCost × receivedQty.
                 * QUERY: MEDIUM (within flattened items) — multiply by receivedQty for line total.
                 */
                unitCost: number;

                /**
                 * Remaining expected quantity for this item in this GRN delivery.
                 * QUERY: LOW — informational.
                 */
                expectedQty: number;

                /**
                 * Units physically received and confirmed for this line item.
                 * QUERY: MEDIUM (within flattened items) — sum for per-product received totals.
                 */
                receivedQty: number;

                /**
                 * expectedQty − receivedQty. Shortfall for this item in this GRN.
                 * QUERY: LOW — informational.
                 */
                notReceivedQty: number;

                /**
                 * Pre-computed line total: receivedQty × unitCost.
                 * QUERY: MEDIUM (within flattened items) — sum for per-SKU spend analysis.
                 */
                totalCost: number;
            }[];

            // -- DATE FIELDS --------------------------------------------------

            /**
             * When goods were physically received (put-away confirmed). Firestore Timestamp.
             * This is the CORRECT date field for all purchase-by-period queries.
             * Always filter on receivedAt — NOT createdAt — for purchase reports.
             * QUERY: HIGH — primary date filter for all GRN-based analytics.
             *               e.g. receivedAt >= startDate AND receivedAt <= endDate.
             */
            receivedAt: Timestamp;

            /**
             * When this GRN doc was created (draft stage). Firestore Timestamp.
             * Not meaningful for analytics — goods may not have arrived yet at this point.
             * QUERY: NEVER — use receivedAt for all date-based purchase queries.
             */
            createdAt: Timestamp;

            /**
             * When this GRN doc was last updated. Firestore Timestamp.
             * QUERY: NEVER
             */
            updatedAt: Timestamp;

            // -- METADATA -----------------------------------------------------

            /**
             * UID of the user who confirmed put-away (completed the GRN).
             * QUERY: NEVER
             */
            receivedBy: string;

            /**
             * Free-text notes (e.g. delivery condition, carrier info). Null if not set.
             * QUERY: NEVER
             */
            notes: string | null;
        };


        // =====================================================================
        // COLLECTION: upcs
        // Path: users/{businessId}/upcs/{upcId}
        // =====================================================================
        // Each UPC document represents ONE individual physical unit of a product.
        // Every unit entering or moving through the warehouse has its own doc.
        // The upcId is also the barcode value printed and scanned during operations.
        //
        // UPCs are currently created ONLY via GRN put-away (grnRef set, putAway: "inbound").
        // Creation via RTO/DTO order returns was discontinued because it generated UPC docs
        // without a corresponding purchase source, which distorted the gross profit report's
        // Quantity column — returned units appeared as new incoming stock with no offsetting entry.
        //
        // putAway STATE MACHINE:
        //   "inbound"  — received from GRN; awaiting shelf placement.
        //                All location fields (warehouseId, zoneId, rackId, shelfId,
        //                placementId) are null in this state.
        //   "none"     — placed on a shelf. All location fields populated.
        //                inShelfQuantity on the product doc increments on → "none",
        //                decrements on "none" → anything else.
        //   "outbound" — picked for dispatch (order or credit note).
        //                If creditNoteRef is set: reserved for credit note removal.
        //                If creditNoteRef is null + orderId set: reserved for courier dispatch.
        //   null       — left the warehouse. Terminal state. Doc is never deleted.
        //                If creditNoteRef was set: CN dispatch → deduction++.
        //                If creditNoteRef was null: order fulfilled → autoDeduction++ + blockedStock--.
        //
        // RELATIONSHIPS:
        //   productId     → users/{businessId}/products/{sku}           [always set]
        //   grnRef        → users/{businessId}/grns/{grnId}             [set at creation, never changes]
        //   creditNoteRef → users/{businessId}/credit_notes/{cnId}      [set when reserved for CN]
        //   storeId       → accounts/{storeId}                          [set during order pickup]
        //   orderId       → accounts/{storeId}/orders/{orderId}         [set during order pickup]
        //   warehouseId   → users/{businessId}/warehouses/{warehouseId} [set when putAway == "none"]
        //   zoneId        → users/{businessId}/zones/{zoneId}           [set when putAway == "none"]
        //   rackId        → users/{businessId}/racks/{rackId}           [set when putAway == "none"]
        //   shelfId       → users/{businessId}/shelves/{shelfId}        [set when putAway == "none"]
        //   placementId   → users/{businessId}/placements/{productId}_{shelfId}
        //
        // TYPICAL QUERIES:
        //   - Filter putAway == "inbound" to find units awaiting put-away
        //   - Filter putAway == "none" + productId to count on-shelf stock per product
        //   - Filter putAway == "none" + shelfId/rackId/zoneId for location audits
        //   - Filter grnRef + productId to trace a unit back to its receipt
        //   NOTE: For on-shelf count queries, prefer placements.quantity (pre-aggregated)
        //         over counting UPC docs directly — it is far more efficient.
        // =====================================================================
        upcs: {

            // -- IDENTITY -----------------------------------------------------

            /**
             * Unique UPC identifier. Also the barcode value scanned during put-away
             * and packaging operations. Generated as a nanoid at UPC creation.
             * QUERY: MEDIUM — equality filter when looking up a specific unit by barcode.
             */
            id: string;

            // -- STATE --------------------------------------------------------

            /**
             * Current physical state of this unit in the warehouse.
             * The single most important field — determines everything about this UPC's context.
             * See the STATE MACHINE in the collection header above.
             * Values: "inbound" | "none" | "outbound" | null
             * QUERY: HIGH — always filter by putAway to scope UPC queries to a lifecycle stage.
             *               e.g. putAway == "inbound" for pending put-away list.
             *               e.g. putAway == "none" for on-shelf stock audit.
             *               NOTE: querying putAway == null is valid — Firestore treats null
             *               as an explicit stored value (use == null operator).
             */
            putAway: "inbound" | "none" | "outbound" | null;

            // -- RELATIONSHIPS ------------------------------------------------

            /**
             * SKU of the product this unit represents.
             * Links to users/{businessId}/products/{sku}.
             * QUERY: HIGH — always include when grouping UPCs by product.
             *               Filter productId == "SKU-X" to count units of a specific product.
             */
            productId: string;

            /**
             * GRN document ID this UPC was created from.
             * Set at creation time (GRN put-away) and never changes afterward.
             * Links to users/{businessId}/grns/{grnId}.
             * QUERY: MEDIUM — filter by grnRef to find all units received in a specific GRN.
             */
            grnRef: string | null;

            /**
             * Credit note document ID, set when this UPC is reserved for a CN return dispatch.
             * Null for all order-dispatched or shelf-resting UPCs.
             * Links to users/{businessId}/credit_notes/{cnId}.
             * QUERY: MEDIUM — filter creditNoteRef != null to find units reserved for CN dispatch.
             */
            creditNoteRef: string | null;

            /**
             * Shopify store domain, set during order pickup when a Confirmed order
             * claims this UPC for dispatch. Null until claimed.
             * Links to accounts/{storeId}.
             * QUERY: MEDIUM — filter by storeId to scope UPCs to a specific store.
             */
            storeId: string | null;

            /**
             * Shopify order ID, set alongside storeId during order pickup.
             * Null until an order claims this UPC.
             * Links to accounts/{storeId}/orders/{orderId}.
             * QUERY: MEDIUM — filter by orderId to find all units dispatched for a specific order.
             */
            orderId: string | null;

            // -- LOCATION FIELDS (populated only when putAway == "none") ------

            /**
             * Warehouse where this unit is currently located.
             * Populated when putAway transitions to "none". Null in all other states.
             * Links to users/{businessId}/warehouses/{warehouseId}.
             * QUERY: MEDIUM — filter to scope a stock audit to a specific warehouse.
             */
            warehouseId: string | null;

            /**
             * Zone within the warehouse.
             * Populated when putAway == "none". Null otherwise.
             * Links to users/{businessId}/zones/{zoneId}.
             * QUERY: MEDIUM — filter for zone-level stock audit.
             */
            zoneId: string | null;

            /**
             * Rack within the zone.
             * Populated when putAway == "none". Null otherwise.
             * Links to users/{businessId}/racks/{rackId}.
             * QUERY: LOW — rarely filtered at rack level.
             */
            rackId: string | null;

            /**
             * Shelf within the rack.
             * Populated when putAway == "none". Null otherwise.
             * Links to users/{businessId}/shelves/{shelfId}.
             * QUERY: MEDIUM — filter shelfId to audit contents of a specific shelf.
             */
            shelfId: string | null;

            /**
             * Placement document ID: format "{productId}_{shelfId}".
             * Populated when putAway == "none". Null otherwise.
             * Links to users/{businessId}/placements/{placementId}.
             * QUERY: LOW — use placements collection directly for placement-level stock counts.
             */
            placementId: string | null;

            // -- METADATA -----------------------------------------------------

            /**
             * Firestore Timestamp. When this UPC was created.
             * QUERY: MEDIUM — filter createdAt range to find UPCs received in a period.
             */
            createdAt: Timestamp;

            /**
             * Firestore Timestamp. When this UPC last changed state (putAway transition).
             * QUERY: LOW — useful for identifying stale inbound UPCs not yet put away.
             */
            updatedAt: Timestamp;

            /**
             * UID of the user or system that created this UPC.
             * QUERY: NEVER
             */
            createdBy: string;

            /**
             * UID of the user or system that last updated this UPC.
             * QUERY: NEVER
             */
            updatedBy: string;
        };


        // =====================================================================
        // COLLECTION: placements
        // Path: users/{businessId}/placements/{placementId}
        // =====================================================================
        // A placement is a pre-aggregated stock count for one product at one shelf.
        // Document ID format: "{productId}_{shelfId}" — deterministic, not random.
        // quantity reflects the live count of UPCs with putAway == "none" at this location.
        // Maintained by the onUpcWritten trigger — no manual writes needed.
        //
        // PREFER placements over counting UPC docs for stock-at-location queries.
        // Reading one placement doc is O(1); counting UPCs is O(n).
        //
        // RELATIONSHIPS:
        //   productId   → users/{businessId}/products/{sku}
        //   warehouseId → users/{businessId}/warehouses/{warehouseId}
        //   zoneId      → users/{businessId}/zones/{zoneId}
        //   rackId      → users/{businessId}/racks/{rackId}
        //   shelfId     → users/{businessId}/shelves/{shelfId}
        //   Referenced by → users/{businessId}/upcs/{upcId}.placementId
        //
        // TYPICAL QUERIES:
        //   - Filter productId to find all shelf locations for a product
        //   - Filter shelfId to see all products on a shelf
        //   - Filter warehouseId + productId + quantity > 0 for non-empty placements
        //   - Sum quantity across placements for a product = total on-shelf stock
        // =====================================================================
        placements: {

            // -- IDENTITY -----------------------------------------------------

            /**
             * Document ID. Format: "{productId}_{shelfId}".
             * Deterministic — computed from the two foreign keys, not random.
             * Used as placementId on UPC docs.
             * QUERY: MEDIUM — equality filter when looking up stock at a specific product+shelf.
             */
            id: string;

            // -- CORE DATA ----------------------------------------------------

            /**
             * Current count of units (UPCs with putAway == "none") at this location.
             * Maintained by onUpcWritten. Use this instead of counting UPC docs.
             * QUERY: HIGH — filter quantity > 0 to find occupied placements;
             *               sum across placements for a product = total on-shelf stock.
             */
            quantity: number;

            // -- RELATIONSHIPS ------------------------------------------------

            /**
             * SKU of the product stored here.
             * Links to users/{businessId}/products/{sku}.
             * QUERY: HIGH — filter productId to find all locations for a given product.
             */
            productId: string;

            /**
             * Warehouse containing this placement.
             * Links to users/{businessId}/warehouses/{warehouseId}.
             * QUERY: MEDIUM — filter to scope placement queries to a warehouse.
             */
            warehouseId: string;

            /**
             * Zone within the warehouse.
             * Links to users/{businessId}/zones/{zoneId}.
             * QUERY: LOW — rarely filtered at zone level for placement queries.
             */
            zoneId: string;

            /**
             * Rack within the zone.
             * Links to users/{businessId}/racks/{rackId}.
             * QUERY: LOW
             */
            rackId: string;

            /**
             * Shelf within the rack.
             * Links to users/{businessId}/shelves/{shelfId}.
             * QUERY: MEDIUM — filter shelfId to see all products on a shelf.
             */
            shelfId: string;

            // -- AUDIT --------------------------------------------------------

            /**
             * Human-readable reason for the last stock movement (e.g. "put-away", "dispatch").
             * Null if not recorded.
             * QUERY: NEVER — informational audit trail.
             */
            lastMovementReason: string | null;

            /**
             * Reference ID for the last movement (e.g. GRN number, order ID). Null if not set.
             * QUERY: NEVER
             */
            lastMovementReference: string | null;

            // -- INTERNAL -----------------------------------------------------

            /**
             * Internal flag read by the onPlacementWritten trigger.
             * When true on a write with a positive quantity diff, the trigger
             * auto-creates UPC docs (one per unit). Irrelevant for analytical queries.
             * QUERY: NEVER
             */
            createUPCs: boolean;

            // -- METADATA -----------------------------------------------------

            /**
             * Firestore Timestamp. When this placement was first created.
             * QUERY: NEVER
             */
            createdAt: Timestamp;

            /**
             * Firestore Timestamp. When this placement's quantity last changed.
             * QUERY: LOW — can identify stale placements (not touched recently).
             */
            updatedAt: Timestamp;

            /**
             * UID of the user who created this placement.
             * QUERY: NEVER
             */
            createdBy: string;

            /**
             * UID of the user who last updated this placement.
             * QUERY: NEVER
             */
            updatedBy: string;
        };


        // =====================================================================
        // COLLECTION: upcsLogs
        // Path: users/{businessId}/upcsLogs/{upcsLogsId}
        // =====================================================================
        // Flat audit log of every tracked state change on every UPC.
        // One entry is written per change event on a UPC's putAway, location,
        // storeId, or orderId fields.
        // A parallel copy also exists as a subcollection at:
        //   users/{businessId}/upcs/{upcId}/logs/{logId}
        // This flat collection is preferred when querying logs without knowing the upcId.
        //
        // RELATIONSHIPS:
        //   upcId     → users/{businessId}/upcs/{upcId}
        //   productId → users/{businessId}/products/{sku}
        //   grnRef    → users/{businessId}/grns/{grnId}  (if applicable)
        //
        // TYPICAL QUERIES:
        //   - Filter upcId to get the full movement history of a unit
        //   - Filter productId + timestamp range for product-level movement audit
        //   - Filter grnRef to trace all movements of units from a specific GRN
        // =====================================================================
        upcsLogs: {

            // -- RELATIONSHIPS ------------------------------------------------

            /**
             * The UPC this log entry belongs to.
             * Links to users/{businessId}/upcs/{upcId}.
             * QUERY: HIGH — primary filter when tracing the full history of a specific unit.
             */
            upcId: string;

            /**
             * SKU of the product this UPC belongs to.
             * Links to users/{businessId}/products/{sku}.
             * QUERY: HIGH — filter by productId + timestamp range for product movement audit.
             */
            productId: string;

            /**
             * GRN document ID if this UPC was received via GRN. Null otherwise.
             * Links to users/{businessId}/grns/{grnId}.
             * QUERY: MEDIUM — filter grnRef to trace all movements of units from a GRN.
             */
            grnRef: string | null;

            // -- CORE DATA ----------------------------------------------------

            /**
             * When this log entry was written. Firestore Timestamp.
             * QUERY: HIGH — sort descending for most-recent-first; filter by range for period audits.
             */
            timestamp: Timestamp;

            /**
             * Snapshot of the UPC's key fields at the moment of this state change.
             * Captures the state AFTER the triggering change.
             * QUERY: MEDIUM — read snapshot.putAway to understand the transition recorded here.
             */
            snapshot: {
                /**
                 * putAway value after this state change. The transition that triggered the log.
                 * QUERY: MEDIUM — filter snapshot.putAway to find log entries for a specific state.
                 */
                putAway: "inbound" | "none" | "outbound" | null;

                /**
                 * Shopify store domain at log time. Null if not order-linked.
                 * QUERY: LOW
                 */
                storeId: string | null;

                /**
                 * Order ID at log time. Null if not order-linked.
                 * QUERY: LOW
                 */
                orderId: string | null;

                /**
                 * Warehouse ID at log time. Null if UPC was inbound or dispatched.
                 * QUERY: NEVER
                 */
                warehouseId: string | null;

                /**
                 * Zone ID at log time. QUERY: NEVER
                 */
                zoneId: string | null;

                /**
                 * Rack ID at log time. QUERY: NEVER
                 */
                rackId: string | null;

                /**
                 * Shelf ID at log time. Null if not on a shelf. QUERY: LOW
                 */
                shelfId: string | null;

                /**
                 * Placement ID at log time. Null if UPC was inbound or dispatched.
                 * QUERY: NEVER
                 */
                placementId: string | null;
            };
        };


        // =====================================================================
        // COLLECTION: inventory_snapshots
        // Path: users/{businessId}/inventory_snapshots/{inventory_snapshot_id}
        // =====================================================================
        // Daily point-in-time snapshot of one product's stock, captured at 23:59 IST
        // by the dailyInventorySnapshot scheduled function.
        // One document per product per date. Document ID: "{productId}_{YYYY-MM-DD}".
        // Idempotent — safe to re-run for the same date.
        //
        // PRIMARY USE CASE: Gross Profit Report
        //   Opening Stock value = snapshot for (reportStartDate − 1 day) × product.price
        //   Closing Stock value = snapshot for reportEndDate × product.price
        //   Net available at that date = stockLevel − exactDocState.inventory.blockedStock
        //
        // TYPICAL QUERIES:
        //   - Filter productId + date == "YYYY-MM-DD" to get stock on a specific date
        //   - Filter isStockout == true to find stockout events in a range
        //   - Filter date range + productId for stock trend over time
        // =====================================================================
        inventory_snapshots: {

            // -- IDENTITY / RELATIONSHIPS -------------------------------------

            /**
             * SKU of the product this snapshot belongs to.
             * Links to users/{businessId}/products/{sku}.
             * QUERY: HIGH — always include when filtering snapshots by product.
             */
            productId: string;

            /**
             * Date of this snapshot in YYYY-MM-DD format (IST).
             * Use this field for date-based filtering — NOT the timestamp field.
             * To find opening stock for a report: filter date == startDate − 1 day.
             * QUERY: HIGH — primary date filter for all snapshot queries.
             */
            date: string;

            // -- CORE DATA ----------------------------------------------------

            /**
             * Physical stock level at end of day (23:59 IST).
             * Formula: openingStock + inwardAddition + autoAddition − deduction − autoDeduction.
             * Raw physical count — NOT adjusted for blockedStock.
             * For net available stock: stockLevel − exactDocState.inventory.blockedStock.
             * QUERY: MEDIUM — read to get historical stock level on a date.
             */
            stockLevel: number;

            /**
             * True if stockLevel was 0 at snapshot time (product was out of stock that day).
             * QUERY: MEDIUM — filter isStockout == true to count stockout days for a product.
             */
            isStockout: boolean;

            /**
             * Units sold on this date across all linked stores.
             * Derived from order line items with createdAt matching this date.
             * QUERY: MEDIUM — sum across a date range for total units sold per product.
             */
            dailySales: number;

            /**
             * Full copy of the product's inventory sub-document at snapshot time.
             * Used by the gross profit report to extract blockedStock at a point in time.
             * Net available = stockLevel − exactDocState.inventory.blockedStock.
             * QUERY: LOW — read as a block only when a full counter audit is needed.
             */
            exactDocState: {
                /**
                 * Exact state of products.inventory at snapshot time.
                 * Fields are identical to products.inventory — see that collection for field descriptions.
                 */
                inventory: {
                    openingStock: number;
                    inwardAddition: number;
                    deduction: number;
                    autoDeduction: number;
                    autoAddition: number;
                    /**
                     * Subtract from stockLevel to get net available stock at this snapshot date.
                     * QUERY: MEDIUM — used in gross profit report: net = stockLevel - blockedStock.
                     */
                    blockedStock: number;
                };
            };

            /**
             * Firestore Timestamp. When this snapshot was written by the scheduled function.
             * QUERY: NEVER — use the date (string) field for filtering, not this Timestamp.
             */
            timestamp: Timestamp;
        };


        // =====================================================================
        // COLLECTION: parties
        // Path: users/{businessId}/parties/{partyId}
        // =====================================================================
        // A party is a business contact — supplier, customer, or both.
        // Referenced by purchaseOrders.supplierPartyId and credit_notes.partyId.
        // Deactivation (isActive: false) is blocked by the API if open POs reference this party.
        //
        // TYPICAL QUERIES:
        //   - Filter type == "supplier" + isActive == true for PO/CN creation dropdowns
        //   - Equality filter on id when joining PO or CN supplier details
        // =====================================================================
        parties: {

            // -- IDENTITY -----------------------------------------------------

            /**
             * Firestore document ID.
             * QUERY: MEDIUM — equality filter when joining PO or CN supplier details.
             */
            id: string;

            /**
             * Display name (e.g. "Reliance Textiles Pvt. Ltd.").
             * Denormalized into purchaseOrders.supplierName and credit_notes.partyName.
             * QUERY: LOW — use id for filtering; name is for display only.
             */
            name: string;

            /**
             * Role in the system.
             * "supplier" — eligible for Purchase Orders and Credit Notes.
             * "customer" — reserved for future customer-side features.
             * "both"     — can act as either role.
             * Immutable after creation.
             * QUERY: HIGH — filter type == "supplier" when fetching parties for PO creation.
             */
            type: 'supplier' | 'customer' | 'both';

            /**
             * Whether this party is currently active.
             * Inactive parties do not appear in PO or CN creation dropdowns.
             * Soft-delete — the document is never removed.
             * QUERY: HIGH — always filter isActive == true when listing selectable parties.
             */
            isActive: boolean;

            // -- CONTACT DETAILS ----------------------------------------------

            /**
             * Short alphanumeric reference code (e.g. "SUP001"). Null if not set.
             * QUERY: LOW — occasionally used for search.
             */
            code: string | null;

            /**
             * Name of the primary contact person. Null if not set.
             * QUERY: NEVER
             */
            contactPerson: string | null;

            /**
             * Phone number. Null if not set.
             * QUERY: NEVER
             */
            phone: string | null;

            /**
             * Email address. Null if not set.
             * QUERY: NEVER
             */
            email: string | null;

            // -- ADDRESS (used in bill PDFs) ----------------------------------

            /**
             * Physical address. Used in GRN and Credit Note bill PDFs for the
             * "Billed By" / "Billed To" block.
             * address.state determines GST jurisdiction:
             *   state.toLowerCase() === "punjab" || "pb" → intra-state (CGST + SGST).
             *   anything else → inter-state (IGST).
             * Null if not set.
             * QUERY: NEVER — read for PDF rendering only.
             */
            address: {
                line1: string | null;
                line2: string | null;
                city: string | null;
                /** Used for intra/inter-state GST determination. */
                state: string | null;
                pincode: string | null;
                country: string;
            } | null;

            // -- FINANCIAL / TAX IDENTIFIERS ---------------------------------

            /**
             * GSTIN (15-character alphanumeric). Shown on GRN bill PDFs.
             * Validated on creation. Null if not provided.
             * QUERY: NEVER
             */
            gstin: string | null;

            /**
             * PAN (10 characters). Shown on GRN bills. Null if not provided.
             * QUERY: NEVER
             */
            pan: string | null;

            /**
             * Bank account details for payment processing.
             * GRN bills: shows this party's bank (business pays supplier here).
             * Credit note bills: shows the BUSINESS's bank instead (supplier refunds business).
             * This asymmetry is intentional — do not use party bankDetails for CN bills.
             * Null if not set.
             * QUERY: NEVER — read for PDF rendering only.
             */
            bankDetails: {
                accountName: string | null;
                accountNumber: string | null;
                ifsc: string | null;
                bankName: string | null;
            } | null;

            /**
             * Payment terms (e.g. "Net 30", "Immediate"). Informational only — not enforced.
             * QUERY: NEVER
             */
            defaultPaymentTerms: string | null;

            /**
             * Free-text notes. Null if not set.
             * QUERY: NEVER
             */
            notes: string | null;

            // -- METADATA -----------------------------------------------------

            /**
             * Firestore Timestamp. When this party was created.
             * QUERY: LOW
             */
            createdAt: Timestamp;

            /**
             * UID of the user who created this party.
             * QUERY: NEVER
             */
            createdBy: string;

            /**
             * Firestore Timestamp. When this party was last updated.
             * QUERY: NEVER
             */
            updatedAt: Timestamp;

            /**
             * UID of the user who last updated this party.
             * QUERY: NEVER
             */
            updatedBy: string;
        };


        // =====================================================================
        // WAREHOUSE HIERARCHY COLLECTIONS
        // Order: warehouses → zones → racks → shelves
        // =====================================================================
        // These collections describe the physical structure of the warehouse.
        // They are rarely queried for business analytics. Their primary uses are:
        //   - Rendering the warehouse map in the UI
        //   - Providing location labels when displaying UPC or placement data
        //   - Reading stats.* for high-level capacity overviews
        // For stock analytics, always prefer placements and upcs.
        // =====================================================================

        // =====================================================================
        // COLLECTION: warehouses
        // Path: users/{businessId}/warehouses/{warehouseId}
        // =====================================================================
        warehouses: {
            /** Document ID = code (uppercase). Immutable. QUERY: MEDIUM */
            id: string;
            /** Display name (e.g. "Main Warehouse Ludhiana"). QUERY: LOW */
            name: string;
            /** Uppercase code. Same as id. QUERY: NEVER */
            code: string;
            /**
             * True if soft-deleted. Always filter isDeleted == false for active warehouses.
             * QUERY: HIGH
             */
            isDeleted: boolean;
            /**
             * Default GST state (e.g. "Punjab").
             * Determines intra/inter-state for GRN bill tax calculation.
             * QUERY: NEVER — read for PDF rendering only.
             */
            defaultGSTstate: string;
            /**
             * Pre-aggregated hierarchy counts. Use for capacity overviews —
             * do not query child collections to compute these.
             * QUERY: LOW — read for dashboard-style overview queries.
             */
            stats: {
                totalZones: number;
                totalRacks: number;
                totalShelves: number;
                totalProducts: number;
            };
            address: string;           // Physical address string. QUERY: NEVER
            storageCapacity: number;   // Informational capacity. QUERY: NEVER
            operationalHours: number;  // Hours per day. QUERY: NEVER
            deletedAt: Timestamp | null;
            createdAt: Timestamp;
            createdBy: string;
            updatedAt: Timestamp;
            updatedBy: string;
            /** Incremented on name change; used to detect stale denormalized names. QUERY: NEVER */
            nameVersion: number;
        };

        // =====================================================================
        // COLLECTION: zones
        // Path: users/{businessId}/zones/{zoneId}
        // HIERARCHY: Warehouse → Zone → Rack → Shelf → Placements → UPCs
        // =====================================================================
        zones: {
            /** Document ID = zone code (uppercase). Immutable. QUERY: MEDIUM */
            id: string;
            /** Display name (e.g. "Zone A – Inbound"). QUERY: LOW */
            name: string;
            code: string;             // QUERY: NEVER
            description: string | null; // QUERY: NEVER
            /** QUERY: HIGH — always filter isDeleted == false. */
            isDeleted: boolean;
            /** Parent warehouse. QUERY: HIGH — list all zones in a warehouse. */
            warehouseId: string;
            /** Pre-aggregated counts. QUERY: LOW */
            stats: { totalRacks: number; totalShelves: number; totalProducts: number; };
            deletedAt: Timestamp | null;
            createdAt: Timestamp;
            createdBy: string;
            updatedAt: Timestamp;
            updatedBy: string;
            locationVersion: number; // QUERY: NEVER
            nameVersion: number;     // QUERY: NEVER
        };

        // =====================================================================
        // COLLECTION: racks
        // Path: users/{businessId}/racks/{rackId}
        // HIERARCHY: Warehouse → Zone → Rack → Shelf → Placements → UPCs
        // =====================================================================
        racks: {
            /** Document ID = rack code (uppercase). Immutable. QUERY: MEDIUM */
            id: string;
            /** Display name (e.g. "Rack B"). QUERY: LOW */
            name: string;
            code: string;  // QUERY: NEVER
            /** QUERY: HIGH — always filter isDeleted == false. */
            isDeleted: boolean;
            /** Parent warehouse. QUERY: MEDIUM */
            warehouseId: string;
            /** Parent zone. QUERY: HIGH — list all racks in a zone. */
            zoneId: string;
            position: number; // Sort order within zone. QUERY: LOW
            /** Pre-aggregated counts. QUERY: LOW */
            stats: { totalShelves: number; totalProducts: number; };
            deletedAt: Timestamp | null;
            createdAt: Timestamp;
            createdBy: string;
            updatedAt: Timestamp;
            updatedBy: string;
            locationVersion: number; // QUERY: NEVER
            nameVersion: number;     // QUERY: NEVER
        };

        // =====================================================================
        // COLLECTION: shelves
        // Path: users/{businessId}/shelves/{shelfId}
        // HIERARCHY: Warehouse → Zone → Rack → Shelf → Placements → UPCs
        // The lowest level of the hierarchy. UPCs are placed directly onto shelves.
        // Referenced by placements.shelfId and upcs.shelfId.
        // =====================================================================
        shelves: {
            /** Document ID = shelf code (uppercase). Immutable. QUERY: MEDIUM */
            id: string;
            /** Display name (e.g. "Shelf A1"). QUERY: LOW */
            name: string;
            code: string;          // QUERY: NEVER
            capacity: number | null; // Max units. Informational. QUERY: NEVER
            /** QUERY: HIGH — always filter isDeleted == false. */
            isDeleted: boolean;
            /** Parent warehouse. Updated automatically on move. QUERY: MEDIUM */
            warehouseId: string;
            /** Parent zone. QUERY: MEDIUM */
            zoneId: string;
            /** Parent rack. QUERY: HIGH — list all shelves in a rack. */
            rackId: string;
            position: number; // Sort order within rack. QUERY: LOW
            /** Distinct products currently placed on this shelf. QUERY: LOW */
            stats: { totalProducts: number; };
            deletedAt: Timestamp | null;
            createdAt: Timestamp;
            createdBy: string;
            updatedAt: Timestamp;
            updatedBy: string;
            locationVersion: number; // QUERY: NEVER
            nameVersion: number;     // QUERY: NEVER
        };
    };
}

// =============================================================================
// STORE MODULE — database-desc.ts
// =============================================================================
// This module describes Firestore collections under the accounts/{storeId} path.
// These are Shopify-mirrored collections — documents here are created and updated
// by Shopify webhooks, with the app's own operational fields layered on top.
//
// storeId = Shopify store domain (e.g. "my-store.myshopify.com")
//
// COLLECTIONS IN THIS MODULE:
//   orders   — accounts/{storeId}/orders/{orderId}
//   products — accounts/{storeId}/products/{productId}
//
// QUERY INTENSITY TAGS:
//   QUERY: HIGH   — frequently filtered, grouped, or sorted on
//   QUERY: MEDIUM — occasionally filtered or used in joins
//   QUERY: LOW    — display / informational only; avoid in queries
//   QUERY: NEVER  — dead field, legacy, or internal; not useful analytically
// =============================================================================

// =============================================================================
// STORE MODULE — COLLECTIONS
// =============================================================================

interface Store {

    // =========================================================================
    // COLLECTION: orders
    // Path: accounts/{storeId}/orders/{orderId}
    // =========================================================================
    // One document per Shopify order. Document ID = Shopify's numeric order ID
    // stored as a string.
    //
    // DOCUMENT ANATOMY — two distinct layers:
    //   1. App operational layer (fields outside `raw`) — owned and written by
    //      Majime. These are the fields used for all queries, status management,
    //      warehouse linking, courier tracking, and reporting.
    //   2. Raw Shopify payload (`raw`) — verbatim mirror of the Shopify order
    //      object, updated on every orders/updated webhook. The app does not
    //      own this structure; it reflects whatever Shopify sends.
    //      EXCEPTION: two fields are app-injected into raw.line_items[] items:
    //        raw.line_items[].qc_status      — written by the QC flow
    //        raw.line_items[].refundedAmount — written by the refund flow
    //
    // SHARED STORE FILTERING:
    //   When a Shopify store is shared by multiple businesses (multi-vendor),
    //   each order's line items carry a `vendor` field from Shopify. The app
    //   extracts unique vendor names into the top-level `vendors: string[]` field.
    //   To scope queries to a specific business on a shared store, ALWAYS filter:
    //     vendors array-contains {business.vendorName}
    //   Without this, you get all businesses' orders on the store.
    //
    // STATUS TIMESTAMP PATTERN:
    //   Every customStatus transition writes a dedicated timestamp field following
    //   the rule: {toCamelCase(customStatus)}At (e.g. "Ready To Dispatch" → readyToDispatchAt).
    //   For date-range queries scoped to a status, always filter the corresponding
    //   *At field — NOT createdAt. createdAt is Shopify's order creation time and
    //   has nothing to do with when the order entered a given warehouse stage.
    //   lastStatusUpdate is the single field that tracks when the status last changed,
    //   regardless of which status it transitioned to.
    //
    // CONNECTION TO WAREHOUSE MODULE:
    //   Order arrives (New)
    //     → raw.line_items[].variant_id
    //     → accounts/{storeId}/products/{productId}.variantMappingDetails[variantId]
    //     → business SKU → users/{businessId}/products/{sku}
    //     → inventory.blockedStock++
    //   Order picked up (Confirmed → outbound)
    //     → UPCs get storeId + orderId set, putAway transitions to "outbound"
    //   Order dispatched
    //     → UPCs putAway → null, autoDeduction++, blockedStock--
    //
    // RELATIONSHIPS:
    //   storeId (path)              → accounts/{storeId}
    //   raw.line_items[].variant_id → accounts/{storeId}/products/{productId}
    //                                 .variantMappingDetails[variantId].businessProductSku
    //                               → users/{businessId}/products/{sku}
    //   Referenced by → users/{businessId}/upcs/{upcId}.orderId + .storeId
    //
    // TYPICAL QUERIES:
    //   - Filter customStatus for order pipeline views
    //   - Filter vendors array-contains for shared store scoping
    //   - Filter {statusAt} range for date-scoped reporting (e.g. deliveredAt, createdAt)
    //   - Filter awb / awb_reverse for courier lookup
    //   - Filter courierProvider for courier-level analytics
    //   - Flatten raw.line_items[] and groupBy variant_id/sku for sales analytics
    // =========================================================================
    orders: {

        // -- IDENTITY ---------------------------------------------------------

        /**
         * Firestore document ID. Shopify's numeric order ID stored as a string.
         * Same value as raw.id and orderId.
         * QUERY: MEDIUM — equality filter when looking up a specific order by ID.
         */
        id: string;

        /**
         * Shopify store domain. Always matches the path segment.
         * QUERY: NEVER — implicit in the collection path.
         */
        storeId: string;

        /**
         * Shopify's numeric order ID. Same value as the document ID stored as a number.
         * QUERY: MEDIUM — equality filter when matching against Shopify webhook payloads.
         */
        orderId: number;

        /**
         * Human-readable Shopify order number (e.g. "#1042").
         * Derived from raw.name at order creation. Display only.
         * QUERY: MEDIUM — equality filter when a user searches by order number.
         */
        name: string;

        /**
         * Customer email. Derived from raw.email at order creation.
         * QUERY: MEDIUM — equality filter for customer-level order lookup.
         */
        email: string;

        // -- PRIMARY DATE FIELD ----------------------------------------------

        /**
         * When Shopify created this order. ISO date string (e.g. "2024-01-15T14:30:00+05:30").
         * Derived from raw.created_at at order creation. Static — never changes.
         * The only date field in this document that is an ISO string rather than a Firestore Timestamp.
         * QUERY: HIGH — primary date filter for order volume by creation date.
         *               Filter range for "orders received this month" style queries.
         *               NOTE: For status-specific date queries, use the corresponding *At field instead.
         */
        createdAt: ISODateString;

        // -- STATUS -----------------------------------------------------------

        /**
         * The app's internal order lifecycle status. The primary operational field —
         * everything about where an order stands in the warehouse/courier pipeline
         * is determined by this value.
         *
         * FULL STATUS LIFECYCLE:
         *   New                  — order just received from Shopify; blockedStock incremented
         *   Confirmed            — ops team confirmed; eligible for pickup if pickupReady == true
         *   Ready To Dispatch    — items picked, packed, AWB assigned
         *   Dispatched           — handed to courier
         *   In Transit           — courier in transit to customer
         *   Out For Delivery     — courier out for last-mile delivery
         *   Delivered            — successfully delivered. Terminal for forward journey.
         *   RTO In Transit       — courier returning the undelivered order to warehouse
         *   RTO Delivered        — returned order physically back at warehouse
         *   RTO Closed           — RTO processed and closed. Terminal.
         *   DTO Requested        — customer initiated a return request
         *   DTO Booked           — reverse pickup booked with courier
         *   DTO In Transit       — return in transit back to warehouse
         *   DTO Delivered        — return physically arrived at warehouse
         *   Pending Refunds      — returned items passed QC; awaiting refund processing
         *   DTO Refunded         — refund issued to customer. Terminal.
         *   Cancellation Requested — customer requested cancellation before dispatch
         *   Cancelled            — order cancelled. Terminal.
         *   Lost                 — order lost in transit. Terminal.
         *   Closed               — generic terminal state (used for some RTO scenarios)
         *
         * ACTIVE STATUSES (contribute to blockedStock on mapped products):
         *   New, Confirmed, Ready To Dispatch
         *
         * QUERY: HIGH — most important filter field across the entire orders collection.
         *               Use for pipeline views, counting orders by stage, and all
         *               status-scoped analytics.
         *               e.g. customStatus == "Confirmed" to find pickup-eligible orders.
         *               e.g. customStatus in ["Delivered", "Closed"] for completed orders.
         */
        customStatus:
        | "New"
        | "Confirmed"
        | "Ready To Dispatch"
        | "Dispatched"
        | "In Transit"
        | "Out For Delivery"
        | "Delivered"
        | "RTO In Transit"
        | "RTO Delivered"
        | "DTO Requested"
        | "DTO Booked"
        | "DTO In Transit"
        | "DTO Delivered"
        | "Pending Refunds"
        | "DTO Refunded"
        | "Closed"
        | "RTO Closed"
        | "Lost"
        | "Cancellation Requested"
        | "Cancelled";

        /**
         * Firestore Timestamp. When customStatus last changed, regardless of which status.
         * Overwritten on every status transition.
         * QUERY: HIGH — sort descending for "recently updated" order lists;
         *               filter range for "orders updated today" queries.
         */
        lastStatusUpdate: Timestamp;

        /**
         * Full audit trail of every status change this order has gone through.
         * Type: CustomStatusesLog[] — see CustomStatusesLog interface above.
         * Each entry: { status: string, createdAt: Timestamp, remarks: string }.
         * Appended on every transition alongside the status-specific *At timestamp field.
         * QUERY: NEVER — embedded array of objects; not a Firestore filter target.
         *                Read when displaying an order's complete lifecycle timeline.
         */
        customStatusesLogs: {
            status: string; // the customStatus value that was set
            createdAt: Timestamp; // when the transition occurred
            remarks: string; // optional note added by the ops user at transition time
        }[];

        // -- SHARED STORE VENDOR FILTER ---------------------------------------

        /**
         * Unique vendor names extracted from raw.line_items[].vendor at order creation.
         * The essential filter for shared-store multi-vendor setups.
         * On a store shared by multiple businesses, each order belongs to one or more
         * vendors — each vendor corresponds to one business's products.
         * ALWAYS filter vendors array-contains {vendorName} when querying a shared
         * store's orders for a specific business. Without this you get all vendors' orders.
         * QUERY: HIGH — mandatory filter for shared store scoping.
         *               Also useful for vendor-level order analytics on any store.
         */
        vendors: string[];

        // -- FINANCIAL SUMMARY ------------------------------------------------

        /**
         * Total order value in INR parsed to a number from raw.total_price (which is a string).
         * Includes tax and shipping. Derived from raw at order creation.
         * QUERY: MEDIUM — sum for total revenue; filter range for order value segmentation.
         */
        totalPrice: number;

        /**
         * Always "INR". Derived from raw.currency at creation.
         * QUERY: NEVER
         */
        currency: Currency;

        /**
         * Shopify's payment status. Derived from raw.financial_status. Updated by webhook.
         * "paid" | "partially_paid" | "pending" | "refunded" | "voided"
         * QUERY: MEDIUM — filter financialStatus == "paid" for confirmed-revenue queries.
         */
        financialStatus: FinancialStatus;

        /**
         * Shopify's fulfillment status. Derived from raw.fulfillment_status. Updated by webhook.
         * "fulfilled" | "unfulfilled" | "restocked"
         * Much coarser than customStatus — rarely useful for operational queries.
         * QUERY: LOW — prefer customStatus for all operational filtering.
         */
        fulfillmentStatus: FulfillmentStatusEnum;

        // -- REFUND FIELDS ---------------------------------------------------

        /**
         * Total amount refunded to the customer, in INR.
         * Written by the app's refund flow. The authoritative refund figure —
         * takes precedence over any total derived from raw.refunds[].
         * The orders/updated webhook is explicitly prevented from overwriting this field.
         * Only present on orders where a refund has been processed.
         * QUERY: MEDIUM — sum for total refunds issued in a period;
         *                 filter refundedAmount > 0 to find orders with any refund.
         */
        refundedAmount?: number;

        /**
         * How the refund was issued.
         * "manual"       — bank transfer or cash, handled outside the system.
         * "store_credit" — Shopify store credit issued via GraphQL API.
         * QUERY: MEDIUM — group by refundMethod for refund method breakdown reports.
         */
        refundMethod?: "manual" | "store_credit";

        // -- COURIER / DISPATCH FIELDS ----------------------------------------

        /**
         * Courier assigned for the forward (outbound) shipment.
         * Values: "Blue Dart" | "Delhivery" | "Shiprocket" | "Xpressbees" | "DTDC"
         * Canonical forward courier field — always use this, not the legacy `courier`.
         * QUERY: HIGH — filter/group by courierProvider for courier-level analytics
         *               and for scoping courier status update jobs.
         */
        courierProvider?: Courier;

        /**
         * Air Waybill number for the forward shipment.
         * Assigned during the AWB generation step (Ready To Dispatch flow).
         * Used as the tracking ID when polling courier APIs for status updates.
         * QUERY: HIGH — equality filter for courier tracking lookup;
         *               used by courier status update Cloud Tasks to match orders.
         */
        awb?: string;

        /**
         * Courier assigned for the reverse (return) shipment.
         * Set when a DTO reverse pickup is booked (DTO Booked status).
         * Canonical reverse courier field — always use this, not the legacy `courier_reverse`.
         * QUERY: MEDIUM — filter by courierReverseProvider for reverse logistics analytics.
         */
        courierReverseProvider?: Courier;

        /**
         * Air Waybill number for the reverse/return shipment.
         * Assigned when a DTO reverse pickup is booked.
         * Used to poll courier APIs for return shipment status.
         * QUERY: MEDIUM — equality filter for reverse shipment tracking lookup.
         */
        awb_reverse?: string;

        /**
         * Shipping mode for the forward shipment.
         * "Express" | "Surface"
         * QUERY: LOW — filter for mode-level analytics if needed.
         */
        shippingMode?: "Express" | "Surface";

        // -- BLUE DART SPECIFIC FIELDS ----------------------------------------

        /**
         * Blue Dart cluster code for routing. Set during Blue Dart AWB assignment.
         * Required by Blue Dart's API for shipment booking. Null if not applicable.
         * QUERY: NEVER — courier-API internal routing field.
         */
        bdClusterCode?: string | null;

        /**
         * Blue Dart destination location name. Used in Blue Dart API calls.
         * QUERY: NEVER
         */
        bdDestinationLocation?: string;

        /**
         * Blue Dart destination area name. Used in Blue Dart API calls.
         * QUERY: NEVER
         */
        bdDestinationArea?: string;

        // -- PICKUP / PACKING FIELDS ------------------------------------------

        /**
         * True when this Confirmed order has been verified to have sufficient
         * physical units on shelves (inShelfQuantity check passed for all line items).
         * Gates the pickup flow — only pickupReady == true orders can proceed to pickup.
         * QUERY: HIGH — filter pickupReady == true AND customStatus == "Confirmed"
         *               to find orders eligible for physical pickup right now.
         */
        pickupReady?: boolean;

        /**
         * When pickupReady was set to true.
         * QUERY: LOW
         */
        pickupReadyAt?: Timestamp;

        /**
         * Timestamp of the most recent packing session for this order.
         * QUERY: LOW — can sort to find most recently packed orders.
         */
        lastPackedAt?: Timestamp;

        /**
         * Array of packing video records.
         * Type: PackingVidURL[] — see PackingVidURL interface above.
         * Each entry: { packingVidUrl: Firebase Storage URL, packedAt: Timestamp }.
         * Multiple entries if the order was repacked (each session appended).
         * QUERY: NEVER — read when displaying packing evidence for a specific order.
         */
        packingVidUrls?: {
            packingVidUrl: string; // Firebase Storage URL of the recorded video
            packedAt: Timestamp; // when the packing session occurred
        }[];

        // -- RETURN / DTO FIELDS ----------------------------------------------

        /**
         * When the customer submitted their return request on the public return page.
         * QUERY: MEDIUM — filter range for return request volume by date.
         */
        return_request_date?: Timestamp;

        /**
         * Shopify variant IDs of the items the customer selected to return.
         * Populated when the customer submits the return form and selects line items.
         * Each value links back to raw.line_items[].variant_id.
         * QUERY: MEDIUM — array-contains filter to find orders returning a specific variant.
         */
        returnItemsVariantIds?: number[];

        /**
         * Return reason entered by the customer on the return booking form.
         * QUERY: LOW — group by for return reason breakdown analytics.
         */
        booked_return_reason?: string;

        /**
         * Firebase Storage URLs of images uploaded by the customer on the return page.
         * Visual evidence of the product's condition before return pickup.
         * QUERY: NEVER — read for display only.
         */
        booked_return_images?: string[];

        /**
         * Firebase Storage path of the unboxing/QC video recorded at the warehouse
         * when a returned order physically arrives and is inspected.
         * QUERY: NEVER — read for display only.
         */
        unboxing_video_path?: string;

        // -- RTO FIELDS -------------------------------------------------------

        /**
         * Tags applied during RTO In Transit tracking, reflecting the courier's
         * last delivery attempt outcome.
         * Type: TagsRtoInTransit[] — values: "Re-attempt" | "Refused"
         * "Re-attempt" — courier will try delivery again.
         * "Refused"    — customer refused to accept the package.
         * QUERY: LOW — filter for RTO attempt analysis.
         */
        tags_rtoInTransit?: ("Re-attempt" | "Refused")[];

        /**
         * Blue Dart's own courier-reported delivery timestamp.
         * Distinct from deliveredAt which is set by the app's status update flow.
         * QUERY: NEVER — reference only; always use deliveredAt for analytics.
         */
        bluedartdeliveredtime?: Timestamp;

        // -- WhatsApp ---------------------------------------------------------

        /**
         * Array of WhatsApp Cloud API message IDs sent for this order.
         * Appended whenever a WhatsApp notification is dispatched.
         * QUERY: NEVER — audit trail only.
         */
        whatsapp_messages: string[];

        // -- STATUS-SPECIFIC TIMESTAMPS (pattern: {toCamelCase(customStatus)}At) ---
        // Each field is written exactly once when the order first enters that status.
        // For date-range queries, always filter the relevant *At field — not createdAt.
        // -----------------------------------------------------------------------

        /** When status became "New". Written at order creation. QUERY: MEDIUM */
        newAt: Timestamp;
        /** When status became "Confirmed". QUERY: MEDIUM */
        confirmedAt?: Timestamp;
        /** When status became "Ready To Dispatch". QUERY: MEDIUM */
        readyToDispatchAt?: Timestamp;
        /** When status became "Dispatched". QUERY: MEDIUM — filter for dispatch volume by date. */
        dispatchedAt?: Timestamp;
        /** When status became "In Transit". QUERY: LOW */
        inTransitAt?: Timestamp;
        /** When status became "Out For Delivery". QUERY: LOW */
        outForDeliveryAt?: Timestamp;
        /**
         * When status became "Delivered".
         * QUERY: HIGH — primary date field for delivery-based revenue and success rate reporting.
         *               e.g. filter deliveredAt range for "delivered orders this month".
         */
        deliveredAt?: Timestamp;
        /** When status became "Cancellation Requested". QUERY: LOW */
        cancellationRequestedAt?: Timestamp;
        /** When status became "Cancelled". QUERY: MEDIUM — filter for cancellation rate analysis. */
        cancelledAt?: Timestamp;
        /** When status became "Lost". QUERY: LOW */
        lostAt?: Timestamp;
        /** When status became "Closed". QUERY: LOW */
        closedAt?: Timestamp;
        /** When status became "DTO Requested". QUERY: LOW */
        dtoRequestedAt?: Timestamp;
        /** When status became "DTO Booked". QUERY: LOW */
        dtoBookedAt?: Timestamp;
        /** When status became "DTO In Transit". QUERY: LOW */
        dtoInTransitAt?: Timestamp;
        /** When status became "DTO Delivered". QUERY: LOW */
        dtoDeliveredAt?: Timestamp;
        /** When status became "Pending Refunds". QUERY: MEDIUM */
        pendingRefundsAt?: Timestamp;
        /** When status became "DTO Refunded". QUERY: MEDIUM — filter for refund completion analysis. */
        dtoRefundedAt?: Timestamp;
        /** When status became "RTO In Transit". QUERY: LOW */
        rtoInTransitAt?: Timestamp;
        /** When status became "RTO Delivered". QUERY: LOW */
        rtoDeliveredAt?: Timestamp;
        /** When status became "RTO Closed". QUERY: MEDIUM — filter for RTO volume analysis. */
        rtoClosedAt?: Timestamp;

        // -- DEAD FIELDS (never use) -----------------------------------------

        /**
         * @deprecated Superseded by courierProvider. Do not use.
         * QUERY: NEVER
         */
        courier?: Courier;

        /**
         * @deprecated Superseded by courierReverseProvider. Do not use.
         * QUERY: NEVER
         */
        courier_reverse?: Courier;

        /**
         * @deprecated Dead field. Never populated meaningfully.
         * QUERY: NEVER
         */
        lastUpdatedAt?: Timestamp;

        /**
         * @deprecated Dead field. Never used in queries or logic.
         * QUERY: NEVER
         */
        updatedAt: Timestamp;

        /**
         * @deprecated Dead field. Never used in queries or logic.
         * QUERY: NEVER
         */
        receivedAt: Timestamp;

        // -- RAW SHOPIFY PAYLOAD ----------------------------------------------

        /**
         * Verbatim Shopify order object. Updated on every orders/updated webhook.
         * The app does not own this structure — it mirrors whatever Shopify sends.
         *
         * EXCEPTION: Two fields are app-injected into each raw.line_items[] item:
         *   raw.line_items[].qc_status      — written by the QC flow after a return arrives
         *   raw.line_items[].refundedAmount — written by the refund flow per line item
         *
         * DO NOT filter Firestore queries on raw.* fields — Shopify's snake_case fields
         * are not indexed. Use app-level fields outside raw for all filtering.
         * Read raw.* only when you need detailed Shopify data for display or computation.
         */
        raw: {

            // -- CORE IDENTIFIERS ---------------------------------------------

            /**
             * Shopify's numeric order ID. Same as top-level orderId and document ID.
             * QUERY: NEVER — use top-level orderId.
             */
            id: number;

            /**
             * Human-readable order number e.g. "#1042". Same as top-level name.
             * QUERY: NEVER — use top-level name.
             */
            name: string;

            /**
             * Shopify admin GraphQL API ID (e.g. "gid://shopify/Order/123456").
             * Required when making Shopify GraphQL API calls (e.g. issuing store credit,
             * editing orders, creating fulfillments).
             * QUERY: NEVER — read only when constructing GraphQL requests.
             */
            admin_graphql_api_id: string;

            // -- FINANCIAL FIELDS ---------------------------------------------

            /**
             * Total order value as a STRING (e.g. "1299.00"). Includes tax and shipping.
             * The top-level totalPrice field is this value parsed to a number.
             * QUERY: NEVER — use top-level totalPrice.
             */
            total_price: string;

            /**
             * Current order total after any post-creation edits or refunds. String.
             * May differ from total_price if partial refunds have been applied.
             * QUERY: NEVER
             */
            current_total_price: string;

            /**
             * Total discounts applied to this order. String.
             * QUERY: NEVER
             */
            total_discounts: string;

            /**
             * Total tax amount for this order. String.
             * QUERY: NEVER — read for tax display; use tax_lines for breakdown.
             */
            total_tax: string;

            /**
             * Order subtotal before tax and shipping. String.
             * QUERY: NEVER
             */
            subtotal_price: string;

            /**
             * Outstanding unpaid amount. "0.00" for fully paid orders. String.
             * QUERY: NEVER
             */
            total_outstanding: string;

            /**
             * Shopify payment status. Same as top-level financialStatus.
             * QUERY: NEVER — use top-level financialStatus.
             */
            financial_status: FinancialStatus;

            /**
             * Shopify fulfillment status. Same as top-level fulfillmentStatus.
             * QUERY: NEVER — use top-level fulfillmentStatus.
             */
            fulfillment_status: FulfillmentStatusEnum | null;

            // -- LINE ITEMS ---------------------------------------------------

            /**
             * The most analytically important array in the entire document.
             * Each entry represents one ordered product variant.
             * Type: LineItem[] — see LineItem interface above for full field documentation.
             *
             * MOST IMPORTANT FIELDS:
             *   variant_id      — PRIMARY JOIN KEY to business product mapping system
             *   product_id      — Shopify product ID
             *   quantity        — ordered quantity
             *   price           — unit price (string, not number)
             *   sku             — Shopify variant SKU
             *   vendor          — source of top-level order.vendors[]
             *   tax_lines[]     — per-item CGST/SGST/IGST breakdown
             *   qc_status       — app-injected: QC result for returns
             *   refundedAmount  — app-injected: per-item refunded amount
             *
             * JOIN PATH (variant_id → business product):
             *   raw.line_items[].variant_id
             *   → accounts/{storeId}/products/{productId}.variantMappingDetails[variant_id]
             *   → .businessProductSku
             *   → users/{businessId}/products/{sku}
             *
             * FLATTEN PATTERN FOR ANALYTICS:
             *   flattenArrayField("raw.line_items") → groupBy("sku" or "variant_id")
             *   → sumGrouped("quantity") for sales by product.
             */
            line_items: LineItem[];

            // -- CUSTOMER & ADDRESSES -----------------------------------------

            /**
             * Customer who placed this order.
             * Type: Customer — see Customer interface above.
             * KEY FIELDS: id, email, phone (for WhatsApp), first_name, last_name,
             *             default_address.
             * QUERY: NEVER — read for display and comms targeting.
             */
            customer: {
                id: number;
                email: string | null;
                phone: string | null;
                first_name: string;
                last_name: string | null;
                state: string; // Shopify account state, NOT geographic state
                currency: Currency;
                verified_email: boolean;
                note: string | null;
                tax_exempt: boolean;
                tax_exemptions: any[];
                multipass_identifier: null;
                admin_graphql_api_id: string;
                default_address: Address;
                created_at: ISODateString;
                updated_at: ISODateString;
            };

            /**
             * Delivery address for this order.
             * Type: Address — see Address interface above.
             * KEY FIELDS: first_name, last_name, address1, address2, city, province
             *             (state — used for GST jurisdiction), zip, phone.
             * Used for courier label generation and Blue Dart routing fields.
             * QUERY: NEVER — read for courier dispatch and display.
             */
            shipping_address: Address;

            /**
             * Billing address for this order.
             * Type: Address — see Address interface above.
             * QUERY: NEVER — read for invoicing display.
             */
            billing_address: Address;

            // -- REFUNDS ------------------------------------------------------

            /**
             * Shopify's own refund records for this order.
             * Type: Refund[] — see Refund, RefundLineItem, Transaction, OrderAdjustment
             *                  interfaces above.
             * IMPORTANT: Do NOT derive refund totals from this array.
             * The app's top-level refundedAmount is the authoritative figure.
             * Read this array only for Shopify-side refund details or transaction IDs.
             * QUERY: NEVER
             */
            refunds: {
                id: number;
                admin_graphql_api_id: string;
                order_id: number;
                note: string | null;
                restock: boolean;
                user_id: number;
                refund_line_items: {
                    id: number;
                    line_item_id: number; // references raw.line_items[].id
                    line_item: LineItem; // embedded copy of the line item at refund time
                    quantity: number; // units refunded
                    restock_type: string; // "return" | "cancel" | "no_restock"
                    location_id: number | null;
                    subtotal: number;
                    total_tax: number;
                    subtotal_set: MoneySet;
                    total_tax_set: MoneySet;
                }[];

                /**
                 * A payment transaction associated with a refund.
                 * Represents actual money movement (e.g. refund credited back to customer).
                 *
                 * KEY FIELDS:
                 *   id      — Shopify transaction ID.
                 *   amount  — transaction amount as a string.
                 *   kind    — "refund" | "capture" | "sale" | "void" | "authorization".
                 *   status  — "success" | "pending" | "failure" | "error".
                 *   gateway — payment gateway used (e.g. "razorpay", "gift_card").
                 * QUERY: NEVER
                 */
                transactions: {
                    id: number;
                    admin_graphql_api_id: string;
                    order_id: number;
                    parent_id: number | null;
                    amount: string;
                    kind: string;
                    status: string;
                    gateway: string;
                    currency: Currency;
                    authorization: string | null;
                    payment_id: string;
                    source_name: string;
                    test: boolean;
                    user_id: number;
                    device_id: null;
                    location_id: null;
                    error_code: null;
                    message: string;
                    receipt: object;
                    created_at: ISODateString;
                    processed_at: ISODateString;
                }[];

                /**
                 * An order-level adjustment applied as part of a refund.
                 * Used when the refund includes a shipping fee refund or similar
                 * adjustment not tied to a specific line item.
                 *
                 * KEY FIELDS:
                 *   kind   — "refund_discrepancy" | "shipping_refund" etc.
                 *   amount — adjustment amount as a string.
                 *   reason — reason string for the adjustment.
                 * QUERY: NEVER
                 */
                order_adjustments: {
                    id: number;
                    order_id: number;
                    refund_id: number;
                    kind: string;
                    reason: string;
                    amount: string;
                    tax_amount: string;
                    amount_set: MoneySet;
                    tax_amount_set: MoneySet;
                }[];

                duties: any[];
                total_duties_set: MoneySet;
                created_at: ISODateString;
                processed_at: ISODateString;
            }[];

            // -- FULFILLMENTS -------------------------------------------------

            /**
             * Shopify's own fulfillment records.
             * Type: Fulfillment[] — see Fulfillment interface above.
             * Contains Shopify's tracking numbers and courier info.
             * The app's awb / courierProvider fields are more reliable for operations.
             * KEY FIELD: fulfillments[].id — needed for Shopify GraphQL fulfillment mutations.
             * QUERY: NEVER — reference only; use app-level awb / courierProvider.
             */
            fulfillments: {
                id: number;
                admin_graphql_api_id: string;
                order_id: number;
                name: string;
                status: string;
                tracking_company: Courier;
                tracking_number: string;
                tracking_numbers: string[];
                tracking_url: string;
                tracking_urls: string[];
                location_id: number;
                service: string;
                shipment_status: null;
                origin_address: object;
                receipt: object;
                line_items: LineItem[];
                created_at: ISODateString;
                updated_at: ISODateString;
            }[];

            // -- DISCOUNTS ----------------------------------------------------

            /**
             * Discount codes applied at checkout (e.g. "SUMMER20").
             * Type: DiscountCode[] — see DiscountCode interface above.
             * Each entry: { code, amount, type }.
             * QUERY: NEVER — read for discount display.
             */
            discount_codes: {
                code: string;
                amount: string;
                type: string; // "percentage" | "fixed_amount" | "shipping"
            }[];

            /**
             * How each discount was applied to the order.
             * Type: DiscountApplication[] — see DiscountApplication interface above.
             * Cross-referenced by DiscountAllocation.discount_application_index on each line item.
             * QUERY: NEVER
             */
            discount_applications: {
                target_type: string; // "line_item" | "shipping_line"
                type: string; // "discount_code" | "manual" | "script"
                value: string;
                value_type: string; // "percentage" | "fixed_amount"
                allocation_method: string;
                target_selection: string;
                title?: string;
                description?: string;
                code?: string;
            }[];

            // -- TAX ----------------------------------------------------------

            /**
             * Order-level tax breakdown.
             * Type: TaxLine[] — see TaxLine interface above.
             * Each entry: { title (CGST/SGST/IGST), rate, price }.
             * QUERY: NEVER — read for order-level tax display and reporting.
             */
            tax_lines: TaxLine[];

            /**
             * True if product prices already include tax (tax-inclusive pricing model).
             * QUERY: NEVER
             */
            taxes_included: boolean;

            // -- SHIPPING -----------------------------------------------------

            /**
             * Shipping methods applied to this order and their costs.
             * Type: ShippingLine[] — see ShippingLine interface above.
             * KEY FIELDS: title (method name), price (shipping cost as string).
             * QUERY: NEVER — read for shipping cost display.
             */
            shipping_lines: {
                id: number;
                title: string;
                code: string;
                price: string;
                discounted_price: string;
                source: string | null;
                phone: null;
                carrier_identifier: null;
                requested_fulfillment_service_id: null;
                is_removed: boolean;
                price_set: MoneySet;
                discounted_price_set: MoneySet;
                current_discounted_price_set: MoneySet;
                tax_lines: any[];
                discount_allocations: any[];
            }[];

            // -- TIMESTAMPS (SHOPIFY-SIDE) ------------------------------------

            /**
             * When Shopify created this order. ISO date string.
             * Same as top-level createdAt.
             * QUERY: NEVER — use top-level createdAt.
             */
            created_at: ISODateString;

            /**
             * When Shopify last updated this order. ISO date string.
             * Reflects Shopify's view — may not align with app-level status changes.
             * QUERY: NEVER — use top-level lastStatusUpdate for recency.
             */
            updated_at: ISODateString;

            /**
             * When the order was placed/processed by the customer. Usually same as created_at.
             * QUERY: NEVER
             */
            processed_at: ISODateString;

            /**
             * When the order was cancelled on Shopify's side. Null if not cancelled.
             * QUERY: NEVER — use app-level cancelledAt.
             */
            cancelled_at: ISODateString | null;

            // -- MISCELLANEOUS -----------------------------------------------

            /**
             * Shopify order tags as a single comma-separated string (e.g. "vip,wholesale").
             * Not a structured array — parse if tag-based logic is needed.
             * QUERY: NEVER
             */
            tags: string;

            /**
             * Customer note left at checkout. Null if none.
             * QUERY: NEVER
             */
            note: string | null;

            /**
             * Structured key-value notes from checkout (e.g. gift message fields).
             * Type: NoteAttribute[] — see NoteAttribute interface above.
             * Each entry: { name, value }.
             * QUERY: NEVER
             */
            note_attributes: {
                name: string;
                value: string;
            }[];

            /**
             * Payment gateway names used for this order (e.g. ["razorpay", "gift_card"]).
             * QUERY: NEVER
             */
            payment_gateway_names: string[];

            /**
             * Customer's browser/checkout locale (e.g. "en-IN"). Null if not set.
             * QUERY: NEVER
             */
            customer_locale: string | null;

            /**
             * Shopify order number (numeric). Different from the display name ("#1042").
             * QUERY: NEVER
             */
            number: number;
            order_number: number;

            /** Source of the order (e.g. "web", "pos"). QUERY: NEVER */
            source_name: string;

            /** Public URL for the customer to view order status on Shopify. QUERY: NEVER */
            order_status_url: string;

            /** Confirmation number shown to customer. QUERY: NEVER */
            confirmation_number: string;

            // All remaining raw.* fields are Shopify internals not used by the app.
        };
    };


    // =========================================================================
    // COLLECTION: products
    // Path: accounts/{storeId}/products/{productId}
    // =========================================================================
    // One document per Shopify product. Document ID = Shopify product ID as string.
    // Mirrors the Shopify product object, updated on products/create, products/update,
    // and products/delete webhooks.
    //
    // PRIMARY ROLE IN THE SYSTEM:
    //   variantMappingDetails is the lookup table that connects order line items
    //   to business products. It is the only way to resolve a Shopify variantId
    //   (from an order) to a Majime business product SKU.
    //
    // MAPPING ARCHITECTURE (three related fields, one purpose):
    //   variantMappingsArray  — flat number[] of all mapped variantIds.
    //                           Queryable via array-contains.
    //   variantMappings       — { [variantId]: businessProductSku }.
    //                           Lightweight SKU lookup without metadata.
    //   variantMappingDetails — { [variantId]: VariantMappingDetail }.
    //                           Full mapping with businessId, timestamp, mappedBy.
    //                           The authoritative mapping object.
    //
    // SHARED STORE NOTE:
    //   On a shared multi-vendor store, a single product doc can carry mappings
    //   for multiple businesses (each under a different variantId key in
    //   variantMappingDetails). The vendor field on the product identifies which
    //   business it primarily belongs to on Shopify.
    //
    // BIDIRECTIONALITY:
    //   Mapping is stored on BOTH sides simultaneously and removed from both atomically:
    //   Store side:     accounts/{storeId}/products/{productId}.variantMappingDetails[variantId]
    //   Warehouse side: users/{businessId}/products/{sku}.mappedVariants[]
    //
    // RELATIONSHIPS:
    //   storeId (path)                    → accounts/{storeId}
    //   variantMappingDetails[variantId]  → users/{businessId}/products/{sku}
    //   Referenced by → accounts/{storeId}/orders raw.line_items[].variant_id
    //   Referenced by → users/{businessId}/products/{sku}.mappedVariants[].variantId
    //
    // TYPICAL QUERIES:
    //   - Equality filter on id when resolving a productId to a product doc
    //   - Filter status == "active" for live product listings
    //   - Filter isDeleted == false to exclude removed products
    //   - Filter vendor for shared store vendor scoping
    //   - Filter skus array-contains for SKU-based product lookup
    //   - Filter variantMappingsArray array-contains to find which product
    //     doc owns a given variantId (used during mapping creation checks)
    // =========================================================================
    products: {

        // -- IDENTITY ---------------------------------------------------------

        /**
         * Firestore document ID. Shopify product ID stored as a string.
         * Same value as productId (numeric).
         * QUERY: MEDIUM — equality filter when resolving a productId to this doc.
         */
        id: string;

        /**
         * Shopify product ID as a number. Same as the document ID.
         * QUERY: MEDIUM — equality filter when matching from a numeric productId reference.
         */
        productId: number;

        /**
         * Shopify store domain. Always matches the path segment.
         * QUERY: NEVER — implicit in the collection path.
         */
        storeId: string;

        /**
         * Product display title (e.g. "Cotton Crew Neck T-Shirt").
         * QUERY: LOW — display only; not used for analytical filtering.
         */
        title: string;

        /**
         * Vendor/brand name as set on Shopify.
         * On shared multi-vendor stores, this identifies which business primarily
         * owns this product on Shopify. Same string that appears on order line_items[].vendor
         * and is extracted into order.vendors[].
         * QUERY: MEDIUM — filter by vendor on shared stores to scope products to one business.
         */
        vendor: string;

        // -- STATUS -----------------------------------------------------------

        /**
         * Shopify product publication status.
         * "active"   — live on the storefront; orders can be placed.
         * "draft"    — not published; not visible to customers.
         * "archived" — removed from active sales; kept for records.
         * "unlisted" — published but not visible in collections (direct URL only).
         * QUERY: HIGH — always filter status == "active" for live product queries.
         */
        status: "active" | "archived" | "draft" | "unlisted";

        /**
         * Soft delete flag. Set to true when a products/delete webhook is received.
         * The document is retained for historical mapping reference.
         * QUERY: HIGH — always filter isDeleted == false for active product queries.
         */
        isDeleted: boolean;

        // -- THE MAPPING SYSTEM -----------------------------------------------

        /**
         * Flat array of all Shopify variantIds that have been mapped to a business product.
         * One entry per mapped variant. Unmapped variants are absent from this array.
         * Exists purely for Firestore queryability — object keys (variantMappingDetails)
         * cannot be filtered on directly in Firestore.
         * QUERY: HIGH — array-contains filter to check if a variantId is already mapped
         *               anywhere, or to find which product doc owns a given variantId.
         *               e.g. variantMappingsArray array-contains 44291823
         */
        variantMappingsArray?: number[];

        /**
         * Lightweight map of variantId → businessProductSku.
         * Keyed by variantId.toString(). Values are business SKU strings.
         * Use when you only need the SKU and not the full mapping metadata.
         * QUERY: NEVER — object keys are not Firestore-queryable; use variantMappingsArray.
         *                Read directly when you know the variantId and need the SKU fast.
         */
        variantMappings?: { [variantId: string]: string };

        /**
         * Full mapping details for each mapped variant.
         * Keyed by variantId.toString(). Values are VariantMappingDetail objects.
         * Type: { [variantId: string]: VariantMappingDetail }
         * See VariantMappingDetail interface above for field documentation.
         *
         * THE authoritative source for resolving:
         *   variantId → businessProductSku + businessId
         *
         * Full join path:
         *   order.raw.line_items[].variant_id
         *   → variantMappingDetails[variantId.toString()].businessProductSku
         *   → users/{businessId}/products/{businessProductSku}
         *
         * QUERY: NEVER — object keys not Firestore-queryable; use variantMappingsArray.
         *                Read directly after fetching the product doc by productId.
         */
        variantMappingDetails?: {
            [variantId: string]: {
                /**
                 * The business product SKU this variant maps to.
                 * Links to users/{businessId}/products/{sku} (document ID = this value).
                 */
                businessProductSku: string;

                /**
                 * The business that owns this mapping. Links to users/{businessId}.
                 * On shared multi-vendor stores, multiple businesses can have mappings
                 * on the same product doc, each under a different variantId key.
                 */
                businessId: string;

                /** When this mapping was created. */
                mappTimestamp: Date;

                /** UID of the user who created this mapping. */
                mappedBy: string;
            }
        };

        // -- QUERYABLE VARIANT / SKU SHORTCUTS --------------------------------

        /**
         * Flat array of all SKU strings across all variants of this product.
         * Variants with null SKUs are excluded.
         * Exists for the same reason as variantMappingsArray — Firestore cannot
         * query into variants[].sku directly.
         * QUERY: MEDIUM — array-contains filter to find which product doc contains a given SKU.
         */
        skus: string[];

        /**
         * Count of variants on this product.
         * QUERY: LOW — informational.
         */
        variantCount: number;

        // -- EMBEDDED VARIANTS ------------------------------------------------

        /**
         * All variants of this product. One entry per purchasable option combination.
         * Type: ProductVariant[] — see ProductVariant interface above.
         *
         * KEY FIELDS PER VARIANT:
         *   id    — THE variantId. Primary join key to orders and variantMappingDetails.
         *   sku   — Shopify variant SKU (may be null, may differ from business SKU).
         *   title — display title e.g. "Blue / M".
         *   price — variant price (number).
         *   option1/2/3 — option values (e.g. "Blue", "M", null).
         *
         * NOTE: inventoryQuantity on each variant is Shopify's own stock count.
         *       It is completely superseded by Majime's UPC/placement system.
         *       Never use it for stock analytics.
         *
         * QUERY: NEVER — cannot filter into embedded array fields in Firestore.
         *                Use skus[] or variantMappingsArray[] for variant-level filtering.
         *                Read the variants[] array when displaying product detail.
         */
        variants: {
            id: number; // THE variantId — primary join key to orders and mappings
            productId: number;
            title: string; // e.g. "Blue / M"
            sku: null | string; // Shopify SKU — may be null; may differ from business SKU
            price: number; // variant price as number (NOT string, unlike order line_items[].price)
            position: number; // display order among variants
            option1: string; // first option value (e.g. "Blue")
            option2: null; // second option value if applicable
            option3: null; // third option value if applicable
            taxable: boolean;
            barcode: null;
            compareAtPrice: null;
            weight: null;
            weightUnit: null;
            inventoryItemId: number; // Shopify inventory item ID — for Shopify API calls only
            inventoryQuantity: number; // Shopify's stock count — IGNORE; superseded by Majime UPC system
            inventoryPolicy: string;
            inventoryManagement: null;
            fulfillmentService: null;
            requiresShipping: null;
            taxCode: null;
            grams: null;
            imageId: null;
            creatTimestamp: Date;
            updatTimestamp: Date;
        }[];

        // -- PRODUCT OPTIONS --------------------------------------------------

        /**
         * Option definitions for this product (e.g. Color, Size).
         * Type: ProductOption[] — see ProductOption interface above.
         * Defines what option1/option2/option3 mean on each variant.
         * Up to 3 options per product.
         * QUERY: NEVER — display only.
         */
        options: {
            id: number;
            productId: number;
            name: string; // option name e.g. "Color", "Size", "Material"
            position: number; // 1, 2, or 3 — corresponds to variant.option1/2/3
            values: string[]; // all possible values for this option
        }[];

        // -- IMAGES -----------------------------------------------------------

        /**
         * Primary display image.
         * Type: FeaturedImage — see FeaturedImage interface above.
         * QUERY: NEVER — read for display.
         */
        featuredImage: {
            id: number;
            src: string; // CDN URL of the image
            width: number;
            height: number;
            alt: null;
        };

        /**
         * All product images.
         * Type: ProductImage[] — see ProductImage interface above.
         * QUERY: NEVER — read for display.
         */
        images: {
            id: number;
            productId: number;
            position: number; // display order among images
            src: string; // CDN URL
            width: number;
            height: number;
            alt: null;
            variantIds: any[]; // variant IDs this image is associated with (usually empty)
            creatTimestamp: Date;
            updatTimestamp: Date;
        }[];

        // -- WEBHOOK TRACKING -------------------------------------------------

        /**
         * Shopify webhook topic that created this document (e.g. "products/create").
         * QUERY: NEVER — debugging only.
         */
        createdByTopic: string;

        /**
         * Shopify webhook topic that last updated this document (e.g. "products/update").
         * QUERY: NEVER — debugging only.
         */
        lastWebhookTopic: string;

        /**
         * Same as lastWebhookTopic in practice. May be absent on older documents.
         * QUERY: NEVER
         */
        updatedByTopic?: string;

        // -- TIMESTAMPS -------------------------------------------------------

        /**
         * When Shopify created this product. Date.
         * QUERY: LOW
         */
        shopifyCreatTimestamp: Date;

        /**
         * When this document was first created in Firestore. Firestore Timestamp.
         * QUERY: LOW
         */
        firestoreCreatTimestamp: Timestamp;

        /**
         * When Shopify last updated this product. Date.
         * QUERY: LOW
         */
        shopifyUpdatTimestamp: Date;

        /**
         * When this document was last updated in Firestore. Firestore Timestamp.
         * May be absent on older documents.
         * QUERY: NEVER
         */
        updatTimestamp?: Timestamp;

        /**
         * When the webhook that created this doc was received. Firestore Timestamp.
         * QUERY: NEVER — debugging only.
         */
        receivTimestamp: Timestamp;

        /**
         * When the products/delete webhook was received. Only present on deleted products.
         * QUERY: NEVER
         */
        deletTimestamp?: Timestamp;

        /**
         * When this product was published on Shopify. Null if unpublished/draft.
         * QUERY: LOW
         */
        publishTimestamp: Date | null;

        // -- SHOPIFY METADATA (display/SEO only — never query) ----------------

        /**
         * URL-friendly product identifier (e.g. "cotton-crew-neck-t-shirt").
         * QUERY: NEVER
         */
        handle: string;

        /**
         * Shopify product type (e.g. "T-Shirts"). Null if not set.
         * QUERY: LOW — occasionally used for product type grouping.
         */
        productType: string | null;

        /**
         * Shopify tags as a string array. Set by merchant on Shopify.
         * QUERY: LOW — array-contains if tag-based filtering is needed.
         */
        tags: string[];

        /**
         * Where the product is published ("web", "global", etc.).
         * QUERY: NEVER
         */
        publishedScope: string;

        /**
         * Product description HTML. Null if not set.
         * QUERY: NEVER
         */
        bodyHtml: null | string;

        // Remaining Shopify template/metafield fields — never used analytically.
        templateSuffix: null;
        metafieldsGlobalTitleTag: null;
        metafieldsGlobalDescriptionTag: null;
    };
}

// =============================================================================
// SHARED SUB-INTERFACES & TYPES
// =============================================================================
// These types are used in more than one place across the Business and Store
// modules. They are NOT standalone Firestore collections — they describe the
// shape of embedded fields, nested arrays, or shared type aliases.
//
// READING GUIDE:
//   Timestamp  — used on every Firestore document across all modules
//   ISODateString — used exclusively on orders.createdAt (Shopify-sourced string)
//   MoneySet / Money — used throughout raw.* monetary fields in orders
//   Address    — used in orders.raw.shipping_address, billing_address, and
//                orders.raw.customer.default_address, and parties.address
//   TaxLine    — used in orders.raw.tax_lines[] and raw.line_items[].tax_lines[]
//   LineItem   — used in orders.raw.line_items[], fulfillments[].line_items[],
//                and refunds[].refund_line_items[].line_item
// =============================================================================

/**
 * Firestore server Timestamp.
 * This is not a JavaScript Date — it is a Firestore Timestamp object with
 * two numeric fields. When reading from Firestore SDK it becomes a Timestamp
 * instance; when stored in Firestore it is a native Timestamp type.
 * Used on virtually every document across all modules for createdAt, updatedAt,
 * and all status-specific *At fields.
 */
interface Timestamp {
    _seconds: number;
    _nanoseconds: number;
}

/**
 * An ISO 8601 date string (e.g. "2024-01-15T14:30:00+05:30").
 * Used ONLY for orders.createdAt — the one field in the entire system that
 * stores a date as a string rather than a Firestore Timestamp.
 * Source: raw.created_at, copied from Shopify at order creation. Never changes.
 * IMPORTANT: Cannot be used in Firestore Timestamp comparisons.
 *            Use >= / <= with string comparison for date range filters.
 */
type ISODateString = string;

/**
 * A Shopify money set. Wraps any monetary value in two currencies:
 * the shop's own currency and the customer's presentment currency.
 * For INR-only stores these two are always identical.
 * Appears throughout raw.* wherever Shopify expresses a price with a _set suffix
 * (e.g. price_set, total_price_set, subtotal_price_set, amount_set, etc.).
 * Never queried analytically — read only for display or computation.
 */
interface MoneySet {
    shop_money: Money;
    presentment_money: Money;
}

/**
 * A single monetary value with its currency code.
 * amount is always a STRING (e.g. "1299.00") — not a number.
 * currency_code is always "INR" for Majime stores.
 */
interface Money {
    amount: string;       // string, not number — parse before arithmetic
    currency_code: Currency; // always "INR"
}

/**
 * A physical mailing address. Reused in three places:
 *   - orders.raw.shipping_address  (delivery address for this order)
 *   - orders.raw.billing_address   (billing address for this order)
 *   - orders.raw.customer.default_address  (customer's saved default)
 *
 * KEY FIELDS FOR THE APP:
 *   province / province_code — state name and code (e.g. "Punjab" / "PB").
 *     Used for GST intra/inter-state determination:
 *     province_code == "PB" or province.toLowerCase() == "punjab" → CGST + SGST (intra-state)
 *     anything else → IGST (inter-state)
 *   phone  — used for courier label and WhatsApp targeting
 *   zip    — postal code for Blue Dart routing
 *
 * All nullable fields are legitimately null when the customer did not provide them.
 */
interface Address {
    first_name: string;
    last_name: string | null;
    name: string;              // full name combined (first + last)
    address1: string;
    address2: string | null;
    company: string | null;
    city: string | null;
    province: string | null;       // state name — GST jurisdiction check
    province_code: string | null;  // state code e.g. "PB" — GST jurisdiction check
    zip: string;
    country: string;
    country_code: string;
    country_name?: string;
    phone: string | null;
    latitude?: number;
    longitude?: number;
    id?: number;
    customer_id?: number;
    default?: boolean;
}

/**
 * A single tax component on an order or line item.
 * Appears in:
 *   orders.raw.tax_lines[]                — order-level tax totals
 *   orders.raw.line_items[].tax_lines[]   — per-item tax breakdown
 *
 * HOW TAX WORKS IN MAJIME:
 *   Intra-state (Punjab → Punjab): two TaxLine entries per item — CGST + SGST,
 *     each at half the GST rate (e.g. 9% + 9% for 18% GST).
 *   Inter-state (Punjab → other state): one TaxLine entry per item — IGST,
 *     at the full GST rate (e.g. 18% for 18% GST).
 *   title tells you which component this is.
 *   rate is a decimal (0.09 for 9%). price is the computed tax amount as a string.
 */
interface TaxLine {
    title: "CGST" | "IGST" | "SGST";
    rate: number;    // decimal e.g. 0.09 for 9%
    price: string;   // computed tax amount as string e.g. "116.10"
    price_set: MoneySet;
    channel_liable: boolean;
}

/**
 * A single ordered product variant. The most analytically important sub-type
 * in the entire system.
 *
 * APPEARS IN THREE PLACES:
 *   orders.raw.line_items[]                        — the primary location
 *   orders.raw.fulfillments[].line_items[]         — copy at fulfillment time
 *   orders.raw.refunds[].refund_line_items[].line_item — copy at refund time
 *
 * PRIMARY JOIN KEY:
 *   variant_id (number) → accounts/{storeId}/products/{productId}
 *                          .variantMappingDetails[variant_id.toString()]
 *                          .businessProductSku
 *                        → users/{businessId}/products/{businessProductSku}
 *   This is the ONLY way to connect an order line item to a business product.
 *
 * CRITICAL TYPE NOTE:
 *   price is a STRING (e.g. "499.00") — unlike Warehouse.products.price which
 *   is a number. Always parse before arithmetic.
 *
 * APP-INJECTED FIELDS (Majime writes these into Shopify's structure):
 *   qc_status      — set during warehouse QC after a return arrives.
 *                    Drives the Pending Refunds status transition.
 *   refundedAmount — per-item refund amount, set during partial refund processing.
 *
 * ANALYTICS PATTERN:
 *   flattenArrayField("raw.line_items") → groupBy("variant_id" or "sku")
 *   → sumGrouped("quantity") for sales-by-product aggregation.
 */
interface LineItem {
    id: number;
    admin_graphql_api_id: string;
    variant_id: number;           // PRIMARY JOIN KEY — links to business product via mapping
    product_id: number;           // Shopify product ID
    sku: string;                  // Shopify variant SKU — may differ from business SKU
    vendor: string;               // source of orders.vendors[] array
    name: string;                 // full display name e.g. "T-Shirt - Blue / M"
    title: string;                // product title only
    variant_title: string;        // variant-only title e.g. "Blue / M"
    price: string;                // unit price as STRING — not a number
    quantity: number;             // ordered quantity
    current_quantity: number;     // quantity after any edits or cancellations
    fulfillable_quantity: number;
    fulfillment_status: "fulfilled" | "restocked" | "unfulfilled" | null;
    fulfillment_service: string;
    gift_card: boolean;
    grams: number;
    product_exists: boolean;
    requires_shipping: boolean;
    taxable: boolean;
    total_discount: string;
    total_discount_set: MoneySet;
    price_set: MoneySet;
    tax_lines: TaxLine[];         // per-item CGST/SGST/IGST breakdown
    discount_allocations: {
        amount: string;
        amount_set: MoneySet;
        discount_application_index: number; // index into raw.discount_applications[]
    }[];
    duties: any[];
    attributed_staffs: any[];
    properties: any[];
    sales_line_item_group_id?: null;

    // -- APP-INJECTED (written by Majime, not Shopify) -----------------------

    /** QC result after a return arrives at the warehouse. Only present on return orders. */
    qc_status?: "Not Received" | "QC Fail" | "QC Pass";

    /** Per-item refunded amount in INR. Only present if this item was refunded. */
    refundedAmount?: number;
}

// =============================================================================
// ENUMS
// =============================================================================

/** Forward and reverse courier providers used across the platform. */
enum Courier {
    BlueDart = "Blue Dart",
    Delhivery = "Delhivery",
    Shiprocket = "Shiprocket",
    Xpressbees = "Xpressbees",
    Dtdc = "DTDC",
}

/** Always INR for all Majime stores. */
enum Currency {
    Inr = "INR",
}

/** Shopify-side payment status on orders. Updated by orders/updated webhook. */
enum FinancialStatus {
    Paid = "paid",
    PartiallyPaid = "partially_paid",
    Pending = "pending",
    Refunded = "refunded",
    Voided = "voided",
}

/** Shopify-side fulfillment status on orders. Coarser than customStatus — prefer customStatus. */
enum FulfillmentStatusEnum {
    Fulfilled = "fulfilled",
    Restocked = "restocked",
    Unfulfilled = "unfulfilled",
}