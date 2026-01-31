import { onRequest } from "firebase-functions/https";
import { db, storage } from "../../firebaseAdmin";
import { META_ADS_MANAGER_SECRET } from "../../config";
import { SHARED_STORE_ID_2 } from "../../config";
import ExcelJS from "exceljs";

const businessId = "2yEGCC8AffNxDoTZEqhAkCRgxNl2";
const AD_ACCOUNT_ID = "act_219302623";

function getDateList(start: string, end: string): string[] {
  const dates: string[] = [];
  let d = new Date(start);
  const last = new Date(end);

  while (d <= last) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

export const generateAdReportExcel = onRequest(
  {
    cors: true,
    timeoutSeconds: 3600,
    memory: "2GiB",
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { startDate, endDate } = req.body;

      if (!startDate || !endDate) {
        res.status(400).json({
          error: "missing_parameters",
          message: "startDate and endDate are required in DD-MM-YYYY format",
        });
        return;
      }

      // Parse dates from DD-MM-YYYY format
      const parseDate = (dateStr: string): Date => {
        const [day, month, year] = dateStr.split("-").map(Number);
        return new Date(year, month - 1, day);
      };

      // Convert DD-MM-YYYY to YYYY-MM-DD for Meta API
      const formatDateForMetaAPI = (dateStr: string): string => {
        const [day, month, year] = dateStr.split("-");
        return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
      };

      const startOfDateRange = parseDate(startDate);
      const endOfDateRange = parseDate(endDate);

      // Set time to cover full day range
      startOfDateRange.setHours(0, 0, 0, 0);
      endOfDateRange.setHours(23, 59, 59, 999);

      // Format dates for Meta API (YYYY-MM-DD)
      const metaSinceDate = formatDateForMetaAPI(startDate);
      const metaUntilDate = formatDateForMetaAPI(endDate);
      const dateList = getDateList(metaSinceDate, metaUntilDate);

      console.log(`📊 Generating report for ${startDate} to ${endDate}`);

      // 1. Calculate Opening Stock Count
      console.log("📦 Fetching products...");
      const productsSnapshot = await db.collection(`users/${businessId}/products`).get();

      let openingStockCount = 0;
      productsSnapshot.forEach((doc) => {
        const inventory = doc.data().inventory || {};
        const stockCount =
          (inventory.openingStock || 0) +
          (inventory.inwardAddition || 0) -
          (inventory.deduction || 0) +
          (inventory.autoAddition || 0) -
          (inventory.autoDeduction || 0);
        openingStockCount += stockCount;
      });

      console.log(`✅ Opening Stock Count: ${openingStockCount}`);

      // 2. Calculate Sale Amount, Cancellation, and Gross Sale
      console.log("🛍️ Fetching orders...");

      const startDateString = `${metaSinceDate}T00:00:00+05:30`;
      const endDateString = `${metaUntilDate}T23:59:59+05:30`;

      console.log("Querying with:", startDateString, "to", endDateString);

      const ordersSnapshot = await db
        .collection(`accounts/${SHARED_STORE_ID_2}/orders`)
        .where("createdAt", ">=", startDateString)
        .where("createdAt", "<=", endDateString)
        .get();

      const ordersByDate = new Map<string, { sale: number; cancellation: number }>();

      ordersSnapshot.forEach((doc) => {
        const order = doc.data();
        const date = new Date(order.createdAt).toISOString().slice(0, 10); // YYYY-MM-DD
        const price = parseFloat(order.raw?.total_price || "0");

        if (!ordersByDate.has(date)) {
          ordersByDate.set(date, { sale: 0, cancellation: 0 });
        }

        const day = ordersByDate.get(date)!;
        day.sale += price;

        if (order.customStatus === "Cancelled" || order.customStatus === "Cancellation Requested") {
          day.cancellation += price;
        }
      });

      // 3. Calculate Ad Spent and ROAS
      // Replace the entire "3. Calculate Ad Spent and ROAS" block with this code
      // (and remove the old metaAdsUrl / metaResponse code). Everything else in your function can remain.

      console.log("📱 Fetching Meta Ads data...");

      // Resolve access token (covers secret.value() shape or plain string)
      const ACCESS_TOKEN = META_ADS_MANAGER_SECRET;

      // ---------- Helper: follow paging.next and collect all items ----------
      async function fetchAllFromUrl(initialUrl: string) {
        const all: any[] = [];
        let url: string | null = initialUrl;
        while (url) {
          const resp = await fetch(url);
          if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Meta API error fetching ${url}: ${resp.status} - ${text}`);
          }
          const json = (await resp.json()) as any;
          if (Array.isArray(json.data)) all.push(...json.data);
          // follow paging.next if present
          url = json.paging?.next ?? null;
        }
        return all;
      }

      // ---------- 1) Fetch adset metadata (id -> effective_status) ----------
      console.log("🔎 Fetching adset metadata (to know effective_status)...");
      const adsetsBase = `https://graph.facebook.com/v24.0/${AD_ACCOUNT_ID}/adsets`;
      const adsetsParams = new URLSearchParams({
        fields: "id,name,effective_status",
        limit: "500",
        access_token: String(ACCESS_TOKEN),
      });
      const adsetsUrl = `${adsetsBase}?${adsetsParams.toString()}`;

      const adsetsData = await fetchAllFromUrl(adsetsUrl);
      const adsetStatusMap = new Map<string, string>();
      adsetsData.forEach((a: any) => {
        if (a.id) adsetStatusMap.set(String(a.id), String(a.effective_status || ""));
      });

      // ---------- 2) Fetch insights at level=adset (reliable) ----------
      console.log("🔎 Fetching insights (level=adset)...");
      const insightsBase = `https://graph.facebook.com/v24.0/${AD_ACCOUNT_ID}/insights`;
      const insightsParams = new URLSearchParams({
        level: "adset",
        action_attribution_windows: "['7d_click']",
        // time_range must be a string like {'since':'YYYY-MM-DD','until':'YYYY-MM-DD'}
        time_increment: "1",
        time_range: `{'since':'${metaSinceDate}','until':'${metaUntilDate}'}`,
        // request spend, all actions (counts), action_values (revenue), and purchase_roas (derived)
        fields: "adset_id,adset_name,spend,actions,action_values,purchase_roas",
        limit: "500",
        access_token: String(ACCESS_TOKEN),
      });
      const insightsUrl = `${insightsBase}?${insightsParams.toString()}`;

      const insightsRows = await fetchAllFromUrl(insightsUrl);

      const metaByDate = new Map<string, any[]>();

      insightsRows.forEach((row: any) => {
        const date = row.date_start;
        if (!metaByDate.has(date)) metaByDate.set(date, []);
        metaByDate.get(date)!.push(row);
      });

      // ---------- 3) Aggregate metrics (only include ACTIVE adsets) ----------
      let totalAdSpent = 0;
      let totalPurchaseValue = 0;

      let avgRoasSum = 0;
      let avgRoasCount = 0;

      insightsRows.forEach((row: any) => {
        const adsetId = String(row.adset_id || row.id || "");
        // If we don't know the adset's status from adsets endpoint, skip it.
        // (Alternatively, include it — but you previously counted only ACTIVE)
        const effStatus = adsetStatusMap.get(adsetId);
        if (effStatus !== "ACTIVE") return;

        const spend = parseFloat(row.spend ?? "0") || 0;
        totalAdSpent += spend;

        // Revenue: action_values -> omni_purchase (best source)
        if (Array.isArray(row.action_values)) {
          const purchaseVal = row.action_values.find(
            (a: any) => a.action_type === "omni_purchase" || a.action_type === "purchase",
          );
          if (purchaseVal) {
            totalPurchaseValue += parseFloat(purchaseVal.value ?? "0") || 0;
          }
        }

        // Average ROAS inputs: purchase_roas -> omni_purchase
        if (Array.isArray(row.purchase_roas)) {
          const roasItem = row.purchase_roas.find((r: any) => r.action_type === "omni_purchase");
          if (roasItem) {
            const v = parseFloat(roasItem.value ?? "0");
            if (!Number.isNaN(v)) {
              avgRoasSum += v;
              avgRoasCount++;
            }
          }
        }
      });

      // Final metrics
      const weightedROAS = totalAdSpent > 0 ? totalPurchaseValue / totalAdSpent : 0;
      const averageROAS = avgRoasCount > 0 ? avgRoasSum / avgRoasCount : 0;

      console.log(`✅ Total Ad Spent (ACTIVE): ${totalAdSpent}`);
      console.log(`✅ Total Purchase Value (ACTIVE): ${totalPurchaseValue}`);
      console.log(`✅ Weighted ROAS (Account-level): ${weightedROAS}`);
      console.log(`✅ Average ROAS (Ad-set-level): ${averageROAS}`);

      // 4. Create Excel File
      console.log("📊 Creating Excel file...");
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Ad Report");

      // Add headers
      worksheet.columns = [
        { header: "Date", key: "date", width: 25 },
        { header: "Opening Stock Count", key: "openingStockCount", width: 20 },
        { header: "Ad Spent", key: "adSpent", width: 15 },
        { header: "Sale Amount", key: "saleAmount", width: 15 },
        { header: "Cancellation", key: "cancellation", width: 15 },
        { header: "Gross Sale", key: "grossSale", width: 15 },
        { header: "ROAS (Weighted)", key: "weightedRoas", width: 15 },
        { header: "ROAS (Average)", key: "averageRoas", width: 15 },
      ];

      // Style headers
      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFD3D3D3" },
      };

      // Add data row
      dateList.forEach((date) => {
        // ---------------- Orders ----------------
        const orderDay = ordersByDate.get(date) || { sale: 0, cancellation: 0 };
        const saleAmount = orderDay.sale;
        const cancellation = orderDay.cancellation;
        const grossSale = saleAmount - cancellation;

        // ---------------- Meta ----------------
        let adSpent = 0;
        let purchaseValue = 0;
        let roasSum = 0;
        let roasCount = 0;

        const metaRows = metaByDate.get(date) || [];

        metaRows.forEach((row: any) => {
          const status = adsetStatusMap.get(row.adset_id);
          if (status !== "ACTIVE") return;

          adSpent += parseFloat(row.spend || "0");

          const purchase = row.action_values?.find(
            (a: any) =>
              a.action_type === "omni_purchase" ||
              a.action_type === "purchase" ||
              a.action_type === "offsite_conversion.purchase",
          );
          if (purchase) {
            purchaseValue += parseFloat(purchase.value || "0");
          }

          const roas = row.purchase_roas?.find((r: any) => r.action_type === "omni_purchase");
          if (roas) {
            roasSum += parseFloat(roas.value || "0");
            roasCount++;
          }
        });

        const weightedROAS = adSpent > 0 ? purchaseValue / adSpent : 0;
        const averageROAS = roasCount > 0 ? roasSum / roasCount : 0;

        // ---------------- Excel Row ----------------
        worksheet.addRow({
          date,
          openingStockCount, // stays constant
          adSpent: adSpent.toFixed(2),
          saleAmount: saleAmount.toFixed(2),
          cancellation: cancellation.toFixed(2),
          grossSale: grossSale.toFixed(2),
          weightedRoas: weightedROAS.toFixed(2),
          averageRoas: averageROAS.toFixed(2),
        });
      });

      // 5. Upload to Firebase Storage
      console.log("☁️ Uploading to Firebase Storage...");
      const now = new Date();
      const exactDateISOString = now.toISOString().replace(/[:.]/g, "-");
      const filename = `${startDate}__${exactDateISOString}.xlsx`;
      const filePath = `ad_reports/${filename}`;

      const buffer = await workbook.xlsx.writeBuffer();
      const bucket = storage.bucket();
      const file = bucket.file(filePath);

      await file.save(new Uint8Array(buffer), {
        metadata: {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });

      // Make file publicly accessible
      await file.makePublic();

      // Get download URL
      const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

      console.log("✅ Report generated successfully!");

      let totalSale = 0;
      let totalCancellation = 0;

      ordersByDate.forEach((v) => {
        totalSale += v.sale;
        totalCancellation += v.cancellation;
      });
      const totalGrossSale = totalSale - totalCancellation;

      res.json({
        success: true,
        downloadUrl,
        summary: {
          dateRange: `${startDate} to ${endDate}`,
          openingStockCount,
          adSpent: totalAdSpent.toFixed(2),
          saleAmount: totalSale.toFixed(2),
          cancellation: totalCancellation.toFixed(2),
          grossSale: totalGrossSale.toFixed(2),
          weightedROAS: weightedROAS.toFixed(2),
          averageROAS: averageROAS.toFixed(2),
        },
      });
    } catch (error) {
      console.error("❌ Error generating Excel:", error);
      res.status(500).json({
        error: "excel_generation_failed",
        details: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  },
);
