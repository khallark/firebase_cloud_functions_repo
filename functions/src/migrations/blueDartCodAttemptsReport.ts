import { onRequest } from "firebase-functions/https";
import { db } from "../firebaseAdmin";
import { SHARED_STORE_IDS } from "../config";
import { Timestamp } from "firebase-admin/firestore";

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

// ── Blue Dart credentials ────────────────────────────────────────────────────
const BD_APP_API_KEY = "S4Eg4rFTGy2oFMbfWr9tCt3eAGUqtqcq";
const BD_APP_API_SECRET = "SPaTvNmw3DhpgIXE";
const BD_LOGIN_ID = "LDH91828";
const BD_TRACKING_LICENCE_KEY = "ilukhmnlfq1fesxtuuueponhhukgvkfh";
const BD_BATCH_SIZE = 25;

// ── Delhivery credentials ────────────────────────────────────────────────────
const DLV_API_TOKEN = "82ab664d80d7401007279538fac0e67ad096453b"; // tracking API needs `Authorization: Token …`
const DLV_BATCH_SIZE = 50; // Delhivery accepts up to 50 comma-separated AWBs

// ── Date windows (per report) ────────────────────────────────────────────────
// dispatchedAt is a Firestore Timestamp, so we query with Timestamp bounds.
const BD1_FROM = "2026-06-07T00:00:00+05:30";
const BD1_TO = "2026-06-10T00:00:00+05:30"; // exclusive → through end of June 9
const DLV_FROM = "2026-06-10T00:00:00+05:30";
const DLV_TO = "2026-06-13T00:00:00+05:30"; // exclusive → through end of June 12
const BD2_FROM = "2026-06-13T00:00:00+05:30";
const BD2_TO = "2026-06-16T00:00:00+05:30"; // exclusive → through end of June 15

// Blue Dart scan codes
const BD_DELIVERED_SCAN_CODE = "000";
const BD_OUT_FOR_DELIVERY_CODE = "002";

interface OrderDoc {
    id: string;
    storeId: string;
    awb?: string;
    [key: string]: any;
}

// Normalized outcome both couriers resolve to.
interface ShipmentOutcome {
    delivered: boolean;
    attempts: number; // # of out-for-delivery events
    scans: any;
}

// ── Blue Dart: fetch a batch → outcome map ───────────────────────────────────
async function fetchBlueDartBatch(
    awbs: string[],
    jwtToken: string
): Promise<Map<string, ShipmentOutcome>> {
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
        headers: { JWTToken: jwtToken, Accept: "application/json" },
    });

    const data = (await response.json()) as any;
    const result = new Map<string, ShipmentOutcome>();

    // BD returns ShipmentData.Shipment as array (multi) or object (single).
    const raw = data?.ShipmentData?.Shipment;
    const entries: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

    for (const shipment of entries) {
        if (!shipment) continue;
        const awb = String(shipment.WaybillNo ?? "").trim();
        if (!awb) continue;

        const scans: any[] = Array.isArray(shipment.Scans) ? shipment.Scans : [];
        const delivered = scans.some(
            (s) => s?.ScanDetail?.ScanCode === BD_DELIVERED_SCAN_CODE
        );
        const attempts = scans.filter(
            (s) => s?.ScanDetail?.ScanCode === BD_OUT_FOR_DELIVERY_CODE
        ).length;

        result.set(awb, { delivered, attempts, scans });
    }

    return result;
}

// ── Delhivery: fetch a batch → outcome map ───────────────────────────────────
function countDelhiveryOutForDelivery(scans: any[]): number {
    if (!Array.isArray(scans)) return 0;
    // Scans are ascending (oldest→newest); order is irrelevant since we count.
    return scans.filter(
        (s) => s?.ScanDetail?.Instructions === "Out for delivery"
    ).length;
}

async function fetchDelhiveryBatch(
    awbs: string[],
    token: string
): Promise<Map<string, ShipmentOutcome>> {
    const waybills = awbs.join(",");
    const url =
        `https://track.delhivery.com/api/v1/packages/json/` +
        `?waybill=${encodeURIComponent(waybills)}`;

    const response = await fetch(url, {
        method: "GET",
        headers: {
            Authorization: `Token ${token}`,
            Accept: "application/json",
        },
    });

    const data = (await response.json()) as any;
    const result = new Map<string, ShipmentOutcome>();

    const entries: any[] = Array.isArray(data?.ShipmentData) ? data.ShipmentData : [];

    for (const entry of entries) {
        const shipment = entry?.Shipment;
        if (!shipment) continue;

        const awb = String(shipment.AWB ?? "").trim();
        if (!awb) continue;

        const delivered = shipment?.Status?.Status === "Delivered";

        // Attempts = # of out-for-delivery scans (parallels Blue Dart's 002).
        const ofdCount = countDelhiveryOutForDelivery(shipment.Scans);

        // DispatchCount is Delhivery's own attempt tally — cross-check, warn on drift.
        const dispatchCount =
            typeof shipment.DispatchCount === "number" ? shipment.DispatchCount : null;
        if (dispatchCount !== null && dispatchCount !== ofdCount) {
            console.warn(
                `DLV ${awb}: DispatchCount=${dispatchCount} but OFD scans=${ofdCount}`
            );
        }

        result.set(awb, { delivered, attempts: ofdCount, scans: shipment.Scans });
    }

    return result;
}

// ── Build one report for a courier over a [from, to) window ──────────────────
async function buildReport(
    storeIds: string[],
    courier: string,
    from: Timestamp,
    to: Timestamp,
    fetchBatch: (awbs: string[], token: string) => Promise<Map<string, ShipmentOutcome>>,
    batchSize: number,
    token: string
) {
    // 1. ALL orders of this courier in the window.
    const snapshots = await Promise.all(
        storeIds.map(async (storeId) => {
            const snap = await db
                .collection(`accounts/${storeId}/orders`)
                .where("courier", "==", courier)
                .where("dispatchedAt", ">=", from)
                .where("dispatchedAt", "<", to)
                .get();
            return { storeId, snap };
        })
    );

    const allOrders: OrderDoc[] = snapshots.flatMap(({ storeId, snap }) =>
        snap.docs.map((doc) => ({
            id: doc.id,
            storeId,
            ...(doc.data() as Record<string, any>),
        } as OrderDoc))
    );

    const prepaidCount = allOrders.filter((o) => o.paymentStatus === "Prepaid").length;
    const codOrders = allOrders.filter((o) => o.paymentStatus !== "Prepaid");

    console.log(
        `[${courier}] total: ${allOrders.length}, prepaid: ${prepaidCount}, COD: ${codOrders.length}`
    );

    // 2. Fetch tracking for COD orders in batches.
    const outcomeMap = new Map<string, ShipmentOutcome>();
    const trackable = codOrders.filter((o) => o.awb);

    for (let i = 0; i < trackable.length; i += batchSize) {
        const batch = trackable.slice(i, i + batchSize).map((o) => o.awb as string);
        try {
            const batchMap = await fetchBatch(batch, token);
            for (const [awb, outcome] of batchMap) outcomeMap.set(awb, outcome);
        } catch (err) {
            console.error(`[${courier}] tracking batch ${i}–${i + batchSize} failed:`, err);
            // Leave absent → those orders surface under noTracking.
        }
    }

    // 3. Classify COD orders by attempt count, then by delivery.
    let zeroAttemptCount = 0;
    let nonZeroAttemptCount = 0;
    let deliveredCount = 0; // non-0 attempted AND delivered
    let restCount = 0;      // non-0 attempted AND not delivered
    let noTrackingCount = 0; // no AWB, or fetch failed / AWB not in response

    const deliveredAttemptBuckets: Record<string, number> = {};
    const zeroAttemptOrders: any[] = [];

    for (const order of codOrders) {
        const outcome = order.awb ? outcomeMap.get(order.awb) : undefined;

        if (!outcome) {
            noTrackingCount++;
            continue;
        }

        if (outcome.attempts === 0) {
            zeroAttemptCount++;
            zeroAttemptOrders.push({
                awb: order.awb,
                status: order.customStatus,
                delivered: outcome.delivered,
                scans: outcome.scans,
            });
            continue;
        }

        // attempts > 0
        nonZeroAttemptCount++;
        if (outcome.delivered) {
            deliveredCount++;
            const key = String(outcome.attempts);
            deliveredAttemptBuckets[key] = (deliveredAttemptBuckets[key] || 0) + 1;
        } else {
            restCount++;
        }
    }

    const deliveredAttemptsSplit = Object.fromEntries(
        Object.entries(deliveredAttemptBuckets).sort(([a], [b]) => Number(a) - Number(b))
    );

    return {
        courier,
        dateRange: { from: from.toDate().toISOString(), to: to.toDate().toISOString() },
        totalOrders: allOrders.length,
        prepaidCount,
        cod: {
            total: codOrders.length,
            zeroAttempted: {
                count: zeroAttemptCount,
                // orders: zeroAttemptOrders,
            },
            nonZeroAttempted: {
                count: nonZeroAttemptCount,
                delivered: {
                    count: deliveredCount,
                    attemptsSplit: deliveredAttemptsSplit,
                },
                rest: {
                    count: restCount,
                },
            },
            noTracking: {
                count: noTrackingCount,
            },
        },
    };
}

export const blueDartCodAttemptsReport = onRequest(
    { cors: true, timeoutSeconds: 3600, memory: "4GiB" },
    async (req, res) => {
        try {
            const storeIds = SHARED_STORE_IDS;

            // One Blue Dart JWT serves both BD reports.
            const jwtToken = await getBlueDartToken(BD_APP_API_KEY, BD_APP_API_SECRET);

            // Report 1 — Blue Dart, 7–9 June
            const report1 = await buildReport(
                storeIds,
                "Blue Dart",
                Timestamp.fromDate(new Date(BD1_FROM)),
                Timestamp.fromDate(new Date(BD1_TO)),
                fetchBlueDartBatch,
                BD_BATCH_SIZE,
                jwtToken
            );

            // Report 2 — Delhivery, 10–12 June
            const report2 = await buildReport(
                storeIds,
                "Delhivery",
                Timestamp.fromDate(new Date(DLV_FROM)),
                Timestamp.fromDate(new Date(DLV_TO)),
                fetchDelhiveryBatch,
                DLV_BATCH_SIZE,
                DLV_API_TOKEN
            );

            // Report 3 — Blue Dart, 13–15 June
            const report3 = await buildReport(
                storeIds,
                "Blue Dart",
                Timestamp.fromDate(new Date(BD2_FROM)),
                Timestamp.fromDate(new Date(BD2_TO)),
                fetchBlueDartBatch,
                BD_BATCH_SIZE,
                jwtToken
            );

            res.status(200).json({ report1, report2, report3 });
        } catch (err) {
            console.error("blueDartCodAttemptsReport:", err);
            res.status(500).json({ error: String(err) });
        }
    }
);