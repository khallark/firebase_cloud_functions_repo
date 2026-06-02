import { onRequest } from "firebase-functions/v2/https";
import {
    DocumentReference,
    FieldPath,
    FieldValue,
    QueryDocumentSnapshot,
    WriteBatch,
} from "firebase-admin/firestore";
import { db } from "../firebaseAdmin";
import { SHARED_STORE_IDS } from "../config";

type NormalizedPaymentStatus =
    | "Refund"
    | "COD"
    | "Partially Paid"
    | "Prepaid";

const PAGE_SIZE = 400;
const WRITE_BATCH_LIMIT = 450;

// function cleanString(value: unknown): string {
//     return String(value ?? "")
//         .trim()
//         .toLowerCase()
//         .replace(/\s+/g, " ");
// }

// function cleanJoined(values: unknown[]): string {
//     return values
//         .map(cleanString)
//         .filter(Boolean)
//         .join(" ");
// }

function toNumber(value: unknown): number {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;

    if (typeof value === "string") {
        const cleaned = value.replace(/,/g, "").trim();
        const parsed = Number(cleaned);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    return 0;
}

function normalizePaymentStatus(raw: any): NormalizedPaymentStatus {
    const totalOutstanding = toNumber(raw?.total_outstanding);
    const totalPrice = toNumber(raw?.total_price);

    if (totalOutstanding < 0) return "Refund";

    // Fully paid / no amount left to collect
    if (totalOutstanding === 0) return "Prepaid";

    // Some amount paid, some still outstanding
    if (totalOutstanding > 0 && totalOutstanding < totalPrice) {
        return "Partially Paid";
    }

    // Full amount still outstanding, usually COD / unpaid
    return "COD";
}

function getShippingOrBillingState(raw: any): string {
    return (
        raw?.shipping_address?.province ||
        raw?.billing_address?.province ||
        raw?.customer?.default_address?.province ||
        "N/A"
    );
}

function getShippingOrBillingCity(raw: any): string {
    return (
        raw?.shipping_address?.city ||
        raw?.billing_address?.city ||
        raw?.customer?.default_address?.city ||
        "N/A"
    );
}

function getPhoneNumber(raw: any): string {
    return (
        raw?.shipping_address?.phone ||
        raw?.billing_address?.phone ||
        raw?.customer?.phone ||
        raw?.customer?.default_address?.phone ||
        "N/A"
    );
}

function normalizeVendors(vendors: unknown): {
    changed: boolean;
    nextVendors: string[];
    prevVendors: string[];
} {
    const prevVendors = Array.isArray(vendors)
        ? vendors
            .filter((v) => typeof v === "string")
            .map((v) => v.trim())
            .filter(Boolean)
        : [];

    const normalizedUpper = prevVendors.map((v) => v.toUpperCase());

    const hasOwrAlias =
        normalizedUpper.includes("BBB") ||
        normalizedUpper.includes("GHAMAND");

    if (!hasOwrAlias) {
        return {
            changed: false,
            nextVendors: prevVendors,
            prevVendors,
        };
    }

    const nextSet = new Set<string>();

    for (const vendor of prevVendors) {
        const upper = vendor.toUpperCase();

        if (upper === "BBB" || upper === "GHAMAND" || upper === "OWR") {
            nextSet.add("OWR");
        } else {
            nextSet.add(vendor);
        }
    }

    const nextVendors = Array.from(nextSet);

    const changed =
        nextVendors.length !== prevVendors.length ||
        nextVendors.some((vendor, index) => vendor !== prevVendors[index]);

    return {
        changed,
        nextVendors,
        prevVendors,
    };
}

function isEqualArray(a: unknown, b: unknown): boolean {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;

    return a.every((item, index) => item === b[index]);
}

function buildOrderUpdates(orderData: any): Record<string, any> {
    const raw = orderData?.raw || {};
    // const lineItems = Array.isArray(raw?.line_items) ? raw.line_items : [];

    const totalOutstanding = toNumber(raw?.total_outstanding);

    const updates: Record<string, any> = {
        shippingOrBillingState: getShippingOrBillingState(raw),
        paymentStatus: normalizePaymentStatus(raw),
        phoneNumber: getPhoneNumber(raw),
        totalOutstanding,
        shippingOrBillingCity: getShippingOrBillingCity(raw),
        
        // App-owned normalized field for packed filter.
        // Do not derive this from raw Shopify data; lastPackedAt is your app field.
        isPacked: !!orderData?.lastPackedAt,
    };
    

    /*
    // Optional searchable line-item helper fields.
    // These are commented because Firestore can only use prefix/range queries,
    // so they may not be very useful for contains-style searching.

    updates.lineItemSkus = cleanJoined(
        lineItems.map((item: any) => item?.sku)
    );

    updates.lineItemNames = cleanJoined(
        lineItems.map((item: any) => item?.name)
    );

    updates.lineItemVariantId = cleanJoined(
        lineItems.map((item: any) => String(item?.variant_id ?? ""))
    );
    */

    const vendorNormalization = normalizeVendors(orderData?.vendors);

    if (vendorNormalization.changed) {
        updates.vendors = vendorNormalization.nextVendors;

        // Store the original vendors only when changing vendors.
        // If prevVendors already exists, this overwrites it with the actual
        // previous value from this run, which is usually what you want in a backfill.
        updates.prevVendors = vendorNormalization.prevVendors;
    }

    updates.normalizedClientSideFieldsAt = FieldValue.serverTimestamp();

    return updates;
}

function removeUnchangedFields(
    currentData: any,
    updates: Record<string, any>
): Record<string, any> {
    const changedUpdates: Record<string, any> = {};

    for (const [key, nextValue] of Object.entries(updates)) {
        if (key === "normalizedClientSideFieldsAt") {
            continue;
        }

        const currentValue = currentData?.[key];

        if (Array.isArray(nextValue)) {
            if (!isEqualArray(currentValue, nextValue)) {
                changedUpdates[key] = nextValue;
            }
            continue;
        }

        if (currentValue !== nextValue) {
            changedUpdates[key] = nextValue;
        }
    }

    if (Object.keys(changedUpdates).length > 0) {
        changedUpdates.normalizedClientSideFieldsAt =
            updates.normalizedClientSideFieldsAt;
    }

    return changedUpdates;
}

async function commitBatchIfNeeded(
    batchState: {
        batch: WriteBatch;
        writes: number;
    }
) {
    if (batchState.writes === 0) return;

    await batchState.batch.commit();

    batchState.batch = db.batch();
    batchState.writes = 0;
}

export const normalizeCurrentClientSideFields = onRequest(
    { cors: true, timeoutSeconds: 540, memory: "2GiB" },
    async (req, res) => {
        const dryRun =
            req.query.dryRun === "true" ||
            req.body?.dryRun === true;

        const startedAt = Date.now();

        const summary = {
            dryRun,
            storesProcessed: 0,
            ordersScanned: 0,
            ordersUpdated: 0,
            vendorArraysFixed: 0,
            batchesCommitted: 0,
            stores: [] as Array<{
                storeId: string;
                scanned: number;
                updated: number;
                vendorArraysFixed: number;
            }>,
            errors: [] as Array<{
                storeId: string;
                message: string;
            }>,
            durationMs: 0,
        };

        try {
            for (const storeId of SHARED_STORE_IDS) {
                const storeSummary = {
                    storeId,
                    scanned: 0,
                    updated: 0,
                    vendorArraysFixed: 0,
                };

                try {
                    const ordersRef = db
                        .collection("accounts")
                        .doc(storeId)
                        .collection("orders");

                    let lastDoc:
                        | QueryDocumentSnapshot
                        | null = null;

                    let hasMore = true;

                    let batchState = {
                        batch: db.batch(),
                        writes: 0,
                    };

                    while (hasMore) {
                        let q = ordersRef
                            .orderBy(FieldPath.documentId())
                            .limit(PAGE_SIZE);

                        if (lastDoc) {
                            q = q.startAfter(lastDoc);
                        }

                        const snapshot = await q.get();

                        if (snapshot.empty) {
                            hasMore = false;
                            break;
                        }

                        for (const docSnap of snapshot.docs) {
                            const orderData = docSnap.data();

                            summary.ordersScanned++;
                            storeSummary.scanned++;

                            const updates = buildOrderUpdates(orderData);
                            const changedUpdates = removeUnchangedFields(
                                orderData,
                                updates
                            );

                            if (Object.keys(changedUpdates).length === 0) {
                                continue;
                            }

                            if (changedUpdates.vendors) {
                                summary.vendorArraysFixed++;
                                storeSummary.vendorArraysFixed++;
                            }

                            summary.ordersUpdated++;
                            storeSummary.updated++;

                            if (!dryRun) {
                                batchState.batch.update(
                                    docSnap.ref as DocumentReference,
                                    changedUpdates
                                );

                                batchState.writes++;

                                if (batchState.writes >= WRITE_BATCH_LIMIT) {
                                    await commitBatchIfNeeded(batchState);
                                    summary.batchesCommitted++;
                                }
                            }
                        }

                        lastDoc = snapshot.docs[snapshot.docs.length - 1];

                        if (snapshot.size < PAGE_SIZE) {
                            hasMore = false;
                        }
                    }

                    if (!dryRun && batchState.writes > 0) {
                        await commitBatchIfNeeded(batchState);
                        summary.batchesCommitted++;
                    }

                    summary.storesProcessed++;
                    summary.stores.push(storeSummary);
                } catch (error: any) {
                    console.error(
                        `Error normalizing orders for store ${storeId}:`,
                        error
                    );

                    summary.errors.push({
                        storeId,
                        message:
                            error?.message ||
                            "Unknown error while normalizing store orders",
                    });
                }
            }

            summary.durationMs = Date.now() - startedAt;

            res.status(summary.errors.length > 0 ? 207 : 200).json({
                ...summary,
                totalStoresConfigured: SHARED_STORE_IDS.length,
            });
        } catch (error: any) {
            console.error("Fatal normalizeCurrentClientSideFields error:", error);

            res.status(500).json({
                error:
                    error?.message ||
                    "Unknown fatal error while normalizing client-side fields",
                ...summary,
                durationMs: Date.now() - startedAt,
            });
        }
    }
);