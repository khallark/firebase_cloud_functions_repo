import { onSchedule } from "firebase-functions/v2/scheduler";
import { generatePDFFunc } from "./pdfGenerator";
import { ENQUEUE_FUNCTION_SECRET } from "../../config";
import { onRequest } from "firebase-functions/v2/https";
import { requireHeaderSecret } from "../../helpers";

/**
 * Generates a PDF report of unavailable stock items from confirmed orders
 * Runs daily at 9 AM IST
 */
export const generateUnavailableStockReport = onSchedule(
  {
    schedule: "0 20 * * *",
    timeZone: "Asia/Kolkata",
    memory: "1GiB",
    timeoutSeconds: 540,
  },
  async () => {
    await generatePDFFunc();
  },
);

export const generateUnavailableStockReportOnRequest = onRequest(
  {
    cors: true,
    timeoutSeconds: 300,
    secrets: [ENQUEUE_FUNCTION_SECRET],
    memory: "1GiB",
  },
  async (req, res) => {
    // ✅ AUTHENTICATION
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
    } catch (error: any) {
      console.error("❌ Authentication failed:", error);
      res.status(401).json({ error: "Unauthorized", message: error.message });
      return;
    }
    try {
      const { phone } = req.body;
      // ✅ VALIDATE PHONE NUMBER
      if (!phone) {
        res.status(400).json({ error: "Bad Request", message: "phone is required" });
        return;
      }
      await generatePDFFunc(phone);
      res.status(200).json({ success: true, message: "PDF generated and sent" });
    } catch (error: any) {
      console.error("❌ Error in PDF generation:", error);
      res.status(500).json({ error: "Internal server error", message: error.message });
    }
  },
);
