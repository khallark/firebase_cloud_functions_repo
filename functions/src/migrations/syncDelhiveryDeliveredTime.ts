// functions/src/syncDelhiveryDeliveredTime.ts
import { onRequest } from "firebase-functions/v2/https";
import { DocumentReference, Timestamp } from "firebase-admin/firestore";
import { SHARED_STORE_IDS } from "../config";
import { db } from "../firebaseAdmin";

const DELHIVERY_TOKEN = "f880d4be94da9190fc3aafca172924f3ca4d8f43";
const COURIER = "Delhivery";
const BATCH_SIZE = 50;

// Only process orders marked Delivered by our system on/after Jan 25 2026 IST
const DELIVERED_LOG_CUTOFF = Timestamp.fromDate(new Date("2026-01-25T00:00:00+05:30"));

/**
 * Parses Delhivery's ScanDateTime ("2026-02-24T16:17:50.002") as IST.
 * The string has no timezone suffix — treat it as IST by appending +05:30.
 */
function parseDelhiveryScanDateTime(scanDateTime: string): Date | null {
  try {
    // Strip any existing fractional seconds beyond ms, then force IST
    const normalized = scanDateTime.replace(/(\.\d{3})\d*$/, "$1");
    const dt = new Date(`${normalized}+05:30`);
    if (isNaN(dt.getTime())) return null;
    return dt;
  } catch {
    return null;
  }
}

export const syncDelhiveryDeliveredTime = onRequest(
  { cors: true, memory: "1GiB", timeoutSeconds: 3600 },
  async (req, res) => {
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;

    // ── 1. Fetch all Delhivery Delivered/Closed orders across stores ─────────
    const allOrders: any[] = [];
    const seenIds = new Set<string>();

    await Promise.all(
      SHARED_STORE_IDS.map(async (storeId) => {
        const snap = await db
          .collection("accounts")
          .doc(storeId)
          .collection("orders")
          .where("courierProvider", "==", COURIER)
          .where("customStatus", "in", [
            "Delivered",
            "Closed",
            "DTO Requested",
            "DTO Booked",
            "DTO In Transit",
            "DTO Delivered",
            "Pending Refunds",
            "DTO Refunded",
          ])
          .get();

        snap.forEach((doc) => {
          if (seenIds.has(doc.id)) return;
          seenIds.add(doc.id);
          allOrders.push({ id: doc.id, ref: doc.ref, ...doc.data() });
        });
      }),
    );

    console.log(`📦 Total Delhivery orders: ${allOrders.length}`);

    // ── 2. Filter: must have a Delivered log entry createdAt >= Jan 25 2026 ──
    const eligibleOrders = allOrders.filter((order) => {
      const logs: any[] = order.customStatusesLogs || [];
      return logs.some(
        (log) =>
          log.status === "Delivered" &&
          log.createdAt instanceof Timestamp &&
          log.createdAt.seconds >= DELIVERED_LOG_CUTOFF.seconds,
      );
    });

    console.log(`✅ Eligible orders (Delivered after Jan 25 2026): ${eligibleOrders.length}`);

    // ── 3. Batch AWBs and call Delhivery tracking API ────────────────────────
    const ordersWithAwb = eligibleOrders.filter((o) => o.awb);
    const batches: any[][] = [];
    for (let i = 0; i < ordersWithAwb.length; i += BATCH_SIZE) {
      batches.push(ordersWithAwb.slice(i, i + BATCH_SIZE));
    }

    // Map AWB → order for O(1) lookup
    const ordersByAwb = new Map<string, any>();
    for (const order of ordersWithAwb) {
      ordersByAwb.set(String(order.awb), order);
    }

    const skipReasons: Record<string, string[]> = {
      no_awb: [],
      api_error: [],
      no_scans: [],
      no_dl_scan: [],
      scan_date_parse_error: [],
    };

    const updates: { ref: DocumentReference; delhiverydeliveredtime: Timestamp }[] = [];

    await Promise.all(
      batches.map(async (batch) => {
        const waybills = batch.map((o) => o.awb).join(",");

        let responseData: any;
        try {
          const response = await fetch(
            `https://track.delhivery.com/api/v1/packages/json/?waybill=${waybills}`,
            {
              headers: {
                Authorization: `Token ${DELHIVERY_TOKEN}`,
                Accept: "application/json",
              },
            },
          );
          responseData = await response.json();
        } catch (err: any) {
          console.error(`❌ Delhivery API error for batch [${waybills}]:`, err.message);
          batch.forEach((o) => skipReasons.api_error.push(o.awb));
          return;
        }

        // ShipmentData can be a single object or an array
        const raw = responseData?.ShipmentData;
        const shipments: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

        for (const item of shipments) {
          const shipment = item?.Shipment;
          if (!shipment) continue;

          const awb = String(shipment.AWB || "");
          const order = ordersByAwb.get(awb);
          if (!order) continue;

          const scans: any[] = Array.isArray(shipment.Scans) ? shipment.Scans : [];
          const dlScans = scans
            .map((s: any) => s?.ScanDetail)
            .filter((s: any) => s?.ScanType === "DL" && s?.ScanDateTime);

          if (scans.length === 0) {
            skipReasons.no_scans.push(awb);
            continue;
          }
          if (dlScans.length === 0) {
            skipReasons.no_dl_scan.push(awb);
            continue;
          }

          // Pick the latest DL scan
          let latestTimestamp: Timestamp | null = null;
          for (const scan of dlScans) {
            const parsed = parseDelhiveryScanDateTime(scan.ScanDateTime);
            if (!parsed) {
              skipReasons.scan_date_parse_error.push(awb);
              continue;
            }
            if (!latestTimestamp || parsed.getTime() > latestTimestamp.toMillis()) {
              latestTimestamp = Timestamp.fromDate(parsed);
            }
          }

          if (!latestTimestamp) continue;

          updates.push({ ref: order.ref, delhiverydeliveredtime: latestTimestamp });
        }
      }),
    );

    for (const order of ordersWithAwb) {
      const awb = String(order.awb);
      if (
        !updates.find((u) => u.ref.id === order.ref.id) &&
        !skipReasons.api_error.includes(awb) &&
        !skipReasons.no_scans.includes(awb) &&
        !skipReasons.no_dl_scan.includes(awb) &&
        !skipReasons.scan_date_parse_error.includes(awb)
      ) {
        skipReasons.api_not_found = skipReasons.api_not_found ?? [];
        skipReasons.api_not_found.push(awb);
      }
    }

    // Track orders with no AWB separately
    eligibleOrders.filter((o) => !o.awb).forEach((o) => skipReasons.no_awb.push(o.id));

    console.log(`📝 Updates to apply: ${updates.length}`);
    console.log(
      `⏭️ Skipped:`,
      Object.fromEntries(Object.entries(skipReasons).map(([k, v]) => [k, v.length])),
    );

    // ── 4. Write to Firestore in 499-op chunks ───────────────────────────────
    if (!dryRun) {
      const CHUNK_SIZE = 499;
      for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
        const chunk = updates.slice(i, i + CHUNK_SIZE);
        const batch = db.batch();
        for (const update of chunk) {
          batch.update(update.ref, {
            delhiverydeliveredtime: update.delhiverydeliveredtime,
          });
        }
        await batch.commit();
        console.log(`💾 Committed batch ${Math.floor(i / CHUNK_SIZE) + 1}`);
      }
    }

    res.status(200).json({
      success: true,
      dryRun,
      updatedCount: updates.length,
      skipped: Object.fromEntries(Object.entries(skipReasons).map(([k, v]) => [k, v.length])),
      skippedDetails: dryRun ? skipReasons : undefined,
    });
  },
);
