// import { Timestamp } from "firebase-admin/firestore";

// interface Business {
//     B2B: {
//         /**
//          * 
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
//          * 
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
//          * 
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
//          * 
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
//          * 
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
//          * 
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
//          * 
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
//          * 
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
//          * 
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
//      * 
//      */
//     Warehouse: {
//         /**
//          * 
//          */
//         products: {};
//         /**
//          * 
//          */
//         inventory_snapshots: {};
//         /**
//          * 
//          */
//         counters: {};
//         /**
//          * 
//          */
//         parties: {
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
//             type: 'supplier' | 'customer' | 'both';
//             /**
//              * 
//              */
//             code: string | null;
//             /**
//              * 
//              */
//             contactPerson: string | null;
//             /**
//              * 
//              */
//             phone: string | null;
//             /**
//              * 
//              */
//             email: string | null;
//             /**
//              * 
//              */
//             address: {
//                 /**
//                  * 
//                  */
//                 line1: string | null;
//                 /**
//                  * 
//                  */
//                 line2: string | null;
//                 /**
//                  * 
//                  */
//                 city: string | null;
//                 /**
//                  * 
//                  */
//                 state: string | null;
//                 /**
//                  * 
//                  */
//                 pincode: string | null;
//                 /**
//                  * 
//                  */
//                 country: string;
//             } | null;
//             /**
//              * 
//              */
//             gstin: string | null;
//             /**
//              * 
//              */
//             pan: string | null;
//             /**
//              * 
//              */
//             bankDetails: {
//                 /**
//                  * 
//                  */
//                 accountName: string | null;
//                 /**
//                  * 
//                  */
//                 accountNumber: string | null;
//                 /**
//                  * 
//                  */
//                 ifsc: string | null;
//                 /**
//                  * 
//                  */
//                 bankName: string | null;
//             } | null;
//             /**
//              * 
//              */
//             defaultPaymentTerms: string | null;
//             /**
//              * 
//              */
//             notes: string | null;
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
//             /**
//              * 
//              */
//             createdBy: string;
//             /**
//              * 
//              */
//             updatedBy: string;
//         };
//         /**
//          * 
//          */
//         purchaseOrders: {
//             /**
//              * 
//              */
//             id: string;
//             /**
//              * 
//              */
//             poNumber: string;
//             /**
//              * 
//              */
//             businessId: string;
//             /**
//              * 
//              */
//             supplierPartyId: string;
//             /**
//              * 
//              */
//             supplierName: string;
//             /**
//              * 
//              */
//             warehouseId: string;
//             /**
//              * 
//              */
//             warehouseName: string | null;
//             /**
//              * 
//              */
//             status: 'draft' | 'confirmed' | 'partially_received' | 'fully_received' | 'closed' | 'cancelled';
//             /**
//              * 
//              */
//             orderedSkus: string[];
//             /**
//              * 
//              */
//             itemCount: number;
//             /**
//              * 
//              */
//             items: {
//                 /**
//                  * 
//                  */
//                 sku: string;
//                 /**
//                  * 
//                  */
//                 productName: string;
//                 /**
//                  * 
//                  */
//                 expectedQty: number;
//                 /**
//                  * 
//                  */
//                 unitCost: number;
//                 /**
//                  * 
//                  */
//                 receivedQty: number;
//                 /**
//                  * 
//                  */
//                 notReceivedQty: number;
//                 /**
//                  * 
//                  */
//                 status: 'pending' | 'partially_received' | 'fully_received' | 'closed';
//             }[];
//             /**
//              * 
//              */
//             totalAmount: number;
//             /**
//              * 
//              */
//             currency: string | null;
//             /**
//              * 
//              */
//             expectedDate: Timestamp;
//             /**
//              * 
//              */
//             confirmedAt: Timestamp | null;
//             /**
//              * 
//              */
//             completedAt: Timestamp | null;
//             /**
//              * 
//              */
//             cancelledAt: Timestamp | null;
//             /**
//              * 
//              */
//             cancelReason: string | null;
//             /**
//              * 
//              */
//             notes: string | null;
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
//          * 
//          */
//         grns: {
//             /**
//              * 
//              */
//             id: string;
//             /**
//              * 
//              */
//             grnNumber: string;
//             /**
//              * 
//              */
//             businessId: string;
//             /**
//              * 
//              */
//             poId: string;
//             /**
//              * 
//              */
//             poNumber: string;
//             /**
//              * 
//              */
//             warehouseId: string;
//             /**
//              * 
//              */
//             warehouseName: string | null;
//             /**
//              * 
//              */
//             billNumber: string;
//             /**
//              * 
//              */
//             status: 'draft' | 'completed' | 'cancelled';
//             /**
//              * 
//              */
//             receivedSkus: string[];
//             /**
//              * 
//              */
//             items: {
//                 /**
//                  * 
//                  */
//                 sku: string;
//                 /**
//                  * 
//                  */
//                 productName: string;
//                 /**
//                  * 
//                  */
//                 expectedQty: number;
//                 /**
//                  * 
//                  */
//                 receivedQty: number;
//                 /**
//                  * 
//                  */
//                 notReceivedQty: number;
//                 /**
//                  * 
//                  */
//                 unitCost: number;
//                 /**
//                  * 
//                  */
//                 totalCost: number;
//             }[];
//             /**
//              * 
//              */
//             totalReceivedValue: number;
//             /**
//              * 
//              */
//             totalExpectedQty: number;
//             /**
//              * 
//              */
//             totalReceivedQty: number;
//             /**
//              * 
//              */
//             totalNotReceivedQty: number;
//             /**
//              * 
//              */
//             receivedBy: string;
//             /**
//              * 
//              */
//             receivedAt: Timestamp;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//             /**
//              * 
//              */
//             updatedAt: Timestamp;
//             /**
//              * 
//              */
//             notes: string | null;
//         };
//         /**
//          * 
//          */
//         upcs: {
//             /**
//              * 
//              */
//             id: string;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//             /**
//              * 
//              */
//             updatedAt: Timestamp;
//             /**
//              * 
//              */
//             createdBy: string;
//             /**
//              * 
//              */
//             updatedBy: string;
//             /**
//              * 
//              */
//             storeId: string | null;
//             /**
//              * 
//              */
//             orderId: string | null;
//             /**
//              * 
//              */
//             grnRef: string | null;
//             /**
//              * 
//              */
//             putAway: "none" | "outbound" | null;
//             /**
//              * 
//              */
//             productId: string;
//             /**
//              * 
//              */
//             warehouseId: string;
//             /**
//              * 
//              */
//             zoneId: string;
//             /**
//              * 
//              */
//             rackId: string;
//             /**
//              * 
//              */
//             shelfId: string;
//             /**
//              * 
//              */
//             placementId: string;
//         } | {
//             /**
//              * 
//              */
//             id: string;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//             /**
//              * 
//              */
//             updatedAt: Timestamp;
//             /**
//              * 
//              */
//             createdBy: string;
//             /**
//              * 
//              */
//             updatedBy: string;
//             /**
//              * 
//              */
//             storeId: string | null;
//             /**
//              * 
//              */
//             orderId: string | null;
//             /**
//              * 
//              */
//             grnRef: string | null;
//             /**
//              * 
//              */
//             putAway: "inbound";
//             /**
//              * 
//              */
//             productId: string;
//             /**
//              * 
//              */
//             warehouseId: string | null;
//             /**
//              * 
//              */
//             zoneId: string | null;
//             /**
//              * 
//              */
//             rackId: string | null;
//             /**
//              * 
//              */
//             shelfId: string | null;
//             /**
//              * 
//              */
//             placementId: string | null;
//         };
//         /**
//          * 
//          */
//         upcsLogs: {
//             /**
//              * 
//              */
//             grnRef: string | null;
//             /**
//              * 
//              */
//             productId: string;
//             /**
//              * 
//              */
//             timestamp: Timestamp
//             /**
//              * 
//              */
//             upcId: string;
//             /**
//              * 
//              */
//             snapshot: {
//                 /**
//                  * 
//                  */
//                 storeId: string | null;
//                 /**
//                  * 
//                  */
//                 orderId: string | null;
//                 /**
//                  * 
//                  */
//                 putAway: "none" | "outbound" | null;
//                 /**
//                  * 
//                  */
//                 placementId: string | null;
//                 /**
//                  * 
//                  */
//                 shelfId: string | null;
//                 /**
//                  * 
//                  */
//                 rackId: string | null;
//                 /**
//                  * 
//                  */
//                 zoneId: string | null;
//                 /**
//                  * 
//                  */
//                 warehouseId: string | null;
//             };
//         };
//         /**
//          * 
//          */
//         placements: {
//             /**
//              * 
//              */
//             id: string;
//             /**
//              * 
//              */
//             createUPCs: boolean;
//             /**
//              * 
//              */
//             quantity: number;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//             /**
//              * 
//              */
//             updatedAt: Timestamp;
//             /**
//              * 
//              */
//             createdBy: string;
//             /**
//              * 
//              */
//             updatedBy: string;
//             /**
//              * 
//              */
//             productId: string;
//             /**
//              * 
//              */
//             warehouseId: string;
//             /**
//              * 
//              */
//             zoneId: string;
//             /**
//              * 
//              */
//             rackId: string;
//             /**
//              * 
//              */
//             shelfId: string;
//             /**
//              * 
//              */
//             lastMovementReason: string | null;
//             /**
//              * 
//              */
//             lastMovementReference: string | null;
//         };
//         /**
//          * 
//          */
//         shelves: {
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
//             code: string;
//             /**
//              * 
//              */
//             capacity: number | null;
//             /**
//              * 
//              */
//             isDeleted: boolean;
//             /**
//              * 
//              */
//             deletedAt: Timestamp | null;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//             /**
//              * 
//              */
//             updatedAt: Timestamp;
//             /**
//              * 
//              */
//             createdBy: string;
//             /**
//              * 
//              */
//             updatedBy: string;
//             /**
//              * 
//              */
//             warehouseId: string;
//             /**
//              * 
//              */
//             zoneId: string;
//             /**
//              * 
//              */
//             rackId: string;
//             /**
//              * 
//              */
//             position: number;
//             /**
//              * 
//              */
//             stats: {
//                 /**
//                  * 
//                  */
//                 totalProducts: number;
//             };
//             /**
//              * 
//              */
//             locationVersion: number;
//             /**
//              * 
//              */
//             nameVersion: number;
//         };
//         /**
//          * 
//          */
//         racks: {
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
//             code: string;
//             /**
//              * 
//              */
//             isDeleted: boolean;
//             /**
//              * 
//              */
//             deletedAt: Timestamp | null;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//             /**
//              * 
//              */
//             updatedAt: Timestamp;
//             /**
//              * 
//              */
//             createdBy: string;
//             /**
//              * 
//              */
//             updatedBy: string;
//             /**
//              * 
//              */
//             warehouseId: string;
//             /**
//              * 
//              */
//             zoneId: string;
//             /**
//              * 
//              */
//             position: number;
//             /**
//              * 
//              */
//             stats: {
//                 /**
//                  * 
//                  */
//                 totalShelves: number;
//                 /**
//                  * 
//                  */
//                 totalProducts: number;
//             };
//             /**
//              * 
//              */
//             locationVersion: number;
//             /**
//              * 
//              */
//             nameVersion: number;
//         };
//         /**
//          * 
//          */
//         zones: {
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
//             code: string;
//             /**
//              * 
//              */
//             description: string | null;
//             /**
//              * 
//              */
//             isDeleted: boolean;
//             /**
//              * 
//              */
//             deletedAt: Timestamp | null;
//             /**
//              * 
//              */
//             createdAt: Timestamp;
//             /**
//              * 
//              */
//             updatedAt: Timestamp;
//             /**
//              * 
//              */
//             createdBy: string;
//             /**
//              * 
//              */
//             updatedBy: string;
//             /**
//              * 
//              */
//             warehouseId: string;
//             /**
//              * 
//              */
//             stats: {
//                 /**
//                  * 
//                  */
//                 totalRacks: number;
//                 /**
//                  * 
//                  */
//                 totalShelves: number;
//                 /**
//                  * 
//                  */
//                 totalProducts: number;
//             };
//             /**
//              * 
//              */
//             locationVersion: number;
//             /**
//              * 
//              */
//             nameVersion: number;
//         };
//         /**
//          * 
//          */
//         warehouses: {
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
//             code: string;
//             /**
//              * 
//              */
//             address: string;
//             /**
//              * 
//              */
//             storageCapacity: number;
//             /**
//              * 
//              */
//             operationalHours: number;
//             /**
//              * 
//              */
//             defaultGSTstate: string;
//             /**
//              * 
//              */
//             isDeleted: boolean;
//             /**
//              * 
//              */
//             deletedAt: Timestamp | null;
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
//             /**
//              * 
//              */
//             updatedBy: string;
//             /**
//              * 
//              */
//             stats: {
//                 /**
//                  * 
//                  */
//                 totalZones: number;
//                 /**
//                  * 
//                  */
//                 totalRacks: number;
//                 /**
//                  * 
//                  */
//                 totalShelves: number;
//                 /**
//                  * 
//                  */
//                 totalProducts: number;
//             };
//             /**
//              * 
//              */
//             nameVersion: number;
//         };
//     };
// }
// interface Store {
//     members: {};
//     orders: {};
//     products: {};
// }