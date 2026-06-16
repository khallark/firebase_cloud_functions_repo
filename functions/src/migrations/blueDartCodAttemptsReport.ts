// import { onRequest } from "firebase-functions/https";
// import { db } from "../firebaseAdmin";
// import { SHARED_STORE_IDS } from "../config";

// export async function getBlueDartToken(appApiKey: string, appApiSecret: string): Promise<string> {
//     try {
//         const response = await fetch(
//             "https://apigateway.bluedart.com/in/transportation/token/v1/login",
//             {
//                 method: "GET",
//                 headers: {
//                     ClientID: appApiKey,
//                     clientSecret: appApiSecret,
//                     Accept: "application/json",
//                 },
//             },
//         );

//         const data = (await response.json()) as any;

//         if (!response.ok) {
//             // Extract messages from Blue Dart's error-response array
//             const errorMsgs = Array.isArray(data?.["error-response"])
//                 ? data["error-response"].map((e: any) => e.msg).join(", ")
//                 : data?.title || "Authentication failed";
//             throw new Error(`BLUEDART_AUTH_FAILED ${errorMsgs}`);
//         }

//         if (!data.JWTToken) {
//             throw new Error("BLUEDART_AUTH_TOKEN_MISSING");
//         }

//         return data.JWTToken;
//     } catch (error: any) {
//         // Re-throw errors we already structured
//         if (error.message?.startsWith("BLUEDART_AUTH")) {
//             throw error;
//         }
//         // Anything else is a network / parse failure — retryable
//         throw new Error(`BLUEDART_AUTH_NETWORK_ERROR ${error.message}`);
//     }
// }

// // ── Blue Dart credentials (fill in) ─────────────────────────────────────────
// const BD_APP_API_KEY = "S4Eg4rFTGy2oFMbfWr9tCt3eAGUqtqcq";
// const BD_APP_API_SECRET = "SPaTvNmw3DhpgIXE";
// const BD_LOGIN_ID = "LDH91828";
// const BD_TRACKING_LICENCE_KEY = "ilukhmnlfq1fesxtuuueponhhukgvkfh";
// // ────────────────────────────────────────────────────────────────────────────

// const DELIVERY_ATTEMPT_SCAN_CODES = new Set([
//     "000", // Delivered
//     "005", // Office closed / unable to deliver
//     "006", // Consignee not available
//     "007", // Delivery refused
//     "008", // Incomplete address
// ]);

// const BD_BATCH_SIZE = 25;

// interface OrderDoc {
//     id: string;
//     storeId: string;
//     awb?: string;
//     [key: string]: any;
// }

// interface OrderWithAttempts extends OrderDoc {
//     attempts: number; // -1 = AWB missing or tracking call failed
// }

// async function fetchBlueDartScansBatch(
//     awbs: string[],
//     jwtToken: string
// ): Promise<Map<string, any[]>> {
//     const waybills = awbs.join(",");
//     const trackingUrl =
//         `https://apigateway.bluedart.com/in/transportation/tracking/v1/shipment` +
//         `?handler=tnt` +
//         `&numbers=${encodeURIComponent(waybills)}` +
//         `&format=json` +
//         `&scan=1` +
//         `&verno=1` +
//         `&awb=awb` +
//         `&loginid=${encodeURIComponent(BD_LOGIN_ID)}` +
//         `&lickey=${encodeURIComponent(BD_TRACKING_LICENCE_KEY)}`;

//     const response = await fetch(trackingUrl, {
//         method: "GET",
//         headers: {
//             JWTToken: jwtToken,
//             Accept: "application/json",
//         },
//     });

//     const data = (await response.json()) as any;
//     const result = new Map<string, any[]>();

//     // BD returns ShipmentData[] for multi-AWB; handle both array and single-object
//     const raw = data?.ShipmentData?.Shipment;
//     const shipmentEntries: any[] = Array.isArray(raw)
//         ? raw
//         : raw
//             ? [raw]
//             : [];

//     for (const entry of shipmentEntries) {
//         const shipment = entry;
//         if (!shipment) continue;
//         const awb = String(shipment.WaybillNo ?? "").trim();
//         const scans: any[] = Array.isArray(shipment.Scans) ? shipment.Scans : [];
//         if (awb) result.set(awb, scans);
//     }

//     return result;
// }

// function countDeliveryAttempts(scans: any[]): number {
//     return scans.filter((s) =>
//         DELIVERY_ATTEMPT_SCAN_CODES.has(s?.ScanDetail?.ScanCode)
//     ).length;
// }

// export const blueDartCodAttemptsReport = onRequest(
//     { cors: true, timeoutSeconds: 3600, memory: "4GiB" },
//     async (req, res) => {
//         try {
//             const storeIds = SHARED_STORE_IDS;

//             // 1. Fetch matching orders across all shared stores
//             const snapshots = await Promise.all(
//                 storeIds.map(async (storeId) => {
//                     const snap = await db
//                         .collection(`accounts/${storeId}/orders`)
//                         .where("courier", "==", "Blue Dart")
//                         .where("customStatus", "in", ["Delivered", "Closed", "DTO Delivered", "Pending Refunds", "DTO Refunded"])
//                         .get();
//                     return { storeId, snap };
//                 })
//             );
//             const num = snapshots.reduce((sum, item) => sum + item.snap.docs.length, 0);

//             console.log(`${num}, ${snapshots.length}`);

//             const rawOrders: OrderDoc[] = snapshots.flatMap(({ storeId, snap }) =>
//                 snap.docs.map((doc) => ({
//                     id: doc.id,
//                     storeId,
//                     ...(doc.data() as Record<string, any>),
//                 } as any)).filter(order => !(["Delivered", "Closed"].includes(order?.customStatus) && order?.totalOutstanding === 0))
//             );

//             // 2. Obtain a single JWT for the entire run
//             const jwtToken = await getBlueDartToken(BD_APP_API_KEY, BD_APP_API_SECRET);

//             // 4. Sequential batches of 25 AWBs — BD API limit
//             const masterScanMap = new Map<string, any[]>();

//             for (let i = 0; i < rawOrders.length; i += BD_BATCH_SIZE) {
//                 const batch = rawOrders
//                     .slice(i, i + BD_BATCH_SIZE)
//                     .map((o) => o.awb as string);

//                 let batchMap: Map<string, any[]>;
//                 try {
//                     batchMap = await fetchBlueDartScansBatch(batch, jwtToken);
//                 } catch (err) {
//                     console.error(`BD tracking batch ${i}–${i + BD_BATCH_SIZE} failed:`, err);
//                     // Leave these AWBs absent from the map → they'll surface as attempts: -1
//                     continue;
//                 }

//                 for (const [awb, scans] of batchMap) {
//                     masterScanMap.set(awb, scans);
//                 }
//             }

//             // 5. Resolve attempt counts for every order
//             const ordersWithAttempts: OrderWithAttempts[] = [
//                 ...rawOrders.map((order) => {
//                     const scans = masterScanMap.get(order.awb as string);
//                     return {
//                         ...order,
//                         attempts: scans !== undefined ? countDeliveryAttempts(scans) : -1,
//                     };
//                 }),
//             ];

//             // 6. Form[0] — overall totals
//             const form0 = {
//                 totalCount: ordersWithAttempts.length,
//             };

//             // 7. Form[1] — bucketed by attempt number (1, 2, 3 …; -1 → "unknown")
//             const buckets: Record<
//                 string,
//                 { count: number; }
//             > = {};

//             for (const order of ordersWithAttempts) {
//                 const key =
//                     order.attempts === -1 ? "unknown" : String(order.attempts);
//                 if (!buckets[key]) buckets[key] = { count: 0 };
//                 buckets[key].count++;
//             }

//             const form1 = Object.fromEntries(
//                 Object.entries(buckets).sort(([a], [b]) => {
//                     if (a === "unknown") return 1;
//                     if (b === "unknown") return -1;
//                     return Number(a) - Number(b);
//                 })
//             );

//             res.status(200).json({ totalCODCount: form0.totalCount, attemptsSplit: form1 });
//         } catch (err) {
//             console.error("blueDartCodAttemptsReport:", err);
//             res.status(500).json({ error: String(err) });
//         }
//     }
// );

import { onRequest } from "firebase-functions/https";
import { db } from "../firebaseAdmin";
import { SHARED_STORE_IDS } from "../config";

export async function getBlueDartToken(appApiKey: string, appApiSecret: string): Promise<string> {
    try {
        const response = await fetch(
            "https://apigateway.bluedart.com/in/transportation/token/v1/login",
            {
                method: "GET",
                headers: {
                    ClientID: appApiKey,
                    clientSecret: appApiSecret,
                    Accept: "application/json",
                },
            },
        );

        const data = (await response.json()) as any;

        if (!response.ok) {
            // Extract messages from Blue Dart's error-response array
            const errorMsgs = Array.isArray(data?.["error-response"])
                ? data["error-response"].map((e: any) => e.msg).join(", ")
                : data?.title || "Authentication failed";
            throw new Error(`BLUEDART_AUTH_FAILED ${errorMsgs}`);
        }

        if (!data.JWTToken) {
            throw new Error("BLUEDART_AUTH_TOKEN_MISSING");
        }

        return data.JWTToken;
    } catch (error: any) {
        // Re-throw errors we already structured
        if (error.message?.startsWith("BLUEDART_AUTH")) {
            throw error;
        }
        // Anything else is a network / parse failure — retryable
        throw new Error(`BLUEDART_AUTH_NETWORK_ERROR ${error.message}`);
    }
}

// ── Blue Dart credentials (fill in) ─────────────────────────────────────────
const BD_APP_API_KEY = "S4Eg4rFTGy2oFMbfWr9tCt3eAGUqtqcq";
const BD_APP_API_SECRET = "SPaTvNmw3DhpgIXE";
const BD_LOGIN_ID = "LDH91828";
const BD_TRACKING_LICENCE_KEY = "ilukhmnlfq1fesxtuuueponhhukgvkfh";

const BD_BATCH_SIZE = 25;

interface OrderDoc {
    id: string;
    storeId: string;
    awb?: string;
    [key: string]: any;
}

// interface OrderWithAttempts extends OrderDoc {
//     attempts: number; // -1 = AWB missing or tracking call failed
// }

async function fetchBlueDartScansBatch(
    awbs: string[],
    jwtToken: string
): Promise<Map<string, any[]>> {
    const waybills = awbs.join(",");
    const trackingUrl =
        `https://apigateway.bluedart.com/in/transportation/tracking/v1/shipment` +
        `?handler=tnt` +
        `&numbers=${encodeURIComponent(waybills)}` +
        `&format=json` +
        `&scan=1` +
        `&verno=1` +
        `&awb=awb` +
        `&loginid=${encodeURIComponent(BD_LOGIN_ID)}` +
        `&lickey=${encodeURIComponent(BD_TRACKING_LICENCE_KEY)}`;

    const response = await fetch(trackingUrl, {
        method: "GET",
        headers: {
            JWTToken: jwtToken,
            Accept: "application/json",
        },
    });

    const data = (await response.json()) as any;
    const result = new Map<string, any[]>();

    // BD returns ShipmentData[] for multi-AWB; handle both array and single-object
    const raw = data?.ShipmentData?.Shipment;
    const shipmentEntries: any[] = Array.isArray(raw)
        ? raw
        : raw
            ? [raw]
            : [];

    for (const entry of shipmentEntries) {
        const shipment = entry;
        if (!shipment) continue;
        const awb = String(shipment.WaybillNo ?? "").trim();
        const scans: any[] = Array.isArray(shipment.Scans) ? shipment.Scans : [];
        if (awb) result.set(awb, scans);
    }

    return result;
}

// ── Report window (May 3–10, IST inclusive) ─────────────────────────────────
const REPORT_FROM = "2026-06-03T00:00:00+05:30";
const REPORT_TO = "2026-06-11T00:00:00+05:30"; // exclusive → captures all of May 10
// ────────────────────────────────────────────────────────────────────────────

const DELIVERED_SCAN_CODE = "000";
const OUT_FOR_DELIVERY_CODE = "002";

function countDeliveryAttempts(scans: any[]): number {
    return scans.filter((s) => s?.ScanDetail?.ScanCode === OUT_FOR_DELIVERY_CODE).length;
}

function isDelivered(scans: any[]): boolean {
    return scans.some((s) => s?.ScanDetail?.ScanCode === DELIVERED_SCAN_CODE);
}

export const blueDartCodAttemptsReport = onRequest(
    { cors: true, timeoutSeconds: 3600, memory: "4GiB" },
    async (req, res) => {
        try {
            const storeIds = SHARED_STORE_IDS;

            // 1. Blue Dart orders in the window, across shared stores.
            //    paymentStatus filtered in memory → no new composite index needed.
            const snapshots = await Promise.all(
                storeIds.map(async (storeId) => {
                    const snap = await db
                        .collection(`accounts/${storeId}/orders`)
                        .where("courier", "==", "Blue Dart")
                        .where("createdAt", ">=", REPORT_FROM)
                        .where("createdAt", "<", REPORT_TO)
                        .get();
                    return { storeId, snap };
                })
            );

            const codOrders: OrderDoc[] = snapshots.flatMap(({ storeId, snap }) =>
                snap.docs
                    .map((doc) => ({
                        id: doc.id,
                        storeId,
                        ...(doc.data() as Record<string, any>),
                    } as OrderDoc))
                    .filter((order) => order.paymentStatus === "COD")
            );

            console.log("Blue Dart COD count:", codOrders.length);

            // 2. One JWT for the whole run.
            const jwtToken = await getBlueDartToken(BD_APP_API_KEY, BD_APP_API_SECRET);

            // 3. Fetch scans in batches of 25 (BD limit). Missing-AWB orders skipped.
            const masterScanMap = new Map<string, any[]>();
            const trackable = codOrders.filter((o) => o.awb);

            for (let i = 0; i < trackable.length; i += BD_BATCH_SIZE) {
                const batch = trackable
                    .slice(i, i + BD_BATCH_SIZE)
                    .map((o) => o.awb as string);

                try {
                    const batchMap = await fetchBlueDartScansBatch(batch, jwtToken);
                    for (const [awb, scans] of batchMap) {
                        masterScanMap.set(awb, scans);
                    }
                } catch (err) {
                    console.error(`BD tracking batch ${i}–${i + BD_BATCH_SIZE} failed:`, err);
                    // Leave absent → these orders surface as "unknown".
                }
            }

            // 4. Classify every COD order; for delivered ones, count attempts.
            let deliveredCount = 0;
            let notDeliveredCount = 0;
            let unknownCount = 0; // scans unavailable (missing AWB or fetch failed)

            const unknownOrders: { name: string; awb: string; storeId: string }[] = []; // ← add

            const attemptBuckets: Record<string, number> = {};
            const undeliveredAttemptBuckets: Record<string, number> = {}; // ← add

            const zeroAttemptUndelivered: {                       // ← add
                name: string;
                awb: string;
                createdAt: string,
                dispatchedAt: string,
                latestStatus: string;
                latestScanCode: string;
                latestScanDate: string;
            }[] = [];

            for (const order of codOrders) {
                const scans = order.awb ? masterScanMap.get(order.awb) : undefined;

                if (scans === undefined) {
                    unknownCount++;
                    unknownOrders.push({                 // ← add
                        name: order.name ?? "(no name)",
                        awb: order.awb ?? "(none)",
                        storeId: order.storeId,
                    });
                    continue;
                }
                if (!isDelivered(scans)) {
                    notDeliveredCount++;
                    const attempts = countDeliveryAttempts(scans);
                    const key = String(attempts);
                    undeliveredAttemptBuckets[key] = (undeliveredAttemptBuckets[key] || 0) + 1;

                    if (attempts === 0) {                              // ← add block
                        const latest = scans[0]?.ScanDetail; // assumes oldest→newest
                        zeroAttemptUndelivered.push({
                            name: order.name ?? "(no name)",
                            awb: order.awb ?? "(none)",
                            createdAt: order.createdAt,
                            dispatchedAt: order.dispatchedAt?.toDate()
                                ? (() => {
                                    const ist = new Date(order.dispatchedAt.toDate().getTime() + 5.5 * 60 * 60 * 1000);
                                    return ist.toISOString().replace("Z", "+05:30");
                                })()
                                : "NaN",
                            latestStatus: latest?.Scan ?? "(no scans)",
                            latestScanCode: latest?.ScanCode ?? "(none)",
                            latestScanDate: latest?.ScanDate ?? "",
                        });
                    }
                    continue;
                }

                deliveredCount++;
                const attempts = countDeliveryAttempts(scans); // includes the successful 000
                const key = String(attempts);
                attemptBuckets[key] = (attemptBuckets[key] || 0) + 1;
            }

            // 5. Sort attempts split numerically (1, 2, 3 …).
            const attemptsSplit = Object.fromEntries(
                Object.entries(attemptBuckets).sort(([a], [b]) => Number(a) - Number(b))
            );
            const undeliveredAttemptsSplit = Object.fromEntries(                 // ← add
                Object.entries(undeliveredAttemptBuckets).sort(([a], [b]) => Number(a) - Number(b))
            );

            res.status(200).json({
                dateRange: { from: REPORT_FROM, to: REPORT_TO },
                totalCodCount: codOrders.length,
                deliveredCount,
                notDeliveredCount,
                unknownCount,
                unknownOrders,
                attemptsSplit,
                undeliveredAttemptsSplit,
                zeroAttemptUndelivered,   // ← add
            });
        } catch (err) {
            console.error("blueDartCodAttemptsReport:", err);
            res.status(500).json({ error: String(err) });
        }
    }
);