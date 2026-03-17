import { onRequest } from "firebase-functions/https";
import { db } from "../../firebaseAdmin";
import {
  calcGrossProfit,
  calcPurchaseMetric,
  calcSaleMetric,
  calcStockMetric,
  MetricRow,
} from "./helpers";
import { Timestamp } from "firebase-admin/firestore";

// ─── Main Handler ─────────────────────────────────────────────────────────────

export const grossProfitReport = onRequest(
  {
    cors: true,
    timeoutSeconds: 3600,
    memory: "4GiB",
  },
  async (req, res) => {
    try {
      // ── 1. Validate input ──────────────────────────────────────────────────
      const { businessId, startDate, endDate } = req.body as {
        businessId?: string;
        startDate?: string;
        endDate?: string;
      };

      if (!businessId || !startDate || !endDate) {
        res.status(400).json({ error: "businessId, startDate and endDate are required." });
        return;
      }

      const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
      if (!DATE_REGEX.test(startDate) || !DATE_REGEX.test(endDate)) {
        res.status(400).json({ error: "Dates must be in yyyy-mm-dd format." });
        return;
      }

      if (startDate > endDate) {
        res.status(400).json({ error: "startDate must not be after endDate." });
        return;
      }

      // ── 2. Fetch business + store IDs ──────────────────────────────────────
      const businessDoc = await db.collection("users").doc(businessId).get();
      if (!businessDoc.exists) {
        res.status(404).json({ error: `Business '${businessId}' not found.` });
        return;
      }

      const storeIds: string[] = businessDoc.data()?.stores ?? [];
      if (storeIds.length === 0) {
        res.status(400).json({ error: "No stores linked to this business." });
        return;
      }

      // Dates used in order queries are prefix-compared as strings (ISO format)
      const formattedStartDate = `${startDate}T00:00:00+05:30`;
      const formattedEndDate = `${endDate}T23:59:59+05:30`;

      // ── 3. Calculate metrics ───────────────────────────────────────────────
      // sale, saleReturn, purchase, openingStock can all run in parallel.
      // closingStock must come after saleReturn because it needs lostQty.
      const [sale, saleReturn, purchase, openingStock] = await Promise.all([
        calcSaleMetric(storeIds, formattedStartDate, formattedEndDate, false),
        calcSaleMetric(storeIds, formattedStartDate, formattedEndDate, true),
        calcPurchaseMetric(businessId, startDate, endDate),
        calcStockMetric(businessId, startDate, true),
      ]);

      // Pass lostQty so closing stock deducts lost items from the snapshot total
      const closingStock = await calcStockMetric(
        businessId,
        endDate,
        false,
        saleReturn.lostQty ?? 0,
      );

      const grossProfit = calcGrossProfit([sale, saleReturn, purchase, openingStock, closingStock]);

      const allRows: MetricRow[] = [
        sale,
        saleReturn,
        purchase,
        openingStock,
        closingStock,
        grossProfit,
      ];

      // ── 4. Build Excel ─────────────────────────────────────────────────────
      // const workbook = buildExcel(allRows);

      // ── 5. Upload to Firebase Storage ──────────────────────────────────────
      // const downloadUrl = await uploadToStorage(workbook, businessId, startDate, endDate);

      const businessDocRef = db.collection("users").doc(businessId);

      const firestoreRows = allRows.map(({ lostQty, ...rest }) =>
        lostQty !== undefined ? { ...rest, lostQty } : rest,
      );

      // ── 6. Write to Firestore (same pattern as generateTableData)
      await businessDocRef.update({
        "grossProfitData.loading": false,
        "grossProfitData.lastUpdated": Timestamp.now(),
        "grossProfitData.startDate": startDate,
        "grossProfitData.endDate": endDate,
        "grossProfitData.rows": firestoreRows,   // ← use sanitized rows
        "grossProfitData.downloadUrl": null,
        "grossProfitData.error": null,
      });

      res.status(200).json({ success: true });
    } catch (error: unknown) {
      const { businessId } = req.body as { businessId: string };
      console.error("[grossProfitReport] Unhandled error:", error);
      const businessDocRef = db.collection("users").doc(businessId);
      await businessDocRef.update({
        "grossProfitData.loading": false,
        "grossProfitData.error": error instanceof Error ? error.message : "Unknown error",
        "grossProfitData.lastUpdated": Timestamp.now(),
      });
      res.status(500).json({
        error: "Internal server error.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);