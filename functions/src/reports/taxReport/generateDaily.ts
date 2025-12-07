// Daily Tax Report Generation Function
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, storage } from "../../firebaseAdmin";
import { ENQUEUE_FUNCTION_SECRET, REPORT_PHONE_NUMBER, SHARED_STORE_ID } from "../../config";
import { sendTaxReportWhatsAppMessage } from "../../services";
import { onRequest } from "firebase-functions/v2/https";
import { generateTaxReport } from "./helpers";
import { requireHeaderSecret } from "../../helpers";

/**
 * Scheduled function - runs daily at 12:00 AM
 * Generates report for previous day
 */
export const generateDailyTaxReport = onSchedule(
  {
    schedule: "0 0 * * *", // 12:00 AM daily
    timeZone: "Asia/Kolkata",
    memory: "2GiB",
    timeoutSeconds: 540,
  },
  async () => {
    console.log("🚀 Starting Daily Tax Report Generation...");

    try {
      // Calculate previous day's date
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      // Generate report for single day (yesterday to yesterday)
      const { workbook, salesRows, returnRows, statePivot, hsnPivot } = await generateTaxReport(
        yesterday,
        yesterday,
      );

      // Upload to Firebase Storage
      console.log("\n📊 Step 6: Uploading to Firebase Storage...");
      const dateStr = yesterday.toLocaleDateString("en-GB").replace(/\//g, "-");
      const timestamp = Date.now();
      const fileName = `Tax_Report_${dateStr}_${timestamp}.xlsx`;
      const filePath = `shared_store_tax_reports/${fileName}`;

      const bucket = storage.bucket();
      const file = bucket.file(filePath);

      const writeStream = file.createWriteStream({
        metadata: {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          metadata: {
            generatedAt: new Date().toISOString(),
            reportDate: yesterday.toISOString(),
            salesCount: salesRows.length,
            returnsCount: returnRows.length,
          },
        },
      });

      await workbook.xlsx.write(writeStream);

      await new Promise<void>((resolve, reject) => {
        writeStream.on("finish", () => resolve());
        writeStream.on("error", (error) => reject(error));
      });

      await file.makePublic();
      const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

      console.log(`✅ File uploaded: ${downloadUrl}`);

      // Send WhatsApp Message
      console.log("\n📊 Step 7: Sending WhatsApp Message...");
      const shopDoc = await db.collection("accounts").doc(SHARED_STORE_ID).get();
      const shopData = shopDoc.data();

      if (shopData) {
        await sendTaxReportWhatsAppMessage(shopData, downloadUrl, REPORT_PHONE_NUMBER);
        console.log(`✅ WhatsApp message sent to ${REPORT_PHONE_NUMBER}`);
      }

      console.log("\n✨ Daily Tax Report Generation Completed Successfully!");
      console.log(`📊 Summary:`);
      console.log(`   - Sales line items: ${salesRows.length}`);
      console.log(`   - Return line items: ${returnRows.length}`);
      console.log(`   - States covered: ${statePivot.length}`);
      console.log(`   - HSN codes: ${hsnPivot.length}`);
      console.log(`   - Download URL: ${downloadUrl}`);
    } catch (error) {
      console.error("❌ Error generating daily tax report:", error);
      throw error;
    }
  },
);

/**
 * On-demand function - generates report for custom date range
 *
 * Request body:
 * {
 *   "startDate": "2025-12-04",  // YYYY-MM-DD format
 *   "endDate": "2025-12-06"      // YYYY-MM-DD format
 * }
 */
export const generateCustomTaxReport = onRequest(
  {
    cors: true,
    memory: "2GiB",
    timeoutSeconds: 540,
    secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req, res) => {
    
    try {

      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
      
      // Validate request method
      if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed. Use POST." });
        return;
      }

      // Extract dates from request body
      const { startDate, endDate } = req.body as {
        startDate?: string;
        endDate?: string;
      };

      // Validate date parameters
      if (!startDate || !endDate) {
        res.status(400).json({
          error: "Missing required parameters",
          message: "Please provide both startDate and endDate in YYYY-MM-DD format",
          example: {
            startDate: "2025-12-04",
            endDate: "2025-12-06",
          },
        });
        return;
      }

      // Parse dates
      const start = new Date(startDate);
      const end = new Date(endDate);

      // Validate dates
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        res.status(400).json({
          error: "Invalid date format",
          message: "Dates must be in YYYY-MM-DD format",
          example: "2025-12-04",
        });
        return;
      }

      if (start > end) {
        res.status(400).json({
          error: "Invalid date range",
          message: "startDate must be before or equal to endDate",
        });
        return;
      }

      // Check if range is too large (optional: limit to 31 days)
      const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      if (daysDiff > 31) {
        res.status(400).json({
          error: "Date range too large",
          message: "Please limit the date range to 31 days or less",
          requestedDays: daysDiff,
        });
        return;
      }

      console.log(`🚀 Starting Custom Tax Report Generation...`);
      console.log(`📅 Date Range: ${startDate} to ${endDate} (${daysDiff + 1} days)`);

      // Generate report for custom date range
      const { workbook, salesRows, returnRows, statePivot, hsnPivot } = await generateTaxReport(
        start,
        end,
      );

      // Upload to Firebase Storage
      console.log("\n📊 Step 6: Uploading to Firebase Storage...");
      const startStr = start.toLocaleDateString("en-GB").replace(/\//g, "-");
      const endStr = end.toLocaleDateString("en-GB").replace(/\//g, "-");
      const timestamp = Date.now();
      const fileName = `Tax_Report_${startStr}_to_${endStr}_${timestamp}.xlsx`;
      const filePath = `shared_store_tax_reports/${fileName}`;

      const bucket = storage.bucket();
      const file = bucket.file(filePath);

      const writeStream = file.createWriteStream({
        metadata: {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          metadata: {
            generatedAt: new Date().toISOString(),
            startDate: start.toISOString(),
            endDate: end.toISOString(),
            salesCount: salesRows.length,
            returnsCount: returnRows.length,
          },
        },
      });

      await workbook.xlsx.write(writeStream);

      await new Promise<void>((resolve, reject) => {
        writeStream.on("finish", () => resolve());
        writeStream.on("error", (error) => reject(error));
      });

      await file.makePublic();
      const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

      console.log(`✅ File uploaded: ${downloadUrl}`);

      console.log("\n✨ Custom Tax Report Generation Completed Successfully!");

      // Return response
      res.status(200).json({
        success: true,
        message: "Tax report generated successfully",
        dateRange: {
          startDate,
          endDate,
          days: daysDiff + 1,
        },
        summary: {
          salesLineItems: salesRows.length,
          returnLineItems: returnRows.length,
          statesCovered: statePivot.length,
          hsnCodes: hsnPivot.length,
        },
        downloadUrl,
        fileName,
      });
    } catch (error: any) {
      console.error("❌ Error generating custom tax report:", error);
      res.status(500).json({
        error: "Report generation failed",
        message: error.message || String(error),
      });
    }
  },
);
