// functions/src/migrations/migrateRtoClosedReceivedItems.ts
import { db } from "../firebaseAdmin";
import { onRequest } from "firebase-functions/https";

type StoreMigrationResult = {
    storeId: string;
    scanned: number;
    wouldUpdate: number;
    updated: number;
    skippedNoLineItems: number;
    skippedAlreadyCorrect: number;
    failed: number;
    examples: Array<{
        orderId: string;
        orderName?: string;
        rtoReceived: Array<string | number>;
    }>;
    failedOrders: Array<{
        orderId: string;
        error: string;
    }>;
};

const DEFAULT_BATCH_LIMIT = 450;
const MAX_EXAMPLES = 50;

function normalizeShopIds(input: unknown): string[] {
    if (!Array.isArray(input)) {
        throw new Error("shopIds must be a non-empty array of strings.");
    }

    const shopIds = input
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);

    if (shopIds.length === 0) {
        throw new Error("shopIds must be a non-empty array of strings.");
    }

    return [...new Set(shopIds)];
}

function arraysEqualAsStrings(a: unknown[], b: unknown[]) {
    if (a.length !== b.length) return false;

    return a.every((item, index) => String(item) === String(b[index]));
}

function buildUpdatedLineItems(lineItems: any[]) {
    return lineItems.map((item) => ({
        ...item,
        rtoReceived: true,
    }));
}

function getVariantIds(lineItems: any[]) {
    return lineItems
        .map((item) => item?.variant_id)
        .filter((variantId) => variantId !== undefined && variantId !== null);
}

function isAlreadyCorrect(orderData: any, updatedLineItems: any[], rtoReceived: any[]) {
    const currentLineItems = Array.isArray(orderData?.raw?.line_items)
        ? orderData.raw.line_items
        : [];

    const everyLineItemMarked = currentLineItems.every(
        (item: any) => item?.rtoReceived === true
    );

    const currentRtoReceived = Array.isArray(orderData?.rtoReceived)
        ? orderData.rtoReceived
        : [];

    return (
        everyLineItemMarked &&
        arraysEqualAsStrings(currentRtoReceived, rtoReceived)
    );
}

async function migrateStore(params: {
    storeId: string;
    dryRun: boolean;
    batchLimit: number;
}): Promise<StoreMigrationResult> {
    const { storeId, dryRun, batchLimit } = params;

    const result: StoreMigrationResult = {
        storeId,
        scanned: 0,
        wouldUpdate: 0,
        updated: 0,
        skippedNoLineItems: 0,
        skippedAlreadyCorrect: 0,
        failed: 0,
        examples: [],
        failedOrders: [],
    };

    const ordersRef = db
        .collection("accounts")
        .doc(storeId)
        .collection("orders");

    const snapshot = await ordersRef
        .where("customStatus", "==", "RTO Closed")
        .get();

    result.scanned = snapshot.size;

    let batch = db.batch();
    let batchCount = 0;

    async function commitBatchIfNeeded(force = false) {
        if (!dryRun && batchCount > 0 && (force || batchCount >= batchLimit)) {
            await batch.commit();
            batch = db.batch();
            batchCount = 0;
        }
    }

    for (const doc of snapshot.docs) {
        try {
            const orderData = doc.data();

            const lineItems = Array.isArray(orderData?.raw?.line_items)
                ? orderData.raw.line_items
                : [];

            if (lineItems.length === 0) {
                result.skippedNoLineItems++;
                continue;
            }

            const updatedLineItems = buildUpdatedLineItems(lineItems);
            const rtoReceived = getVariantIds(lineItems);

            if (isAlreadyCorrect(orderData, updatedLineItems, rtoReceived)) {
                result.skippedAlreadyCorrect++;
                continue;
            }

            result.wouldUpdate++;

            if (result.examples.length < MAX_EXAMPLES) {
                result.examples.push({
                    orderId: doc.id,
                    orderName: orderData?.name || orderData?.raw?.name,
                    rtoReceived,
                });
            }

            if (!dryRun) {
                batch.update(doc.ref, {
                    "raw.line_items": updatedLineItems,
                    rtoReceived,
                });

                batchCount++;
                result.updated++;

                await commitBatchIfNeeded();
            }
        } catch (error) {
            result.failed++;
            result.failedOrders.push({
                orderId: doc.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    await commitBatchIfNeeded(true);

    return result;
}

export const migrateRtoClosedReceivedItems = onRequest(
    {
        cors: true,
        timeoutSeconds: 3600,
        memory: "1GiB",
    },
    async (req, res) => {
        const startedAt = Date.now();

        try {
            if (req.method !== "POST") {
                res.status(405).json({
                    error: "Method not allowed. Use POST.",
                });
                return;
            }

            const dryRun = req.body?.dryRun !== false;
            const shopIds = normalizeShopIds(req.body?.shopIds);

            const batchLimit =
                typeof req.body?.batchLimit === "number" &&
                    req.body.batchLimit > 0 &&
                    req.body.batchLimit <= 450
                    ? req.body.batchLimit
                    : DEFAULT_BATCH_LIMIT;

            const results: StoreMigrationResult[] = [];

            for (const storeId of shopIds) {
                const storeResult = await migrateStore({
                    storeId,
                    dryRun,
                    batchLimit,
                });

                results.push(storeResult);
            }

            const summary = results.reduce(
                (acc, item) => {
                    acc.scanned += item.scanned;
                    acc.wouldUpdate += item.wouldUpdate;
                    acc.updated += item.updated;
                    acc.skippedNoLineItems += item.skippedNoLineItems;
                    acc.skippedAlreadyCorrect += item.skippedAlreadyCorrect;
                    acc.failed += item.failed;
                    return acc;
                },
                {
                    scanned: 0,
                    wouldUpdate: 0,
                    updated: 0,
                    skippedNoLineItems: 0,
                    skippedAlreadyCorrect: 0,
                    failed: 0,
                }
            );

            res.status(200).json({
                success: true,
                dryRun,
                message: dryRun
                    ? "Dry run complete. No orders were updated."
                    : "Migration complete.",
                durationMs: Date.now() - startedAt,
                summary,
                results,
            });
        } catch (error) {
            console.error("migrateRtoClosedReceivedItems failed:", error);

            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                durationMs: Date.now() - startedAt,
            });
        }
    }
);