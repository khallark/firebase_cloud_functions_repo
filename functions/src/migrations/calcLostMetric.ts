import { onRequest } from "firebase-functions/v2/https";
import { DocumentData, Timestamp } from "firebase-admin/firestore";
import { db } from "../firebaseAdmin";
import { SHARED_STORE_IDS } from "../config";
import ExcelJS from "exceljs";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OrderRow {
  name: string;
  createdAt: Date | null;
  totalPrice: number;
  totalOutstanding: number;
  customStatus: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseCreatedAt(val: any): Date | null {
  if (!val) return null;
  if (typeof val === "string") {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }
  if (val?.toDate) return val.toDate();
  return null;
}

function toOrderRow(data: DocumentData): OrderRow {
  return {
    name: String(data.name ?? ""),
    createdAt: parseCreatedAt(data.createdAt),
    totalPrice: Number(data?.raw?.total_price ?? 0),
    totalOutstanding: Number(data?.raw?.total_outstanding ?? 0),
    customStatus: String(data.customStatus ?? ""),
  };
}

function addSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  rows: OrderRow[],
): void {
  const ws = workbook.addWorksheet(sheetName);

  ws.columns = [
    { header: "Name", key: "name", width: 20 },
    { header: "Created At", key: "createdAt", width: 18 },
    { header: "Status", key: "customStatus", width: 22 },
    { header: "Total Price", key: "totalPrice", width: 16 },
    { header: "Total Outstanding", key: "totalOutstanding", width: 20 },
  ];

  // Header styling
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, name: "Arial", size: 11 };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
  headerRow.alignment = { horizontal: "center", vertical: "middle" };
  headerRow.height = 20;

  const numFmt = '#,##0.00;(#,##0.00);"-"';
  const dateFmt = "dd-mmm-yyyy";

  for (const row of rows) {
    const excelRow = ws.addRow({
      name: row.name,
      createdAt: row.createdAt,
      customStatus: row.customStatus,
      totalPrice: row.totalPrice,
      totalOutstanding: row.totalOutstanding,
    });
    excelRow.font = { name: "Arial", size: 10 };
    excelRow.alignment = { vertical: "middle" };
    excelRow.getCell("createdAt").numFmt = dateFmt;
    excelRow.getCell("totalPrice").numFmt = numFmt;
    excelRow.getCell("totalOutstanding").numFmt = numFmt;
  }

  // Totals row
  if (rows.length > 0) {
    const lastDataRow = rows.length + 1;
    const totalsRow = ws.addRow({
      name: "TOTAL",
      createdAt: null,
      customStatus: "",
      totalPrice: { formula: `SUM(D2:D${lastDataRow})` } as any,
      totalOutstanding: { formula: `SUM(E2:E${lastDataRow})` } as any,
    });
    totalsRow.font = { name: "Arial", size: 10, bold: true };
    totalsRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2EFDA" } };
    totalsRow.getCell("totalPrice").numFmt = numFmt;
    totalsRow.getCell("totalOutstanding").numFmt = numFmt;
  }

  // Borders
  for (let r = 1; r <= ws.rowCount; r++) {
    for (let c = 1; c <= 5; c++) {
      ws.getRow(r).getCell(c).border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
    }
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export const calcLostMetric = onRequest(
  { cors: true, timeoutSeconds: 540, memory: "1GiB" },
  async (req, res) => {

    // ── Blue Dart ─────────────────────────────────────────────────────────
    // Sheet 1: orders with courierProvider == "Blue Dart" AND bluedartdeliveredtime exists
    // Sheet 2: Blue Dart orders with customStatus == "RTO Delivered" OR "RTO Closed"

    const blueDartDelivered: OrderRow[] = [];
    const blueDartRto: OrderRow[] = [];

    // ── Delhivery ─────────────────────────────────────────────────────────
    // (a) readyToDispatchAt between 10 Mar 2026 and 14 Apr 2026, excluding Closed/RTO Closed
    // (b) readyToDispatchAt before 10 Mar 2026, still not Closed or RTO Closed

    const DELHIVERY_START = Timestamp.fromDate(new Date("2026-03-10T00:00:00+05:30"));
    const DELHIVERY_END = Timestamp.fromDate(new Date("2026-04-14T23:59:59+05:30"));
    const EXCLUDED_STATUSES = new Set(["Closed", "RTO Closed"]);

    const delhiveryA: OrderRow[] = [];
    const delhiveryB: OrderRow[] = [];
    const seenDelhiveryA = new Set<string>();
    const seenDelhiveryB = new Set<string>();

    for (const storeId of SHARED_STORE_IDS) {
      const base = db.collection("accounts").doc(storeId).collection("orders");

      // ── Blue Dart: delivered ───────────────────────────────────────────
      const bdDeliveredSnap = await base
        .where("courierProvider", "==", "Blue Dart")
        .where("bluedartdeliveredtime", "!=", null)
        .get();

      for (const doc of bdDeliveredSnap.docs) {
        blueDartDelivered.push(toOrderRow(doc.data()));
      }

      // ── Blue Dart: RTO ─────────────────────────────────────────────────
      const [bdRtoDelvSnap, bdRtoClosedSnap] = await Promise.all([
        base.where("courierProvider", "==", "Blue Dart").where("customStatus", "==", "RTO Delivered").get(),
        base.where("courierProvider", "==", "Blue Dart").where("customStatus", "==", "RTO Closed").get(),
      ]);

      const seenBdRto = new Set<string>();
      for (const snap of [bdRtoDelvSnap, bdRtoClosedSnap]) {
        for (const doc of snap.docs) {
          if (seenBdRto.has(doc.id)) continue;
          seenBdRto.add(doc.id);
          blueDartRto.push(toOrderRow(doc.data()));
        }
      }

      // ── Delhivery (a): readyToDispatchAt in range ──────────────────────
      const delvASnap = await base
        .where("courierProvider", "==", "Delhivery")
        .where("readyToDispatchAt", ">=", DELHIVERY_START)
        .where("readyToDispatchAt", "<=", DELHIVERY_END)
        .get();

      for (const doc of delvASnap.docs) {
        if (seenDelhiveryA.has(doc.id)) continue;
        seenDelhiveryA.add(doc.id);
        const data = doc.data();
        if (EXCLUDED_STATUSES.has(data.customStatus)) continue;
        delhiveryA.push(toOrderRow(data));
      }

      // ── Delhivery (b): readyToDispatchAt before 10 Mar, still open ─────
      const delvBSnap = await base
        .where("courierProvider", "==", "Delhivery")
        .where("readyToDispatchAt", "<", DELHIVERY_START)
        .get();

      for (const doc of delvBSnap.docs) {
        if (seenDelhiveryB.has(doc.id)) continue;
        seenDelhiveryB.add(doc.id);
        const data = doc.data();
        if (EXCLUDED_STATUSES.has(data.customStatus)) continue;
        delhiveryB.push(toOrderRow(data));
      }
    }

    // ── Build Excel ───────────────────────────────────────────────────────
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Majime";
    workbook.created = new Date();

    addSheet(workbook, "Blue Dart - Delivered", blueDartDelivered);
    addSheet(workbook, "Blue Dart - RTO", blueDartRto);
    addSheet(workbook, "Delhivery - Mar10 to Apr14", delhiveryA);
    addSheet(workbook, "Delhivery - Pre Mar10 Open", delhiveryB);

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="remittance_report.xlsx"`);
    res.setHeader("Content-Length", buffer.length);
    res.status(200).end(buffer);
  }
);