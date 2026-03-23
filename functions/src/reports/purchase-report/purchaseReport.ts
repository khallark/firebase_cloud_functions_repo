import { onRequest } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { db, storage } from "../../firebaseAdmin";
import ExcelJS from "exceljs";
import { randomUUID } from "crypto";

interface PurchaseReportRow {
  billNumber: string;
  dateOfCompletion: Date;
  grnNumber: string;
  productSku: string;
  hsn: string;
  taxRate: number;
  unitPrice: number;
  quantity: number;
  taxableAmount: number;
  sgst: number;
  cgst: number;
  igst: number;
  totalAmount: number;
}

const HSN = "6109";
const TAX_RATE = 5; // %

function calcTax(taxable: number): { sgst: number; cgst: number; igst: number; total: number } {
  const totalTax = Math.round(taxable * TAX_RATE) / 100;
  const half = Math.round((totalTax / 2) * 100) / 100;
  return {
    sgst: half,
    cgst: half,
    igst: 0,
    total: Math.round((taxable + totalTax) * 100) / 100,
  };
}

async function buildExcelBuffer(
  rows: PurchaseReportRow[],
  startDate: string,
  endDate: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Majime";
  workbook.created = new Date();

  const ws = workbook.addWorksheet("Purchase Report");

  ws.columns = [
    { header: "Bill No.", key: "billNumber", width: 18 },
    { header: "Date of Completion", key: "dateOfCompletion", width: 20 },
    { header: "GRN No.", key: "grnNumber", width: 18 },
    { header: "Product SKU", key: "productSku", width: 24 },
    { header: "HSN", key: "hsn", width: 10 },
    { header: "Tax Rate (%)", key: "taxRate", width: 13 },
    { header: "Unit Price", key: "unitPrice", width: 14 },
    { header: "Quantity", key: "quantity", width: 12 },
    { header: "Taxable Amount", key: "taxableAmount", width: 16 },
    { header: "SGST", key: "sgst", width: 12 },
    { header: "CGST", key: "cgst", width: 12 },
    { header: "IGST", key: "igst", width: 12 },
    { header: "Total Amount", key: "totalAmount", width: 16 },
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
      billNumber: row.billNumber,
      dateOfCompletion: row.dateOfCompletion,
      grnNumber: row.grnNumber,
      productSku: row.productSku,
      hsn: row.hsn,
      taxRate: row.taxRate,
      unitPrice: row.unitPrice,
      quantity: row.quantity,
      taxableAmount: row.taxableAmount,
      sgst: row.sgst,
      cgst: row.cgst,
      igst: row.igst,
      totalAmount: row.totalAmount,
    });

    excelRow.font = { name: "Arial", size: 10 };
    excelRow.alignment = { vertical: "middle" };

    // Date column (B) — Excel date format
    excelRow.getCell("dateOfCompletion").numFmt = dateFmt;

    // Numeric columns
    ["unitPrice", "taxableAmount", "sgst", "cgst", "igst", "totalAmount"].forEach((key) => {
      excelRow.getCell(key).numFmt = numFmt;
    });
  }

  // Thin borders on all cells
  for (let r = 1; r <= ws.rowCount; r++) {
    for (let c = 1; c <= 13; c++) {
      ws.getRow(r).getCell(c).border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
    }
  }

  // Report date note
  ws.getCell("O1").value = `Period: ${startDate} to ${endDate}`;
  ws.getCell("O1").font = { name: "Arial", size: 10, italic: true };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function uploadToStorage(
  buffer: Buffer,
  businessId: string,
  startDate: string,
  endDate: string,
): Promise<string> {
  const uniqueId = randomUUID();
  const filename = `purchase_report_${startDate}_to_${endDate}_${uniqueId}.xlsx`;
  const storagePath = `purchaseReports/${businessId}/${filename}`;

  const bucket = storage.bucket();
  const file = bucket.file(storagePath);

  await file.save(buffer, {
    metadata: {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });

  await file.makePublic();

  return `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
}

export const purchaseReport = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    try {
      // ── 1. Validate input ────────────────────────────────────────────────
      const { businessId, startDate, endDate } = req.body as {
        businessId?: string;
        startDate?: string;
        endDate?: string;
      };

      if (!businessId || !startDate || !endDate) {
        res.status(400).json({ error: "businessId, startDate and endDate are required." });
        return;
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        res.status(400).json({ error: "Dates must be in yyyy-mm-dd format." });
        return;
      }

      // ── 2. Query GRNs by completedAt ─────────────────────────────────────
      const startTs = Timestamp.fromDate(new Date(`${startDate}T00:00:00+05:30`));
      const endTs = Timestamp.fromDate(new Date(`${endDate}T23:59:59+05:30`));

      const snap = await db
        .collection(`users/${businessId}/grns`)
        .where("completedAt", ">=", startTs)
        .where("completedAt", "<=", endTs)
        .orderBy("completedAt", "asc")
        .get();

      // ── 3. Build rows ─────────────────────────────────────────────────────
      // Unique key: (grnNumber, productSku) — one product appears once per GRN
      const seen = new Set<string>();
      const rows: PurchaseReportRow[] = [];

      for (const doc of snap.docs) {
        const grn = doc.data();
        const completedAt: Timestamp = grn.completedAt;
        const dateOfCompletion = completedAt.toDate();
        const billNumber = String(grn.billNumber ?? "");
        const grnNumber = String(grn.grnNumber ?? doc.id);
        const items: any[] = grn.items ?? [];

        for (const item of items) {
          const productSku = String(item.sku ?? "");
          if (!productSku) continue;

          const uniqueKey = `${grnNumber}||${productSku}`;
          if (seen.has(uniqueKey)) continue;
          seen.add(uniqueKey);

          const unitPrice = Number(item.unitCost ?? 0);
          const quantity = Number(item.receivedQty ?? 0);
          const taxableAmount = Number(item.totalCost ?? unitPrice * quantity);
          const tax = calcTax(taxableAmount);

          rows.push({
            billNumber,
            dateOfCompletion,
            grnNumber,
            productSku,
            hsn: HSN,
            taxRate: TAX_RATE,
            unitPrice,
            quantity,
            taxableAmount,
            sgst: tax.sgst,
            cgst: tax.cgst,
            igst: tax.igst,
            totalAmount: tax.total,
          });
        }
      }

      // ── 4. Build Excel & upload ──────────────────────────────────────────
      const buffer = await buildExcelBuffer(rows, startDate, endDate);
      const downloadUrl = await uploadToStorage(buffer, businessId, startDate, endDate);

      res.status(200).json({ downloadUrl, rowCount: rows.length });
    } catch (error) {
      console.error("Error generating purchase report:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
