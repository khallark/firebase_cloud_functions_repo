import { onRequest } from "firebase-functions/v2/https";
import { DocumentReference, FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firebaseAdmin";
import { SHARED_STORE_IDS } from "../config";
import { toCamelCase } from "../helpers";

type CustomStatus =
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
    | "Lost"
    | "Closed"
    | "RTO Closed"
    | "Cancellation Requested"
    | "Cancelled";

const VALID_STATUSES = new Set<string>([
    "New", "Confirmed", "Ready To Dispatch", "Dispatched", "In Transit",
    "Out For Delivery", "Delivered", "RTO In Transit", "RTO Delivered",
    "DTO Requested", "DTO Booked", "DTO In Transit", "DTO Delivered",
    "Pending Refunds", "DTO Refunded", "Lost", "Closed", "RTO Closed",
    "Cancellation Requested", "Cancelled",
]);

function statusToFieldName(status: CustomStatus): string {
    return toCamelCase(status) + "At";
}

export const syncStatusTimestamps = onRequest(
    { cors: true, timeoutSeconds: 540, memory: "2GiB" },
    async (req, res) => {
        const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;

        let totalOrders = 0;
        let updatedOrders = 0;
        let skippedOrders = 0;

        for (const storeId of SHARED_STORE_IDS) {
            const ordersSnap = await db
                .collection("accounts")
                .doc(storeId)
                .collection("orders")
                .get();

            console.log(`Store ${storeId}: ${ordersSnap.size} orders`);
            totalOrders += ordersSnap.size;

            const BATCH_SIZE = 499;
            let batchOps: Array<{ ref: DocumentReference; fields: Record<string, Timestamp | FieldValue> }> = [];

            const flush = async () => {
                if (batchOps.length === 0) return;
                if (!dryRun) {
                    const batch = db.batch();
                    for (const { ref, fields } of batchOps) {
                        batch.update(ref, fields);
                    }
                    await batch.commit();
                }
                updatedOrders += batchOps.length;
                batchOps = [];
            };

            for (const doc of ordersSnap.docs) {
                const order = doc.data();
                const logs: Array<{ status: string; createdAt: Timestamp }> = order.customStatusesLogs ?? [];

                const sortedLogs = [...logs].sort((a, b) => {
                    const aMs = a.createdAt?.toMillis?.() ?? 0;
                    const bMs = b.createdAt?.toMillis?.() ?? 0;
                    return aMs - bMs;
                });

                const fields: Record<string, Timestamp | FieldValue> = {};
                const loggedStatuses = new Set(logs.map((l) => l.status));
                const seen = new Set<string>();

                // 1. Set {status}At from first occurrence in logs
                for (const log of sortedLogs) {
                    if (!VALID_STATUSES.has(log.status)) continue;
                    if (seen.has(log.status)) continue;
                    seen.add(log.status);
                    if (log.createdAt) {
                        fields[statusToFieldName(log.status as CustomStatus)] = log.createdAt;
                    }
                }

                // 2. Delete stale {status}At fields not backed by a log entry
                for (const status of VALID_STATUSES) {
                    const fieldName = statusToFieldName(status as CustomStatus);
                    if (!loggedStatuses.has(status) && order[fieldName] != null) {
                        fields[fieldName] = FieldValue.delete();
                    }
                }

                if (Object.keys(fields).length === 0) {
                    skippedOrders++;
                    continue;
                }

                batchOps.push({ ref: doc.ref, fields });

                if (batchOps.length >= BATCH_SIZE) {
                    await flush();
                }
            }

            await flush();
        }

        res.status(200).json({
            dryRun,
            storesProcessed: SHARED_STORE_IDS.length,
            totalOrders,
            updatedOrders,
            skippedOrders,
        });
    }
);