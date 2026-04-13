// functions/src/generateRemittanceTable.ts
import { onRequest } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { ENQUEUE_FUNCTION_SECRET, SHARED_STORE_IDS } from "../../config";
import { requireHeaderSecret } from "../../helpers";
import { db } from "../../firebaseAdmin";

// ─── Courier config ───────────────────────────────────────────────────────────

type SupportedCourier = "Blue Dart" | "Delhivery";

const COURIER_CONFIG: Record<
  SupportedCourier,
  {
    deliveredTimeField: string; // Firestore field holding the delivered timestamp
    firestoreKey: string; // Key under users/{id}/remittanceTable.*
    logEmoji: string;
  }
> = {
  "Blue Dart": {
    deliveredTimeField: "bluedartdeliveredtime",
    firestoreKey: "blueDart",
    logEmoji: "💙",
  },
  Delhivery: {
    deliveredTimeField: "delhiverydeliveredtime",
    firestoreKey: "delhivery",
    logEmoji: "🟠",
  },
};

// Statuses that indicate a COD collection is owed to us
const COD_STATUSES = [
  "Delivered",
  "Closed",
  "DTO Requested",
  "DTO Booked",
  "DTO In Transit",
  "DTO Delivered",
  "Pending Refunds",
  "DTO Refunded",
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface RemittanceRow {
  date: string; // DD-MM-YYYY — the remittance date
  orderDeliveredRangeStart: string; // DD-MM-YYYY
  orderDeliveredRangeEnd: string; // DD-MM-YYYY
  amount: number;
  orderCount: number;
  awbs: string[];
}

interface RemittanceTableData {
  rows: RemittanceRow[];
  totalAmount: number;
  totalOrderCount: number;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDateToUtc(yyyyMmDd: string): Date {
  return new Date(new Date(`${yyyyMmDd}T00:00:00+05:30`).getTime());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function istDayOfWeek(date: Date): number {
  // getUTCDay() on an IST-midnight-aligned Date would be wrong (it's 18:30 UTC
  // the previous day), so advance by IST offset first.
  return new Date(date.getTime() + IST_OFFSET_MS).getUTCDay();
}

function formatISTDate(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const day = String(ist.getUTCDate()).padStart(2, "0");
  const month = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const year = ist.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

function startOfISTDay(date: Date): Timestamp {
  return Timestamp.fromMillis(date.getTime());
}

function endOfISTDay(date: Date): Timestamp {
  return Timestamp.fromMillis(date.getTime() + 24 * 60 * 60 * 1000 - 1);
}

// ─── Courier-specific schedule helpers ───────────────────────────────────────

/**
 * Blue Dart: remittance happens on every Monday and Thursday.
 * Returns all Mon/Thu dates within [start, end].
 */
function getBlueDartRemittanceDates(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const dow = istDayOfWeek(cursor);
    if (dow === 1 || dow === 4) dates.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }
  return dates;
}

/**
 * Blue Dart delivered range for a given remittance date:
 *   Monday  → prev Mon (−7) … prev Wed (−5)
 *   Thursday→ prev Thu (−7) … prev Sun (−4)
 */
function getBlueDartDeliveredRange(remDate: Date): { start: Date; end: Date } {
  const dow = istDayOfWeek(remDate);
  if (dow === 1) return { start: addDays(remDate, -7), end: addDays(remDate, -5) };
  if (dow === 4) return { start: addDays(remDate, -7), end: addDays(remDate, -4) };
  throw new Error(`getBlueDartDeliveredRange called on non-Mon/Thu: ${formatISTDate(remDate)}`);
}

/**
 * Delhivery: remittance happens every day.
 * Returns every date within [start, end].
 */
function getDelhiveryRemittanceDates(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    dates.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }
  return dates;
}

/**
 * Delhivery delivered range for a given remittance date:
 *   Single day = Date − 2  (the "day before yesterday" relative to the remittance date)
 */
function getDelhiveryDeliveredRange(remDate: Date): { start: Date; end: Date } {
  const day = addDays(remDate, -2);
  return { start: day, end: day };
}

// ─── Cloud Function ───────────────────────────────────────────────────────────

export const generateRemittanceTable = onRequest(
  {
    timeoutSeconds: 540,
    memory: "512MiB",
    secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { businessId, startDate, endDate, courier } = req.body;

    // ── Validate ──────────────────────────────────────────────────────────────
    if (!businessId || typeof businessId !== "string") {
      res.status(400).json({ error: "businessId is required" });
      return;
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!startDate || !dateRegex.test(startDate)) {
      res.status(400).json({ error: "startDate is required in YYYY-MM-DD format" });
      return;
    }
    if (!endDate || !dateRegex.test(endDate)) {
      res.status(400).json({ error: "endDate is required in YYYY-MM-DD format" });
      return;
    }

    if (!courier || !COURIER_CONFIG[courier as SupportedCourier]) {
      res.status(400).json({
        error: `courier is required and must be one of: ${Object.keys(COURIER_CONFIG).join(", ")}`,
      });
      return;
    }

    const courierName = courier as SupportedCourier;
    const { deliveredTimeField, firestoreKey, logEmoji } = COURIER_CONFIG[courierName];
    const fsPath = `remittanceTable.${firestoreKey}`;

    console.log(`${logEmoji} Starting ${courierName} remittance table generation:`, {
      businessId,
      startDate,
      endDate,
      stores: SHARED_STORE_IDS,
    });

    const businessDocRef = db.collection("users").doc(businessId);

    await businessDocRef.update({
      [`${fsPath}.loading`]: true,
      [`${fsPath}.error`]: null,
    });

    try {
      const start = istDateToUtc(startDate);
      const end = istDateToUtc(endDate);

      // ── Build remittance date list ────────────────────────────────────────
      const remittanceDates =
        courierName === "Blue Dart"
          ? getBlueDartRemittanceDates(start, end)
          : getDelhiveryRemittanceDates(start, end);

      console.log(
        `📅 ${courierName} remittance dates (${remittanceDates.length}):`,
        remittanceDates.map(formatISTDate),
      );

      // ── Process each remittance date ──────────────────────────────────────
      const rows: RemittanceRow[] = [];

      for (const remDate of remittanceDates) {
        const { start: rangeStart, end: rangeEnd } =
          courierName === "Blue Dart"
            ? getBlueDartDeliveredRange(remDate)
            : getDelhiveryDeliveredRange(remDate);

        const tsStart = startOfISTDay(rangeStart);
        const tsEnd = endOfISTDay(rangeEnd);

        console.log(
          `📦 Remittance ${formatISTDate(remDate)} | Delivered: ${formatISTDate(rangeStart)} → ${formatISTDate(rangeEnd)}`,
        );

        let totalAmount = 0;
        let totalOrderCount = 0;
        const rowAwbs: string[] = [];

        for (const storeId of SHARED_STORE_IDS) {
          const ordersRef = db.collection("accounts").doc(storeId).collection("orders");

          const statusSnaps = await Promise.all(
            COD_STATUSES.map((status) =>
              ordersRef
                .where("courierProvider", "==", courierName)
                .where("customStatus", "==", status)
                .where(deliveredTimeField, ">=", tsStart)
                .where(deliveredTimeField, "<=", tsEnd)
                .get(),
            ),
          );

          const seen = new Set<string>();

          for (const snap of statusSnaps) {
            snap.forEach((doc) => {
              if (seen.has(doc.id)) return;
              seen.add(doc.id);

              const data = doc.data();
              const outstanding = Number(data?.raw?.total_outstanding || 0);
              if (outstanding <= 0) return;

              totalAmount += outstanding;
              totalOrderCount += 1;

              const awb = data?.awb;
              if (awb && typeof awb === "string" && awb.trim()) {
                rowAwbs.push(awb.trim());
              }
            });
          }

          console.log(`   Store ${storeId}: ${seen.size} qualifying orders`);
        }

        rows.push({
          date: formatISTDate(remDate),
          orderDeliveredRangeStart: formatISTDate(rangeStart),
          orderDeliveredRangeEnd: formatISTDate(rangeEnd),
          amount: Math.round(totalAmount * 100) / 100,
          orderCount: totalOrderCount,
          awbs: rowAwbs,
        });
      }

      const tableData: RemittanceTableData = {
        rows,
        totalAmount: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100,
        totalOrderCount: rows.reduce((s, r) => s + r.orderCount, 0),
      };

      console.log(`${logEmoji} Remittance table complete:`, JSON.stringify(tableData, null, 2));

      await businessDocRef.update({
        [`${fsPath}.loading`]: false,
        [`${fsPath}.lastUpdated`]: Timestamp.now(),
        [`${fsPath}.startDate`]: startDate,
        [`${fsPath}.endDate`]: endDate,
        [`${fsPath}.data`]: tableData,
        [`${fsPath}.error`]: null,
      });

      console.log(`✅ ${courierName} remittance table generation completed`);

      res.status(200).json({
        success: true,
        message: `${courierName} remittance table generated successfully`,
        data: tableData,
      });
    } catch (error: any) {
      console.error(`❌ Error generating ${courierName} remittance table:`, error);
      try {
        await businessDocRef.update({
          [`${fsPath}.loading`]: false,
          [`${fsPath}.error`]: error.message || "Unknown error occurred",
          [`${fsPath}.lastUpdated`]: Timestamp.now(),
        });
      } catch (updateError) {
        console.error("Failed to update error state:", updateError);
      }
      res.status(500).json({
        success: false,
        error: `Failed to generate ${courierName} remittance table`,
        message: error.message,
      });
    }
  },
);
