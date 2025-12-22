// Daily Tax Report Generation Function
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, storage } from "../../firebaseAdmin";
import {
  ENQUEUE_FUNCTION_SECRET,
  REPORT_PHONE_NUMBER,
  SHARED_STORE_ID,
  TASKS_SECRET,
} from "../../config";
import { createTask, sendTaxReportWhatsAppMessage } from "../../services";
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
      // Get current date in IST
      const istDateStr = new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      }); // Returns "2024-12-12" format

      // Parse and subtract a day
      const todayIST = new Date(istDateStr + "T00:00:00+05:30");
      const yesterday = new Date(todayIST);
      yesterday.setDate(yesterday.getDate() - 1);

      // Generate report for single day (yesterday to yesterday)
      const { workbook, salesRows, returnRows, statePivot, hsnPivot } = await generateTaxReport(
        SHARED_STORE_ID,
        yesterday,
        yesterday,
      );

      // Upload to Firebase Storage
      console.log("\n📊 Step 6: Uploading to Firebase Storage...");
      const dateStr = yesterday.toLocaleDateString("en-GB").replace(/\//g, "-");
      const timestamp = Date.now();
      const fileName = `Tax_Report_${dateStr}_${timestamp}.xlsx`;
      const filePath = `tax_reports/${SHARED_STORE_ID}/${fileName}`;

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
      const downloadUrl = `${bucket.name}/${filePath}`;

      console.log(`✅ File uploaded: ${downloadUrl}`);

      // Send WhatsApp Message
      console.log("\n📊 Step 7: Sending WhatsApp Message...");
      const shopDoc = await db.collection("accounts").doc(SHARED_STORE_ID).get();
      const shopData = shopDoc.data();

      if (shopData) {
        await sendTaxReportWhatsAppMessage(
          shopData,
          yesterday.toDateString(),
          yesterday.toDateString(),
          downloadUrl,
          REPORT_PHONE_NUMBER,
        );
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
 * Preliminary function - validates request and enqueues tax report generation
 * Returns immediately after validation and task creation
 *
 * Request body:
 * {
 *   "storeId": "shop.myshopify.com",
 *   "startDate": "2025-12-04",  // YYYY-MM-DD format
 *   "endDate": "2025-12-06"      // YYYY-MM-DD format
 * }
 */
export const generateCustomTaxReportPreliminary = onRequest(
  {
    cors: true,
    memory: "512MiB",
    timeoutSeconds: 60,
    secrets: [ENQUEUE_FUNCTION_SECRET, TASKS_SECRET],
  },
  async (req, res) => {
    try {
      // Validate secret
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      // Validate request method
      if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed. Use POST." });
        return;
      }

      // Extract parameters from request body
      const { businessId, storeId, startDate, endDate } = req.body as {
        businessId?: string;
        storeId?: string;
        startDate?: string;
        endDate?: string;
      };

      console.log("📥 Tax Report Enqueue Request:", { storeId, startDate, endDate });

      // Validate required parameters
      if (!businessId || !storeId || !startDate || !endDate) {
        res.status(400).json({
          error: "Missing required parameters",
          message: "Please provide storeId, startDate and endDate in YYYY-MM-DD format",
          example: {
            storeId: "shop.myshopify.com",
            startDate: "2025-12-04",
            endDate: "2025-12-06",
          },
        });
        return;
      }

      const businessDoc = await db.collection("users").doc(businessId).get();
      if (!businessDoc || !businessDoc.exists) {
        res.status(400).json({
          error: "Non-existant Business",
          message: "This business doesn't exists.",
        });
        return;
      }
      if (!businessDoc.data()?.primaryContact?.phone) {
        res.status(400).json({
          error: "Missing Phone Number",
          message: "This business doesn't have a Phone Number in the Settings > Primary Contact",
        });
        return;
      }
      const phone = businessDoc.data()?.primaryContact?.phone;

      // Validate storeId format
      if (typeof storeId !== "string" || storeId.trim().length === 0) {
        res.status(400).json({
          error: "Invalid storeId",
          message: "storeId must be a non-empty string",
        });
        return;
      }

      // Validate date format (YYYY-MM-DD)
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
        res.status(400).json({
          error: "Invalid date format",
          message: "Dates must be in YYYY-MM-DD format",
          example: "2025-12-04",
        });
        return;
      }

      // Parse dates
      const start = new Date(startDate);
      const end = new Date(endDate);

      // Validate dates are valid
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        res.status(400).json({
          error: "Invalid date values",
          message: "Could not parse the provided dates",
        });
        return;
      }

      // Validate date range
      if (start > end) {
        res.status(400).json({
          error: "Invalid date range",
          message: "startDate must be before or equal to endDate",
        });
        return;
      }

      // Calculate days difference
      const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

      // Validate range is not too large (limit to 31 days)
      // if (daysDiff > 31) {
      //   res.status(400).json({
      //     error: "Date range too large",
      //     message: "Please limit the date range to 31 days or less",
      //     requestedDays: daysDiff + 1,
      //     maxDays: 31,
      //   });
      //   return;
      // }

      // Validate date is not in the future
      const today = new Date();
      today.setHours(23, 59, 59, 999); // End of today
      if (end > today) {
        res.status(400).json({
          error: "Invalid date range",
          message: "Cannot generate reports for future dates",
        });
        return;
      }

      console.log("✅ Validation passed");
      console.log(`📅 Date Range: ${startDate} to ${endDate} (${daysDiff + 1} days)`);

      // Get the worker function URL from environment
      const workerUrl = process.env.GENERATE_CUSTOM_TAX_REPORT_WORKER_URL;
      if (!workerUrl) {
        throw new Error("GENERATE_CUSTOM_TAX_REPORT_WORKER_URL environment variable not set");
      }

      // Create Cloud Task to call the worker function
      console.log("📋 Creating Cloud Task for tax report generation...");

      const taskName = await createTask(
        {
          phone,
          storeId,
          startDate,
          endDate,
        },
        {
          tasksSecret: TASKS_SECRET.value() || "",
          url: workerUrl,
          queue: String(process.env.SHIPMENT_QUEUE_NAME),
        },
      );

      console.log(`✅ Cloud Task created: ${taskName}`);

      // Return success response immediately
      res.status(202).json({
        success: true,
        message: "Tax report generation has been queued successfully",
        taskName,
        dateRange: {
          storeId,
          startDate,
          endDate,
          days: daysDiff + 1,
        },
        status: "queued",
      });
    } catch (error: any) {
      console.error("❌ Error enqueueing tax report generation:", error);
      res.status(500).json({
        error: "Failed to queue tax report generation",
        message: error.message || String(error),
      });
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
    memory: "4GiB",
    timeoutSeconds: 3600,
    secrets: [TASKS_SECRET],
  },
  async (req, res) => {
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");

      // Validate request method
      if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed. Use POST." });
        return;
      }

      // Extract dates from request body
      const { phone, storeId, startDate, endDate } = req.body as {
        phone?: string;
        storeId?: string;
        startDate?: string;
        endDate?: string;
      };

      // Validate date parameters
      if (!phone || !storeId || !startDate || !endDate) {
        res.status(400).json({
          error: "Missing required parameters",
          message: "Please provide storeId, startDate and endDate in YYYY-MM-DD format",
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
      // if (daysDiff > 31) {
      //   res.status(400).json({
      //     error: "Date range too large",
      //     message: "Please limit the date range to 31 days or less",
      //     requestedDays: daysDiff,
      //   });
      //   return;
      // }

      // console.log(`🚀 Starting Custom Tax Report Generation...`);
      console.log(`📅 Date Range: ${startDate} to ${endDate} (${daysDiff + 1} days)`);

      // Generate report for custom date range
      const { workbook, salesRows, returnRows, statePivot, hsnPivot } = await generateTaxReport(
        storeId,
        start,
        end,
      );

      // Upload to Firebase Storage
      console.log("\n📊 Step 6: Uploading to Firebase Storage...");
      const startStr = start.toLocaleDateString("en-GB").replace(/\//g, "-");
      const endStr = end.toLocaleDateString("en-GB").replace(/\//g, "-");
      const timestamp = Date.now();
      const fileName = `Tax_Report_${startStr}_to_${endStr}_${timestamp}.xlsx`;
      const filePath = `tax_reports/${storeId}/${fileName}`;

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
      const downloadUrl = `${bucket.name}/${filePath}`;

      console.log(`✅ File uploaded: ${downloadUrl}`);

      // Send WhatsApp Message
      console.log("\n📊 Step 7: Sending WhatsApp Message...");
      const shopDoc = await db.collection("accounts").doc(storeId).get();
      const shopData = shopDoc.data();

      if (shopData) {
        await sendTaxReportWhatsAppMessage(shopData, startDate, endDate, downloadUrl, phone);
        console.log(`✅ WhatsApp message sent to ${phone}`);
      }

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
