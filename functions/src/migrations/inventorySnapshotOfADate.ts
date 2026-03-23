import { onRequest } from "firebase-functions/v2/https";
import { db, storage } from "../firebaseAdmin";
import ExcelJS from "exceljs";
import { randomUUID } from "crypto";

interface MappedVariant {
  productId: string;
  storeId: string;
  variantId: number;
  variantSku: string;
}

interface SnapshotRow {
  productSku: string;
  stock: number;
  blockedStock: number | null;
  variantSku: string | null;
  productName: string | null; // ← add
  price: number | null;
  cogs: number | null;
}

async function buildExcelBuffer(rows: SnapshotRow[], date: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Majime";
  workbook.created = new Date();

  const ws = workbook.addWorksheet("Closing Stock");

  ws.columns = [
    { header: "Product SKU", key: "productSku", width: 22 },
    { header: "Stock", key: "stock", width: 12 },
    { header: "Blocked Stock", key: "blockedStock", width: 16 },
    { header: "Product Name", key: "productName", width: 28 }, // ← add
    { header: "Variant SKU", key: "variantSku", width: 22 },
    { header: "Price", key: "price", width: 14 },
    { header: "COGS", key: "cogs", width: 14 },
  ];

  // Header styling
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, name: "Arial", size: 11 };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
  headerRow.alignment = { horizontal: "center", vertical: "middle" };
  headerRow.height = 20;

  const numFmt = '#,##0.00;(#,##0.00);"-"';

  for (const row of rows) {
    const excelRow = ws.addRow([
      row.productSku,
      row.stock,
      row.blockedStock,
      row.productName,
      row.variantSku,
      row.price,
      row.cogs,
    ]);
    excelRow.font = { name: "Arial", size: 10 };
    excelRow.alignment = { vertical: "middle" };
    // Numeric columns: Stock(B), Blocked Stock(C), Price(E), COGS(F)
    [2, 3, 6, 7].forEach((col) => (excelRow.getCell(col).numFmt = numFmt));
  }

  // Thin borders on all cells
  for (let r = 1; r <= ws.rowCount; r++) {
    for (let c = 1; c <= 7; c++) {
      ws.getRow(r).getCell(c).border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
    }
  }

  // Add a note with the report date in cell G1
  ws.getCell("H1").value = `Date: ${date}`;
  ws.getCell("G1").font = { name: "Arial", size: 10, italic: true };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function uploadToStorage(buffer: Buffer, businessId: string, date: string): Promise<string> {
  const uniqueId = randomUUID();
  const filename = `closing_stock_${date}_${uniqueId}.xlsx`;
  const storagePath = `closingStock/${businessId}/${filename}`;

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

export const inventorySnapshotOfADate = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    try {
      // ── 1. Validate input ────────────────────────────────────────────────
      const { businessId, date } = req.body as {
        businessId?: string;
        date?: string;
      };

      if (!businessId || !date) {
        res.status(400).json({ error: "businessId and date are required." });
        return;
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ error: "date must be in yyyy-mm-dd format." });
        return;
      }

      // ── 2. Fetch snapshots ───────────────────────────────────────────────
      const snap = await db
        .collection(`users/${businessId}/inventory_snapshots`)
        .where("date", "==", date)
        .get();

      // ── 3. Enrich each snapshot with variant SKU + price ─────────────────
      const result = await Promise.all(
        snap.docs.map(async (doc) => {
          const data = doc.data();
          const productId = data.productId as string;
          const mappedVariants: MappedVariant[] = data.exactDocState?.mappedVariants ?? [];
          const targetVariant = mappedVariants.find((v) => v.storeId === "gj9ejg-cu.myshopify.com");

          let variantSku: string | null = targetVariant?.variantSku ?? null;
          let price: number | null = null;
          let cogs: number | null = null;

          const [variantResult, cogsDoc] = await Promise.all([
            // existing variant/price fetch
            (async () => {
              if (!targetVariant) return null;
              try {
                const productDoc = await db
                  .doc(`accounts/${targetVariant.storeId}/products/${targetVariant.productId}`)
                  .get();
                if (productDoc.exists) {
                  const variants: { id: number; price: number }[] =
                    productDoc.data()?.variants ?? [];
                  const matchedVariant = variants.find((v) => v.id === targetVariant.variantId);
                  return matchedVariant?.price ?? null;
                }
              } catch (err) {
                console.error(
                  `Error fetching product for productId=${targetVariant.productId}:`,
                  err,
                );
              }
              return null;
            })(),
            // new COGS fetch
            db.doc(`users/${businessId}/products/${productId}`).get(),
          ]);

          price = variantResult;
          cogs = cogsDoc.exists ? Number(cogsDoc.data()?.price) || null : null;
          const productName = cogsDoc.exists ? String(cogsDoc.data()?.name ?? "") || null : null; // ← add

          return {
            productSku: productId,
            stock: data.stockLevel as number,
            blockedStock: data?.exactDocState?.inventory?.blockedStock ?? null,
            productName,
            variantSku,
            price,
            cogs,
          } satisfies SnapshotRow;
        }),
      );

      result.sort((a, b) => a.productSku.localeCompare(b.productSku));

      // ── 4. Build Excel & upload ──────────────────────────────────────────
      const buffer = await buildExcelBuffer(result, date);
      const downloadUrl = await uploadToStorage(buffer, businessId, date);

      res.status(200).json({ downloadUrl });
    } catch (error) {
      console.error("Error fetching inventory snapshots:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
