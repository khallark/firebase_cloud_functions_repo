import { onRequest } from "firebase-functions/https";
import { db } from "../firebaseAdmin";
import { Timestamp } from "firebase-admin/firestore";

interface Inventory {
    autoAddition: number;
    autoDeduction: number;
    blockedStock: number;
    deduction: number;
    inwardAddition: number;
    openingStock: number;
}

function calculatePhysicalStock(inv: Inventory): number {
    return (
        inv.openingStock + inv.inwardAddition - inv.deduction + inv.autoAddition - inv.autoDeduction
    );
}

export const createInventorySnapshotOnRequest = onRequest(
    {
        timeoutSeconds: 1800,
        memory: "4GiB",
        cors: true,
    },
    async (req, res) => {
        try {
            if (req.method !== "POST") {
                res.status(405).json({
                    success: false,
                    error: "Only POST method is allowed",
                });
                return;
            }

            const { businessId, name, date } = req.body || {};

            if (!businessId || typeof businessId !== "string") {
                res.status(400).json({
                    success: false,
                    error: "businessId is required",
                });
                return;
            }

            if (!name || typeof name !== "string") {
                res.status(400).json({
                    success: false,
                    error: "name is required",
                });
                return;
            }

            if (!date || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                res.status(400).json({
                    success: false,
                    error: "date is required in YYYY-MM-DD format",
                });
                return;
            }

            const productsSnapshot = await db
                .collection("users")
                .doc(businessId)
                .collection("products")
                .where("name", "==", name)
                .get();

            if (productsSnapshot.empty) {
                res.status(404).json({
                    success: false,
                    error: "No products found with this name",
                });
                return;
            }

            const results: {
                productId: string;
                success: boolean;
                error?: string;
            }[] = [];

            for (const productDoc of productsSnapshot.docs) {
                try {
                    const product = productDoc.data();

                    if (!product?.inventory) {
                        results.push({
                            productId: productDoc.id,
                            success: false,
                            error: "Product has no inventory object",
                        });
                        continue;
                    }

                    const stockLevel = calculatePhysicalStock(product.inventory);
                    const snapshotId = `${productDoc.id}_${date}`;

                    await db
                        .collection("users")
                        .doc(businessId)
                        .collection("inventory_snapshots")
                        .doc(snapshotId)
                        .set(
                            {
                                productId: productDoc.id,
                                date,
                                stockLevel,
                                isStockout: stockLevel === 0,
                                dailySales: 0,
                                timestamp: Timestamp.now(),
                                exactDocState: { ...product },
                            },
                            { merge: true },
                        );

                    results.push({
                        productId: productDoc.id,
                        success: true,
                    });
                } catch (err: any) {
                    console.error(`Default snapshot failed for product ${productDoc.id}`, err);

                    results.push({
                        productId: productDoc.id,
                        success: false,
                        error: err?.message || "Unknown error",
                    });
                }
            }

            res.status(200).json({
                success: true,
                businessId,
                name,
                date,
                matchedProducts: productsSnapshot.size,
                createdSnapshots: results.filter((r) => r.success).length,
                failedSnapshots: results.filter((r) => !r.success).length,
                results,
            });
        } catch (err: any) {
            console.error("Default inventory snapshot job failed", err);

            res.status(500).json({
                success: false,
                error: err?.message || "Internal server error",
            });
        }
    },
);