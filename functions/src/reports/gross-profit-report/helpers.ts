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
}

// ─── Tax Helpers ──────────────────────────────────────────────────────────────

const TAX_RATE = 0.05;

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
 * Lost orders are NOT included here — they have their own calcLostMetric.
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

  const startTs = Timestamp.fromDate(new Date(formattedStartDate));
  const endTs = Timestamp.fromDate(new Date(formattedEndDate));

  let totalDTORefunded = 0;
  const dtoDiffs = [];
  for (const storeId of storeIds) {
    const baseQuery = db.collection("accounts").doc(storeId).collection("orders");

    let snapshot: { docs: QueryDocumentSnapshot[] };

    if (isReturn) {
      const [rtoSnap, pendingRefundsSnap, cancellationSnap, cancelledSnap] = await Promise.all([
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
      const vendors: string[] = order.vendors ?? [];
      if (vendors.length === 1 && (vendors.includes("ENDORA") || vendors.includes("STYLE 05")))
        continue;
      if (!a[order.customStatus]) a[order.customStatus] = [];
      a[order.customStatus].push(order.name);
      const netPrice = (() => {
        if (isReturn && order.customStatus === "DTO Refunded") {
          const refundedAmount = Number(order?.refundedAmount ?? 0);
          totalDTORefunded += Number(order?.refundedAmount ?? order?.raw?.total_price ?? 0);
          const itemWiseTotalDTORefunded = Number(order?.raw?.line_items?.reduce((sum: number, item: any) => sum + Number(item.refundedAmount ?? 0), 0) ?? 0);
          if (itemWiseTotalDTORefunded !== refundedAmount) dtoDiffs.push(order?.name ?? order?.raw?.name);
          return Number(order?.refundedAmount ?? order?.raw?.total_price ?? 0);
        }
        if (isReturn && order.customStatus === "Pending Refunds") {
          const items = order?.raw?.line_items
            ? Array.isArray(order.raw.line_items)
              ? order.raw.line_items
              : []
            : [];
          const totalMRP = items.reduce(
            (acc: number, item: any) => acc + Number(item.price ?? 0),
            0,
          );
          return Number(
            items?.reduce((sum: number, item: any) => {
              const itemQty = Number(item.quantity || 0);
              const itemPrice = Number(item.price || 0);
              const mrp = Number((itemQty * itemPrice).toFixed(2));
              const discountArr = item.discount_allocations;
              const discountLinewise = (Array.isArray(discountArr) ? discountArr : []).reduce(
                (a: number, i: any) => a + Number(i.amount ?? 0),
                0,
              );
              const proportionateShippingPrice = Number(
                (
                  (Number(order.raw.total_shipping_price_set.presentment_money.amount ?? 0) * mrp) /
                  totalMRP
                ).toFixed(2),
              );
              return sum + Number((mrp - discountLinewise + proportionateShippingPrice).toFixed(2));
            }, 0),
          );
        }
        return Number(order?.raw?.total_price ?? 0);
      })();
      const isPunjab = order?.raw?.shipping_address?.province === "Punjab";
      const tax = reverseCalculateTax(netPrice, isPunjab);
      const numItems =
        isReturn && ["Pending Refunds", "DTO Refunded"].includes(order.customStatus)
          ? Number(
            order?.raw?.line_items
              ?.filter((item: any) => item?.qc_status === "QC Pass")
              ?.reduce((sum: number, item: any) => sum + Number(item?.quantity ?? 0), 0),
          )
          : Number(
            order?.raw?.line_items?.reduce(
              (sum: number, item: any) => sum + Number(item?.quantity ?? 0),
              0,
            ),
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

  const sign = isReturn ? -1 : 1;
  if (isReturn) {
    console.log(`Total DTO Refunded amount = ${totalDTORefunded}`);
    console.log(`DTO Refunded diffs: ${dtoDiffs}`);
  }
  return {
    type: isReturn ? "Sale Return" : "Sale",
    qty: sign * totalQty,
    taxable: round2(sign * totalTaxable),
    igst: round2(sign * totalIgst),
    cgst: round2(sign * totalCgst),
    sgst: round2(sign * totalSgst),
    net: round2(sign * totalNet),
  };
}

/**
 * Calculates Lost orders metric across all stores.
 * Qty is 0 (displayed as "–" in UI). Amounts are negative (subtracted in gross profit).
 * Row type is "Lost (N)" where N is the actual item count.
 */
export async function calcLostMetric(
  storeIds: string[],
  formattedStartDate: string,
  formattedEndDate: string,
): Promise<MetricRow> {
  const startTs = Timestamp.fromDate(new Date(formattedStartDate));
  const endTs = Timestamp.fromDate(new Date(formattedEndDate));

  let totalItemQty = 0;
  let totalNet = 0;
  let totalTaxable = 0;
  let totalIgst = 0;
  let totalCgst = 0;
  let totalSgst = 0;

  for (const storeId of storeIds) {
    const snap = await db
      .collection("accounts")
      .doc(storeId)
      .collection("orders")
      .where("customStatus", "==", "Lost")
      .where("lastStatusUpdate", ">=", startTs)
      .where("lastStatusUpdate", "<=", endTs)
      .get();

    for (const doc of snap.docs) {
      const order = doc.data();
      const vendors: string[] = order.vendors ?? [];
      if (vendors.length === 1 && (vendors.includes("ENDORA") || vendors.includes("STYLE 05")))
        continue;
      const netPrice = Number(order?.raw?.total_price ?? 0);
      const isPunjab = order?.raw?.shipping_address?.province === "Punjab";
      const tax = reverseCalculateTax(netPrice, isPunjab);
      const qty: number =
        order?.raw?.line_items?.reduce(
          (sum: number, item: any) => sum + Number(item?.quantity ?? 0),
          0,
        ) ?? 0;
      totalItemQty += qty;
      totalNet += netPrice;
      totalTaxable += tax.taxable;
      totalIgst += tax.igst;
      totalCgst += tax.cgst;
      totalSgst += tax.sgst;
    }
  }

  return {
    type: `Lost (${totalItemQty})`,
    qty: 0, // shown as "–" in UI; doesn't affect gross profit qty
    taxable: round2(-totalTaxable),
    igst: round2(-totalIgst),
    cgst: round2(-totalCgst),
    sgst: round2(-totalSgst),
    net: round2(-totalNet),
  };
}

/**
 * Calculates Purchase metric from GRNs.
 * totalReceivedValue on each GRN item is the TAXABLE (ex-tax) amount.
 * Tax is applied FORWARD: taxable * taxRate / 100.
 * Tax rate is fetched per product SKU from users/{businessId}/products/{sku}.
 * All purchases assumed intra-state Punjab → CGST + SGST, no IGST.
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

  // Collect all unique SKUs across all GRN items so we can batch-fetch tax rates
  const skuSet = new Set<string>();
  for (const doc of snapshot.docs) {
    const grn = doc.data();
    for (const item of (grn.items ?? [])) {
      if (item.sku) skuSet.add(item.sku);
    }
  }

  // Batch-fetch product docs to get taxRate per SKU
  const taxRateMap = new Map<string, number>();
  if (skuSet.size > 0) {
    const productRefs = Array.from(skuSet).map((sku) =>
      db.collection("users").doc(businessId).collection("products").doc(sku)
    );
    const productDocs = await db.getAll(...productRefs);
    for (const doc of productDocs) {
      if (doc.exists) {
        taxRateMap.set(doc.id, Number(doc.data()?.taxRate ?? 0));
      }
    }
  }

  let totalQty = 0;
  let totalTaxable = 0;
  let totalCgst = 0;
  let totalSgst = 0;

  for (const doc of snapshot.docs) {
    const grn = doc.data();
    for (const item of (grn.items ?? [])) {
      const sku: string = item.sku ?? "";
      const qty = Number(item.receivedQty ?? 0);
      // unitCost is the taxable (ex-tax) price per unit
      const taxable = Number(item.unitCost ?? 0) * qty;
      const taxRate = taxRateMap.get(sku) ?? 0;
      const totalTax = round2(taxable * taxRate / 100);
      const half = round2(totalTax / 2);

      totalQty += qty;
      totalTaxable += taxable;
      totalCgst += half;
      totalSgst += half;
    }
  }

  return {
    type: "Purchase",
    qty: -totalQty,
    taxable: round2(-totalTaxable),
    igst: 0,
    cgst: round2(-totalCgst),
    sgst: round2(-totalSgst),
    net: round2(-(totalTaxable + totalCgst + totalSgst)),
  };
}

export async function calcCreditNoteMetric(
  businessId: string,
  startDate: string,
  endDate: string,
): Promise<MetricRow> {
  const startTs = Timestamp.fromDate(new Date(`${startDate}T00:00:00+05:30`));
  const endTs = Timestamp.fromDate(new Date(`${endDate}T23:59:59+05:30`));

  const snapshot = await db
    .collection('users')
    .doc(businessId)
    .collection('credit_notes')
    .where('status', '==', 'completed')
    .where('completedAt', '>=', startTs)
    .where('completedAt', '<=', endTs)
    .get();

  let totalQty = 0;
  let totalTaxable = 0;
  let totalCgst = 0;
  let totalSgst = 0;

  for (const doc of snapshot.docs) {
    const cn = doc.data();
    for (const item of (cn.items ?? [])) {
      const qty = Number(item.quantity ?? 0);
      const taxable = Number(item.unitPrice ?? 0) * qty;
      const taxRate = Number(item.taxRate ?? 0);
      const totalTax = round2(taxable * taxRate / 100);
      const half = round2(totalTax / 2);

      totalQty += qty;
      totalTaxable += taxable;
      totalCgst += half;
      totalSgst += half;
    }
  }

  return {
    type: 'Credit Notes',
    qty: totalQty,
    taxable: round2(totalTaxable),
    igst: 0,
    cgst: round2(totalCgst),
    sgst: round2(totalSgst),
    net: round2(totalTaxable + totalCgst + totalSgst),
  };
}

/**
 * Calculates Opening or Closing Stock from inventory snapshots (all Punjab).
 * For Opening Stock → use (startDate - 1 day).
 * For Closing Stock → use endDate.
 */
export async function calcStockMetric(
  businessId: string,
  date: string,
  isOpening: boolean,
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

  const qtyByProduct = new Map<string, number>();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const productId = data.productId as string;
    if (!productId) continue;
    const qty =
      Number(data.stockLevel ?? 0) - Number(data.exactDocState?.inventory?.blockedStock ?? 0);
    qtyByProduct.set(productId, (qtyByProduct.get(productId) ?? 0) + qty);
  }

  const productIds = Array.from(qtyByProduct.keys());
  const productDocs = await Promise.all(
    productIds.map((productId) =>
      db.collection("users").doc(businessId).collection("products").doc(productId).get(),
    ),
  );

  const priceByProduct = new Map<string, number>();
  for (const doc of productDocs) {
    if (!doc.exists) continue;
    const price = Number(doc.data()?.price ?? 0);
    priceByProduct.set(doc.id, price);
  }

  let totalQty = 0;
  let totalNet = 0;
  for (const [productId, qty] of qtyByProduct) {
    totalQty += qty;
    const cogs = priceByProduct.get(productId) ?? 0;
    totalNet += qty * cogs;
  }

  // totalNet is COGS = taxable amount; apply tax forward (not reverse)
  const totalTax = round2(totalNet * TAX_RATE);
  const cgst = round2(totalTax / 2);
  const sgst = round2(totalTax / 2);
  const grossNet = round2(totalNet + totalTax);

  const sign = isOpening ? -1 : 1;
  return {
    type: isOpening ? "Opening Stock" : "Closing Stock",
    qty: sign * totalQty,
    taxable: round2(sign * totalNet), // COGS is the taxable base
    igst: 0,
    cgst: round2(sign * cgst),
    sgst: round2(sign * sgst),
    net: round2(sign * grossNet), // taxable + tax
  };
}

/**
 * Calculates Gross Profit row: sum of all rows (signs already applied).
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

  ws.columns = [
    { header: "Type", key: "type", width: 28 },
    { header: "Qty", key: "qty", width: 12 },
    { header: "Taxable Amount", key: "taxable", width: 18 },
    { header: "IGST", key: "igst", width: 14 },
    { header: "CGST", key: "cgst", width: 14 },
    { header: "SGST", key: "sgst", width: 14 },
    { header: "Net Amount", key: "net", width: 16 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, name: "Arial", size: 11 };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
  headerRow.alignment = { horizontal: "center", vertical: "middle" };
  headerRow.height = 20;

  const numFmt = '#,##0.00;(#,##0.00);"-"';

  for (const row of rows) {
    const isLost = row.type.startsWith("Lost (");
    const excelRow = ws.addRow([
      row.type,
      isLost ? "–" : row.qty,
      row.taxable,
      row.igst,
      row.cgst,
      row.sgst,
      row.net,
    ]);

    excelRow.font = { name: "Arial", size: 10 };
    excelRow.alignment = { vertical: "middle" };

    for (let col = 2; col <= 7; col++) {
      if (!(isLost && col === 2)) {
        excelRow.getCell(col).numFmt = numFmt;
      }
    }

    if (row.type === "Gross Profit") {
      excelRow.font = { name: "Arial", size: 10, bold: true };
      excelRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2EFDA" } };
    }
  }

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
    metadata: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  });
  await file.makePublic();
  return `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
}
