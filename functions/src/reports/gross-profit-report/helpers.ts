// ─── Types ────────────────────────────────────────────────────────────────────

import { QueryDocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import { db, storage } from "../../firebaseAdmin";
import ExcelJS from "exceljs";
import { randomUUID } from "crypto";

export interface MetricRow {
  type: string;
  qty: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  net: number;
  lostQty?: number; // present on Sale Return and Closing Stock rows
}

// ─── Tax Helpers ──────────────────────────────────────────────────────────────

const TAX_RATE = 0.05;

/**
 * Reverse-calculates taxable amount and splits tax into IGST or CGST/SGST
 * depending on whether the state is Punjab.
 */
function reverseCalculateTax(
  netAmount: number,
  isPunjab: boolean,
): { taxable: number; igst: number; cgst: number; sgst: number } {
  const taxable = netAmount / (1 + TAX_RATE);
  const totalTax = netAmount - taxable;
  return {
    taxable: round2(taxable),
    igst: isPunjab ? 0 : round2(totalTax),
    cgst: isPunjab ? round2(totalTax / 2) : 0,
    sgst: isPunjab ? round2(totalTax / 2) : 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Metric Calculators ───────────────────────────────────────────────────────

/**
 * Calculates Sale (or Sale Return) metric across all stores.
 * If `isReturn` is true, applies the customStatus filter for returns.
 * Returns `lostQty` on the Sale Return row so the caller can pass it to calcStockMetric.
 */
export async function calcSaleMetric(
  storeIds: string[],
  formattedStartDate: string,
  formattedEndDate: string,
  isReturn: boolean,
): Promise<MetricRow> {
  let totalQty = 0;
  let totalNet = 0;
  let totalTaxable = 0;
  let totalIgst = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalLostQty = 0;

  const startTs = Timestamp.fromDate(new Date(formattedStartDate));
  const endTs = Timestamp.fromDate(new Date(formattedEndDate));

  for (const storeId of storeIds) {
    const baseQuery = db.collection("accounts").doc(storeId).collection("orders");

    let snapshot: { docs: QueryDocumentSnapshot[] };

    if (isReturn) {
      const [rtoSnap, pendingRefundsSnap, cancellationSnap, cancelledSnap, lostSnap] =
        await Promise.all([
          baseQuery
            .where("customStatus", "==", "RTO Closed")
            .where("lastStatusUpdate", ">=", startTs)
            .where("lastStatusUpdate", "<=", endTs)
            .get(),
          baseQuery
            .where("pendingRefundsAt", ">=", startTs)
            .where("pendingRefundsAt", "<=", endTs)
            .get(),
          baseQuery
            .where("cancellationRequestedAt", ">=", startTs)
            .where("cancellationRequestedAt", "<=", endTs)
            .get(),
          baseQuery
            .where("customStatus", "==", "Cancelled")
            .where("lastStatusUpdate", ">=", startTs)
            .where("lastStatusUpdate", "<=", endTs)
            .get(),
          baseQuery
            .where("customStatus", "==", "Lost")
            .where("lastStatusUpdate", ">=", startTs)
            .where("lastStatusUpdate", "<=", endTs)
            .get(),
        ]);

      const seenIds = new Set<string>();
      const mergedDocs: QueryDocumentSnapshot[] = [];

      for (const snap of [rtoSnap, pendingRefundsSnap, cancellationSnap]) {
        for (const doc of snap.docs) {
          if (seenIds.has(doc.id)) continue;
          seenIds.add(doc.id);
          mergedDocs.push(doc);
        }
      }

      // Cancelled: only fall back to lastStatusUpdate if cancellationRequestedAt is absent
      for (const doc of cancelledSnap.docs) {
        if (seenIds.has(doc.id)) continue;
        const cancelReqAt = doc.data().cancellationRequestedAt as Timestamp | undefined;
        if (cancelReqAt) continue;
        seenIds.add(doc.id);
        mergedDocs.push(doc);
      }

      // Lost: always include, track qty separately
      for (const doc of lostSnap.docs) {
        if (seenIds.has(doc.id)) continue;
        seenIds.add(doc.id);
        mergedDocs.push(doc);
        const lostItems: number =
          doc.data()?.raw?.line_items?.reduce(
            (sum: number, item: any) => sum + Number(item?.quantity ?? 0),
            0,
          ) ?? 0;
        totalLostQty += lostItems;
      }

      snapshot = { docs: mergedDocs };
    } else {
      snapshot = await baseQuery
        .where("createdAt", ">=", formattedStartDate)
        .where("createdAt", "<=", formattedEndDate)
        .get();
    }

    const a: Record<string, string[]> = {};
    for (const doc of snapshot.docs) {
      const order = doc.data();
      // in-memory vendor exclusion (replaces the not-in Firestore filter)
      const vendors: string[] = order.vendors ?? [];
      if (vendors.length === 1 && (vendors.includes("ENDORA") || vendors.includes("STYLE 05")))
        continue;
      if (!a[order.customStatus]) a[order.customStatus] = [];
      a[order.customStatus].push(order.name);
      const netPrice = Number(order?.raw?.total_price ?? 0);
      const isPunjab = order?.raw?.shipping_address?.province === "Punjab";
      const tax = reverseCalculateTax(netPrice, isPunjab);
      const numItems =
        isReturn && ["Pending Refunds", "DTO Refunded"].includes(order.customStatus)
          ? order?.raw?.line_items
            ?.filter((item: any) => item?.qc_status === "QC Pass")
            ?.reduce((sum: number, item: any) => sum + Number(item?.quantity ?? 0), 0)
          : order?.raw?.line_items?.reduce(
            (sum: number, item: any) => sum + Number(item?.quantity ?? 0),
            0,
          );

      totalQty += numItems;
      totalNet += netPrice;
      totalTaxable += tax.taxable;
      totalIgst += tax.igst;
      totalCgst += tax.cgst;
      totalSgst += tax.sgst;
    }

    if (isReturn) {
      console.log("Sale Return orders:");
      for (const [status, names] of Object.entries(a)) {
        console.log(status, ":", names.join(","));
      }
    } else {
      console.log("Sale orders:");
      for (const [status, names] of Object.entries(a)) {
        console.log(status, ":", names.join(","));
      }
    }
  }

  // Sale Return values are stored as negatives in the report
  const sign = isReturn ? -1 : 1;
  return {
    type: isReturn ? "Sale Return" : "Sale",
    qty: sign * totalQty,
    taxable: round2(sign * totalTaxable),
    igst: round2(sign * totalIgst),
    cgst: round2(sign * totalCgst),
    sgst: round2(sign * totalSgst),
    net: round2(sign * totalNet),
    lostQty: isReturn && totalLostQty > 0 ? totalLostQty : undefined,
  };
}

/**
 * Calculates Purchase metric from GRNs (all assumed Punjab).
 */
export async function calcPurchaseMetric(
  businessId: string,
  startDate: string,
  endDate: string,
): Promise<MetricRow> {
  const startTs = Timestamp.fromDate(new Date(`${startDate}T00:00:00+05:30`));
  const endTs = Timestamp.fromDate(new Date(`${endDate}T23:59:59+05:30`));

  const snapshot = await db
    .collection("users")
    .doc(businessId)
    .collection("grns")
    .where("createdAt", ">=", startTs)
    .where("createdAt", "<=", endTs)
    .get();

  let totalQty = 0;
  let totalNet = 0;

  for (const doc of snapshot.docs) {
    const grn = doc.data();
    totalQty += Number(grn.totalReceivedQty ?? 0);
    totalNet += Number(grn.totalReceivedValue ?? 0);
  }

  // Purchase is Punjab and stored as negative
  const tax = reverseCalculateTax(totalNet, true);
  return {
    type: "Purchase",
    qty: -totalQty,
    taxable: round2(-tax.taxable),
    igst: 0,
    cgst: round2(-tax.cgst),
    sgst: round2(-tax.sgst),
    net: round2(-totalNet),
  };
}

/**
 * Calculates Opening or Closing Stock from inventory snapshots (all Punjab).
 * For Opening Stock → use (startDate - 1 day).
 * For Closing Stock → use endDate.
 * Pass `lostQty` (from calcSaleMetric) for closing stock to deduct lost items.
 */
export async function calcStockMetric(
  businessId: string,
  date: string,
  isOpening: boolean,
  lostQty = 0,
): Promise<MetricRow> {
  let snapshotDate = date;

  if (isOpening) {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() - 1);
    snapshotDate = d.toISOString().split("T")[0];
  }

  const snapshot = await db
    .collection("users")
    .doc(businessId)
    .collection("inventory_snapshots")
    .where("date", "==", snapshotDate)
    .get();

  let totalQty = 0;
  for (const doc of snapshot.docs) {
    totalQty +=
      Number(doc.data().stockLevel ?? 0) -
      Number(doc.data().exactDocState.inventory.blockedStock ?? 0);
  }

  // Deduct lost qty from closing stock (lost items are still counted in snapshot
  // but physically no longer in warehouse)
  if (!isOpening && lostQty > 0) {
    totalQty += lostQty;
  }

  const ASSUMED_COGS = 762;
  const totalNet = totalQty * ASSUMED_COGS;
  const tax = reverseCalculateTax(totalNet, true);

  // Opening Stock is negative, Closing Stock is positive
  const sign = isOpening ? -1 : 1;
  return {
    type: isOpening ? "Opening Stock" : "Closing Stock",
    qty: sign * totalQty,
    taxable: round2(sign * tax.taxable),
    igst: 0,
    cgst: round2(sign * tax.cgst),
    sgst: round2(sign * tax.sgst),
    net: round2(sign * totalNet),
    lostQty: !isOpening && lostQty > 0 ? lostQty : undefined,
  };
}

/**
 * Calculates Gross Profit row: Sale + SaleReturn + Purchase + OpeningStock + ClosingStock
 * (signs are already applied, so it's a straight sum).
 */
export function calcGrossProfit(rows: MetricRow[]): MetricRow {
  const sum = (key: keyof MetricRow) =>
    round2(rows.reduce((acc, r) => acc + (r[key] as number), 0));

  return {
    type: "Gross Profit",
    qty: sum("qty"),
    taxable: sum("taxable"),
    igst: sum("igst"),
    cgst: sum("cgst"),
    sgst: sum("sgst"),
    net: sum("net"),
  };
}

// ─── Excel Builder ────────────────────────────────────────────────────────────

export function buildExcel(rows: MetricRow[]): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Majime";
  workbook.created = new Date();

  const ws = workbook.addWorksheet("Gross Profit Report");

  // Column definitions
  ws.columns = [
    { header: "Type", key: "type", width: 28 },
    { header: "Qty", key: "qty", width: 12 },
    { header: "Taxable Amount", key: "taxable", width: 18 },
    { header: "IGST", key: "igst", width: 14 },
    { header: "CGST", key: "cgst", width: 14 },
    { header: "SGST", key: "sgst", width: 14 },
    { header: "Net Amount", key: "net", width: 16 },
  ];

  // Style header row
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, name: "Arial", size: 11 };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFD9E1F2" },
  };
  headerRow.alignment = { horizontal: "center", vertical: "middle" };
  headerRow.height = 20;

  const numFmt = '#,##0.00;(#,##0.00);"-"';

  // Data rows
  for (const row of rows) {
    // Annotate type label in Excel too
    let typeLabel = row.type;
    if (row.type === "Sale Return" && row.lostQty) {
      typeLabel = `Sale Return (incl. Lost: ${row.lostQty})`;
    } else if (row.type === "Closing Stock" && row.lostQty) {
      typeLabel = `Closing Stock (excl. Lost: ${row.lostQty})`;
    }

    const excelRow = ws.addRow([
      typeLabel,
      row.qty,
      row.taxable,
      row.igst,
      row.cgst,
      row.sgst,
      row.net,
    ]);

    excelRow.font = { name: "Arial", size: 10 };
    excelRow.alignment = { vertical: "middle" };

    // Apply number format to numeric columns (B–G)
    for (let col = 2; col <= 7; col++) {
      excelRow.getCell(col).numFmt = numFmt;
    }

    // Highlight Gross Profit row
    if (row.type === "Gross Profit") {
      excelRow.font = { name: "Arial", size: 10, bold: true };
      excelRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFE2EFDA" },
      };
    }
  }

  // Borders on all cells
  const totalRows = ws.rowCount;
  for (let r = 1; r <= totalRows; r++) {
    for (let c = 1; c <= 7; c++) {
      ws.getRow(r).getCell(c).border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
    }
  }

  return workbook;
}

// ─── Storage Upload ───────────────────────────────────────────────────────────

export async function uploadToStorage(
  workbook: ExcelJS.Workbook,
  businessId: string,
  startDate: string,
  endDate: string,
): Promise<string> {
  const uniqueSuffix = `${Date.now()}_${randomUUID()}`;

  const filename = `gross_profit_${startDate}_to_${endDate}_${uniqueSuffix}.xlsx`;
  const storagePath = `gross_profit_reports/${businessId}/${filename}`;

  const buffer = await workbook.xlsx.writeBuffer();

  const bucket = storage.bucket();
  const file = bucket.file(storagePath);

  await file.save(Buffer.from(buffer), {
    metadata: {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });

  await file.makePublic();

  return `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
}