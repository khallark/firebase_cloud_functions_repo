// functions/src/generateBlueDartRemittanceTable.ts
import { onRequest } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { ENQUEUE_FUNCTION_SECRET, SHARED_STORE_IDS } from "../../config";
import { requireHeaderSecret } from "../../helpers";
import { db } from "../../firebaseAdmin";

const COURIER = "Blue Dart";

// IST offset: UTC+5:30
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

interface RemittanceRow {
  date: string;                    // DD-MM-YYYY — the Monday or Thursday remittance date
  orderDeliveredRangeStart: string; // DD-MM-YYYY
  orderDeliveredRangeEnd: string;   // DD-MM-YYYY
  amount: number;
  orderCount: number;
}

interface RemittanceTableData {
  rows: RemittanceRow[];
  totalAmount: number;
  totalOrderCount: number;
}

// ─── Date helpers ────────────────────────────────────────────────────────────

/**
 * Parse a "YYYY-MM-DD" string into a UTC Date representing midnight IST for
 * that calendar date.  IST midnight = UTC 18:30 of the *previous* calendar day.
 *
 *   "2026-02-09"  →  Date("2026-02-08T18:30:00.000Z")
 */
function istDateToUtc(yyyyMmDd: string): Date {
  // Interpret as IST midnight (UTC-5:30)
  return new Date(new Date(`${yyyyMmDd}T00:00:00+05:30`).getTime());
}

/**
 * Add `days` calendar days (in UTC-day units, but we're already IST-midnight-
 * aligned so adding multiples of 86 400 s works correctly for IST dates).
 */
function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * UTC day-of-week of an IST-midnight-aligned Date.
 * Because IST midnight = UTC 18:30 the *previous* day, getUTCDay() would give
 * the wrong answer — advance by 5h30m first so we land inside the IST day.
 */
function istDayOfWeek(date: Date): number {
  return new Date(date.getTime() + IST_OFFSET_MS).getUTCDay();
  // 0 = Sun, 1 = Mon, 4 = Thu
}

/**
 * Format an IST-midnight-aligned Date as "DD-MM-YYYY".
 */
function formatISTDate(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const day   = String(ist.getUTCDate()).padStart(2, "0");
  const month = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const year  = ist.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

/**
 * Firestore Timestamp for the *start* of an IST date (IST 00:00:00.000).
 * date must be IST-midnight-aligned (from istDateToUtc / addDays).
 */
function startOfISTDay(date: Date): Timestamp {
  // date.getTime() IS already IST midnight expressed in UTC ms
  return Timestamp.fromMillis(date.getTime());
}

/**
 * Firestore Timestamp for the *end* of an IST date (IST 23:59:59.999).
 */
function endOfISTDay(date: Date): Timestamp {
  return Timestamp.fromMillis(date.getTime() + 24 * 60 * 60 * 1000 - 1);
}

// ─── Remittance-window logic ─────────────────────────────────────────────────

/**
 * Given a remittance Date (a Monday or Thursday), return the delivered date
 * window whose COD the courier is settling on that date.
 *
 * Monday  → previous Mon–Wed  (Date-7 … Date-5)
 * Thursday→ previous Thu–Sun  (Date-7 … Date-4)
 */
function getDeliveredRange(remittanceDate: Date): { start: Date; end: Date } {
  const dow = istDayOfWeek(remittanceDate);

  if (dow === 1) {
    // Monday: prev Mon (−7 days) to prev Wed (−5 days)
    return {
      start: addDays(remittanceDate, -7),
      end:   addDays(remittanceDate, -5),
    };
  } else if (dow === 4) {
    // Thursday: prev Thu (−7 days) to prev Sun (−4 days)
    return {
      start: addDays(remittanceDate, -7),
      end:   addDays(remittanceDate, -4),
    };
  } else {
    throw new Error(`getDeliveredRange called on non-Mon/Thu date: ${formatISTDate(remittanceDate)}`);
  }
}

// ─── Cloud Function ──────────────────────────────────────────────────────────

export const generateRemittanceTable = onRequest(
  {
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req, res) => {
    requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { businessId, startDate, endDate } = req.body;

    // ── Input validation ──────────────────────────────────────────────────
    if (!businessId || typeof businessId !== "string") {
      res.status(400).json({ error: "businessId is required" });
      return;
    }

    // Accept "YYYY-MM-DD"
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!startDate || !dateRegex.test(startDate)) {
      res.status(400).json({ error: "startDate is required in YYYY-MM-DD format" });
      return;
    }
    if (!endDate || !dateRegex.test(endDate)) {
      res.status(400).json({ error: "endDate is required in YYYY-MM-DD format" });
      return;
    }

    console.log("💙 Starting Blue Dart remittance table generation:", {
      businessId,
      startDate,
      endDate,
      stores: SHARED_STORE_IDS,
    });

    const businessDocRef = db.collection("users").doc(businessId);

    // Mark as loading
    await businessDocRef.update({
      "blueDartRemittanceTable.loading": true,
      "blueDartRemittanceTable.error": null,
    });

    try {
      // ── Build list of Mon/Thu dates within [startDate, endDate] ──────────
      const start = istDateToUtc(startDate);
      const end   = istDateToUtc(endDate);

      const remittanceDates: Date[] = [];
      let cursor = new Date(start);

      while (cursor <= end) {
        const dow = istDayOfWeek(cursor);
        if (dow === 1 || dow === 4) {
          remittanceDates.push(new Date(cursor));
        }
        cursor = addDays(cursor, 1);
      }

      console.log(`📅 Remittance dates found: ${remittanceDates.length}`, remittanceDates.map(formatISTDate));

      // ── Process each remittance date ─────────────────────────────────────
      const rows: RemittanceRow[] = [];

      for (const remDate of remittanceDates) {
        const { start: rangeStart, end: rangeEnd } = getDeliveredRange(remDate);

        const tsStart = startOfISTDay(rangeStart);
        const tsEnd   = endOfISTDay(rangeEnd);

        console.log(
          `📦 Remittance date: ${formatISTDate(remDate)} | Delivered range: ${formatISTDate(rangeStart)} → ${formatISTDate(rangeEnd)}`
        );

        let totalAmount     = 0;
        let totalOrderCount = 0;

        // Query across all shared stores
        for (const storeId of SHARED_STORE_IDS) {
          const ordersRef = db
            .collection("accounts")
            .doc(storeId)
            .collection("orders");

          // Firestore: courier = Blue Dart, status in [Delivered, Closed],
          // bluedartdelivereddate within the range window.
          // Firestore doesn't support `in` combined with range on a different field
          // in a single query, so we issue two targeted queries and merge.
          const [deliveredSnap, closedSnap] = await Promise.all([
            ordersRef
              .where("courierProvider", "==", COURIER)
              .where("customStatus", "==", "Delivered")
              .where("bluedartdelivereddate", ">=", tsStart)
              .where("bluedartdelivereddate", "<=", tsEnd)
              .get(),

            ordersRef
              .where("courierProvider", "==", COURIER)
              .where("customStatus", "==", "Closed")
              .where("bluedartdelivereddate", ">=", tsStart)
              .where("bluedartdelivereddate", "<=", tsEnd)
              .get(),
          ]);

          // Merge and de-duplicate by doc ID
          const seen = new Set<string>();

          for (const snap of [deliveredSnap, closedSnap]) {
            snap.forEach((doc) => {
              if (seen.has(doc.id)) return;
              seen.add(doc.id);

              const data = doc.data();
              const price = Number(data?.raw?.total_price) || 0;
              totalAmount += price;
              totalOrderCount += 1;
            });
          }

          console.log(
            `   Store ${storeId}: ${seen.size} orders for remittance date ${formatISTDate(remDate)}`
          );
        }

        rows.push({
          date: formatISTDate(remDate),
          orderDeliveredRangeStart: formatISTDate(rangeStart),
          orderDeliveredRangeEnd:   formatISTDate(rangeEnd),
          amount:     Math.round(totalAmount * 100) / 100,
          orderCount: totalOrderCount,
        });
      }

      // ── Aggregate totals ─────────────────────────────────────────────────
      const tableData: RemittanceTableData = {
        rows,
        totalAmount:     Math.round(rows.reduce((s, r) => s + r.amount,     0) * 100) / 100,
        totalOrderCount: rows.reduce((s, r) => s + r.orderCount, 0),
      };

      console.log("💙 Blue Dart remittance table:", JSON.stringify(tableData, null, 2));

      // ── Persist to Firestore ─────────────────────────────────────────────
      await businessDocRef.update({
        "blueDartRemittanceTable.loading":     false,
        "blueDartRemittanceTable.lastUpdated": Timestamp.now(),
        "blueDartRemittanceTable.startDate":   startDate,
        "blueDartRemittanceTable.endDate":     endDate,
        "blueDartRemittanceTable.data":        tableData,
        "blueDartRemittanceTable.error":       null,
      });

      console.log("✅ Blue Dart remittance table generation completed");

      res.status(200).json({
        success: true,
        message: "Blue Dart remittance table generated successfully",
        data: tableData,
      });
    } catch (error: any) {
      console.error("❌ Error generating Blue Dart remittance table:", error);

      try {
        await businessDocRef.update({
          "blueDartRemittanceTable.loading":     false,
          "blueDartRemittanceTable.error":       error.message || "Unknown error occurred",
          "blueDartRemittanceTable.lastUpdated": Timestamp.now(),
        });
      } catch (updateError) {
        console.error("Failed to update error state:", updateError);
      }

      res.status(500).json({
        success: false,
        error: "Failed to generate Blue Dart remittance table",
        message: error.message,
      });
    }
  }
);