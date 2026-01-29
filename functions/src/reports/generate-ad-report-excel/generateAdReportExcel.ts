import { onRequest } from "firebase-functions/https";
import { ENQUEUE_FUNCTION_SECRET } from "../../config";
import { requireHeaderSecret } from "../../helpers";
import { db, storage } from "../../firebaseAdmin";
import { META_ADS_MANAGER_SECRET } from "../../config";
import { SHARED_STORE_ID_2 } from "../../config";
import ExcelJS from "exceljs";

const businessId = "2yEGCC8AffNxDoTZEqhAkCRgxNl2";
const AD_ACCOUNT_ID = "act_219302623";

export const generateAdReportExcel = onRequest(
  {
    cors: true,
    timeoutSeconds: 3600,
    memory: "2GiB",
    secrets: [ENQUEUE_FUNCTION_SECRET, META_ADS_MANAGER_SECRET],
  },
  async (req, res) => {
    try {
      // Validate secret
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { startDate, endDate } = req.body;

      if (!startDate || !endDate) {
        res.status(400).json({
          error: "missing_parameters",
          message: "startDate and endDate are required in DD-MM-YYYY format"
        });
        return;
      }

      // Parse dates from DD-MM-YYYY format
      const parseDate = (dateStr: string): Date => {
        const [day, month, year] = dateStr.split('-').map(Number);
        return new Date(year, month - 1, day);
      };

      // Convert DD-MM-YYYY to YYYY-MM-DD for Meta API
      const formatDateForMetaAPI = (dateStr: string): string => {
        const [day, month, year] = dateStr.split('-');
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      };

      const startOfDateRange = parseDate(startDate);
      const endOfDateRange = parseDate(endDate);

      // Set time to cover full day range
      startOfDateRange.setHours(0, 0, 0, 0);
      endOfDateRange.setHours(23, 59, 59, 999);

      // Format dates for Meta API (YYYY-MM-DD)
      const metaSinceDate = formatDateForMetaAPI(startDate);
      const metaUntilDate = formatDateForMetaAPI(endDate);

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
      const ordersSnapshot = await db
        .collection(`accounts/${SHARED_STORE_ID_2}/order`)
        .where("createdAt", ">=", startOfDateRange.toISOString())
        .where("createdAt", "<=", endOfDateRange.toISOString())
        .get();

      let saleAmount = 0;
      let cancellation = 0;

      ordersSnapshot.forEach((doc) => {
        const orderData = doc.data();
        const totalPrice = parseFloat(orderData.raw?.total_price || 0);
        const customStatus = orderData.customStatus;

        saleAmount += totalPrice;

        if (customStatus === "Cancelled" || customStatus === "Cancellation Requested") {
          cancellation += totalPrice;
        }
      });

      const grossSale = saleAmount - cancellation;

      console.log(`✅ Sale Amount: ${saleAmount}`);
      console.log(`✅ Cancellation: ${cancellation}`);
      console.log(`✅ Gross Sale: ${grossSale}`);

      // 3. Calculate Ad Spent and ROAS
      console.log("📱 Fetching Meta Ads data...");

      // Construct Meta API URL with time range
      const fieldsParam =
        `id,name,status,effective_status,` +
        `insights.time_range({'since':'${metaSinceDate}','until':'${metaUntilDate}'}){spend,purchase,purchase_roas}`;
      const metaAdsUrl = `https://graph.facebook.com/v21.0/${AD_ACCOUNT_ID}/adsets?fields=${encodeURIComponent(fieldsParam)}&effective_status=['ACTIVE','PAUSED','ARCHIVED']&limit=500&access_token=${META_ADS_MANAGER_SECRET}`;

      console.log(`📅 Meta API Date Range: ${metaSinceDate} to ${metaUntilDate}`);

      const metaResponse = await fetch(metaAdsUrl);

      if (!metaResponse.ok) {
        const errorText = await metaResponse.text();
        throw new Error(`Meta API error: ${metaResponse.status} - ${errorText}`);
      }

      const metaData: any = await metaResponse.json();

      let totalAdSpent = 0;
      let totalPurchaseValue = 0;

      let avgRoasSum = 0;
      let avgRoasCount = 0;

      if (metaData.data && Array.isArray(metaData.data)) {
        metaData.data.forEach((adSet: any) => {
          if (adSet.effective_status !== "ACTIVE") return;

          const insight = adSet.insights?.data?.[0];
          if (!insight) return;

          // --------------------
          // Spend (used by both)
          // --------------------
          const spend = parseFloat(insight.spend || "0");
          totalAdSpent += spend;

          // --------------------
          // Weighted ROAS inputs
          // --------------------
          if (Array.isArray(insight.purchase)) {
            const purchase = insight.purchase.find(
              (p: any) => p.action_type === "omni_purchase"
            );

            if (purchase) {
              totalPurchaseValue += parseFloat(purchase.value || "0");
            }
          }

          // --------------------
          // Average ROAS inputs
          // --------------------
          if (Array.isArray(insight.purchase_roas)) {
            const roasItem = insight.purchase_roas.find(
              (r: any) => r.action_type === "omni_purchase"
            );

            if (roasItem) {
              avgRoasSum += parseFloat(roasItem.value || "0");
              avgRoasCount++;
            }
          }
        });
      }

      // --------------------
      // Final metrics
      // --------------------
      const weightedROAS =
        totalAdSpent > 0 ? totalPurchaseValue / totalAdSpent : 0;

      const averageROAS =
        avgRoasCount > 0 ? avgRoasSum / avgRoasCount : 0;


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
      worksheet.addRow({
        date: `${startDate} to ${endDate}`,
        openingStockCount,
        adSpent: totalAdSpent.toFixed(2),
        saleAmount: saleAmount.toFixed(2),
        cancellation: cancellation.toFixed(2),
        grossSale: grossSale.toFixed(2),
        weightedRoas: weightedROAS.toFixed(2),
        averageRoas: averageROAS.toFixed(2),
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

      res.json({
        success: true,
        downloadUrl,
        summary: {
          dateRange: `${startDate} to ${endDate}`,
          openingStockCount,
          adSpent: totalAdSpent.toFixed(2),
          saleAmount: saleAmount.toFixed(2),
          cancellation: cancellation.toFixed(2),
          grossSale: grossSale.toFixed(2),
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