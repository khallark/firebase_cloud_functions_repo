import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { SHARED_STORE_ID, SHARED_STORE_ID_2 } from "../config";
import {
  DocumentReference,
  QueryDocumentSnapshot,
  Timestamp,
  WriteBatch,
} from "firebase-admin/firestore";

const STORE_IDS = [SHARED_STORE_ID, SHARED_STORE_ID_2];
const BD_BATCH_SIZE = 50;

const BD_LOGIN_URL = "https://apigateway.bluedart.com/in/transportation/token/v1/login";
const BD_TRACKING_URL = "https://apigateway.bluedart.com/in/transportation/tracking/v1/shipment";
const BD_CLIENT_ID = "S4Eg4rFTGy2oFMbfWr9tCt3eAGUqtqcq";
const BD_CLIENT_SECRET = "SPaTvNmw3DhpgIXE";
const BD_LOGIN_ID = "LDH91828";
const BD_LIC_KEY = "ilukhmnlfq1fesxtuuueponhhukgvkfh";

type SkipReason =
  | "no_awb"
  | "api_not_found"
  | "no_scans"
  | "no_dl_scan"
  | "scan_date_parse_error"
  | "api_error";

interface SkippedOrder {
  orderId: string;
  orderName: string;
  storeId: string;
  awb?: string;
  reason: SkipReason;
  detail?: string;
}

interface ScanDetail {
  ScanType: string;
  ScanDate: string;
  ScanTime: string;
  Scan: string;
  ScannedLocation: string;
  [key: string]: unknown;
}

interface Shipment {
  WaybillNo: string;
  StatusType: string;
  Scans: { ScanDetail: ScanDetail }[];
  [key: string]: unknown;
}

const getBlueDartToken = async (): Promise<string> => {
  const response = await fetch(BD_LOGIN_URL, {
    headers: {
      ClientID: BD_CLIENT_ID,
      clientSecret: BD_CLIENT_SECRET,
    },
  });
  const data = (await response.json()) as any;
  const token = data?.JWTToken ?? data?.jwtToken;
  if (!token) throw new Error("No JWT token in Blue Dart login response");
  return token;
};

const trackBatch = async (awbs: string[], jwtToken: string): Promise<Shipment[]> => {
  const params = new URLSearchParams({
    handler: "tnt",
    numbers: `{${awbs.join(",")}}`,
    format: "json",
    scan: "1",
    verno: "1",
    awb: "awb",
    loginid: BD_LOGIN_ID,
    lickey: BD_LIC_KEY,
  });
  const response = await fetch(`${BD_TRACKING_URL}?${params.toString()}`, {
    headers: { JWTToken: jwtToken },
  });
  const data = (await response.json()) as any;
  return data?.ShipmentData?.Shipment ?? [];
};

const parseScanDateTime = (date: string, time: string): Date | null => {
  try {
    const [day, month, year] = date.split("-");
    const monthMap: Record<string, string> = {
      Jan: "01",
      Feb: "02",
      Mar: "03",
      Apr: "04",
      May: "05",
      Jun: "06",
      Jul: "07",
      Aug: "08",
      Sep: "09",
      Oct: "10",
      Nov: "11",
      Dec: "12",
    };
    const isoString = `${year}-${monthMap[month]}-${day}T${time}:00+05:30`;
    const dt = new Date(isoString);
    if (isNaN(dt.getTime())) return null;
    return dt;
  } catch {
    return null;
  }
};

export const syncBlueDartDeliveredTime = onRequest(
  {
    cors: true,
    timeoutSeconds: 3600,
    memory: "1GiB",
  },
  async (req, res) => {
    try {
      const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;

      // ── 1. Fetch orders from both stores ──────────────────────────────────
      const snapshots = await Promise.all(
        STORE_IDS.map((storeId) =>
          db
            .collection(`accounts/${storeId}/orders`)
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
            .where("courier", "==", "Blue Dart")
            .get(),
        ),
      );

      // ── 2. Build a flat list of { storeId, doc } ──────────────────────────
      const allOrders: {
        storeId: string;
        doc: QueryDocumentSnapshot;
      }[] = [];

      for (let i = 0; i < STORE_IDS.length; i++) {
        for (const doc of snapshots[i].docs) {
          allOrders.push({ storeId: STORE_IDS[i], doc });
        }
      }

      // ── 3. Separate orders with/without AWBs ─────────────────────────────
      const skippedOrders: SkippedOrder[] = [];
      const ordersWithAwb: typeof allOrders = [];

      for (const entry of allOrders) {
        const awb = entry.doc.data().awb;
        if (!awb) {
          skippedOrders.push({
            orderId: entry.doc.id,
            orderName: entry.doc.data().name ?? entry.doc.id,
            storeId: entry.storeId,
            reason: "no_awb",
          });
        } else {
          ordersWithAwb.push(entry);
        }
      }

      // ── 4. Get JWT token ──────────────────────────────────────────────────
      const jwtToken = await getBlueDartToken();

      // ── 5. Build AWB → order map and batch-call Blue Dart ─────────────────
      // Multiple orders could share an AWB (rare but safe to handle)
      const awbToOrders = new Map<string, typeof ordersWithAwb>();
      for (const entry of ordersWithAwb) {
        const awb = String(entry.doc.data().awb);
        if (!awbToOrders.has(awb)) awbToOrders.set(awb, []);
        awbToOrders.get(awb)!.push(entry);
      }

      const uniqueAwbs = [...awbToOrders.keys()];
      const shipmentMap = new Map<string, Shipment>(); // awb → shipment

      // Batch into groups of 50
      const batches: string[][] = [];
      for (let i = 0; i < uniqueAwbs.length; i += BD_BATCH_SIZE) {
        batches.push(uniqueAwbs.slice(i, i + BD_BATCH_SIZE));
      }

      await Promise.all(
        batches.map(async (batch) => {
          try {
            const shipments = await trackBatch(batch, jwtToken);
            for (const shipment of shipments) {
              shipmentMap.set(String(shipment.WaybillNo), shipment);
            }
          } catch (err: any) {
            // If an entire batch fails, mark all its AWBs as api_error
            for (const awb of batch) {
              for (const entry of awbToOrders.get(awb) ?? []) {
                skippedOrders.push({
                  orderId: entry.doc.id,
                  orderName: entry.doc.data().name ?? entry.doc.id,
                  storeId: entry.storeId,
                  awb,
                  reason: "api_error",
                  detail: err.message,
                });
              }
              awbToOrders.delete(awb); // don't process these further
            }
          }
        }),
      );

      // ── 6. Process each order with its shipment data ──────────────────────
      let firestoreBatch = db.batch();
      let batchOpCount = 0;
      const firestoreBatches: WriteBatch[] = [firestoreBatch];
      let totalUpdated = 0;

      const addUpdate = (ref: DocumentReference, data: Record<string, unknown>) => {
        if (batchOpCount > 0 && batchOpCount % 499 === 0) {
          firestoreBatch = db.batch();
          firestoreBatches.push(firestoreBatch);
        }
        firestoreBatches[firestoreBatches.length - 1].update(ref, data);
        batchOpCount++;
      };

      for (const [awb, entries] of awbToOrders.entries()) {
        const shipment = shipmentMap.get(awb);

        for (const entry of entries) {
          const orderName = entry.doc.data().name ?? entry.doc.id;
          const baseSkip = {
            orderId: entry.doc.id,
            orderName,
            storeId: entry.storeId,
            awb,
          };

          // Not found in API response
          if (!shipment) {
            skippedOrders.push({ ...baseSkip, reason: "api_not_found" });
            continue;
          }

          // API explicitly says not found
          if (shipment.StatusType === "NF" || !shipment.Scans?.length) {
            skippedOrders.push({
              ...baseSkip,
              reason: shipment.StatusType === "NF" ? "api_not_found" : "no_scans",
            });
            continue;
          }

          // Filter to DL scans only
          const dlScans = shipment.Scans.map((s) => s.ScanDetail).filter(
            (s) => s.ScanType === "DL",
          );

          if (dlScans.length === 0) {
            skippedOrders.push({ ...baseSkip, reason: "no_dl_scan" });
            continue;
          }

          // Find the latest DL scan by date+time
          let latestScan: ScanDetail | null = null;
          let latestDate: Date | null = null;

          for (const scan of dlScans) {
            const dt = parseScanDateTime(scan.ScanDate, scan.ScanTime);
            if (!dt) continue;
            if (!latestDate || dt > latestDate) {
              latestDate = dt;
              latestScan = scan;
            }
          }

          if (!latestScan || !latestDate) {
            skippedOrders.push({ ...baseSkip, reason: "scan_date_parse_error" });
            continue;
          }

          const deliveredTimestamp = Timestamp.fromDate(latestDate);

          if (!dryRun) {
            addUpdate(entry.doc.ref, { bluedartdeliveredtime: deliveredTimestamp });
          }
          totalUpdated++;
        }
      }

      // ── 7. Commit Firestore batches ───────────────────────────────────────
      if (!dryRun) {
        for (const batch of firestoreBatches) {
          await batch.commit();
        }
      }

      res.status(200).json({
        dryRun,
        totalOrders: allOrders.length,
        totalUpdated,
        totalSkipped: skippedOrders.length,
        skippedOrders,
      });
    } catch (error: any) {
      console.error("Error in syncBlueDartDeliveredTime:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  },
);
