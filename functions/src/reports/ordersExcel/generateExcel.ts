import { onRequest } from "firebase-functions/v2/https";
import { ENQUEUE_FUNCTION_SECRET } from "../../config";
import { requireHeaderSecret } from "../../helpers";
import { sendSharedStoreOrdersExcelWhatsAppMessage } from "../../services";
import ExcelJS from "exceljs";
import { db, storage } from "../../firebaseAdmin";

const SHARED_STORE_ID = "nfkjgp-sv.myshopify.com";

interface GenerateExcelPayload {
  phoneNumbers?: string[];
}

/**
 * Generates Excel file of all orders from shared store and sends download link
 */
export const generateSharedStoreOrdersExcel = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "2GiB",
    secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req, res) => {
    try {
      // Validate secret
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { phoneNumbers = ["8950188819", "9132326000", "9779752241"] } = (req.body ||
        {}) as GenerateExcelPayload;

      console.log("🚀 Starting Excel generation for shared store...");
      console.log(`📱 Will send to: ${phoneNumbers.join(", ")}`);

      // Get shared store data
      const shopDoc = await db.collection("accounts").doc(SHARED_STORE_ID).get();
      if (!shopDoc.exists) {
        res.status(404).json({ error: "shared_store_not_found" });
        return;
      }

      const shopData = shopDoc.data() as any;

      // Fetch all orders from shared store
      console.log("📦 Fetching orders from shared store...");
      const ordersSnapshot = await db
        .collection("accounts")
        .doc(SHARED_STORE_ID)
        .collection("orders")
        .get();

      if (ordersSnapshot.empty) {
        res.status(400).json({ error: "no_orders_found" });
        return;
      }

      console.log(`Found ${ordersSnapshot.size} orders`);

      // Process orders into Excel rows
      const excelData: any[] = [];

      ordersSnapshot.docs.forEach((doc) => {
        const order = doc.data();
        const items = order.raw?.line_items || [];

        // Helper functions
        const formatDate = (timestamp: any) => {
          if (!timestamp) return "N/A";
          const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
          return date.toLocaleDateString("en-GB");
        };

        const formatAddress = (address: any) => {
          if (!address) return "N/A";
          const parts = [
            address.address1,
            address.address2,
            address.city,
            address.province,
            address.zip,
            address.country,
          ].filter(Boolean);
          return parts.join(", ") || "N/A";
        };

        const customerName =
          order.raw.customer?.first_name && order.raw.customer?.last_name
            ? `${order.raw.customer.first_name} ${order.raw.customer.last_name}`
            : order.raw.billing_address?.name || order.raw.shipping_address?.name || "N/A";

        const paymentStatus = order.raw.financial_status;

        const payment_gateway_names: string[] = order.raw.payment_gateway_names;

        // Calculate total order value for proportional distribution
        const orderTotal =
          Number(order.raw.current_subtotal_price || order.raw.subtotal_price) ||
          items.reduce((sum: number, item: any) => {
            return sum + Number(item.price) * Number(item.quantity);
          }, 0);

        // Create a row for each line item
        items.forEach((item: any) => {
          // Calculate proportional share for this item
          const itemTotal = Number(item.price) * Number(item.quantity);
          const proportion = orderTotal > 0 ? itemTotal / orderTotal : 0;

          // Calculate proportional refunded amount
          const refundedAmount = order?.refundedAmount;
          let itemRefundedAmount: string | number = "Not refunded";

          if (refundedAmount !== undefined && refundedAmount !== null && refundedAmount !== "") {
            const refundedAmountNum = Number(refundedAmount);
            if (!isNaN(refundedAmountNum) && refundedAmountNum > 0) {
              itemRefundedAmount = Number(refundedAmountNum * proportion).toFixed(2);
            }
          }

          excelData.push({
            "Order name": order.name,
            "Order date": formatDate(order.createdAt),
            Status: String(order.customStatus).toUpperCase(),
            "Financial Status": paymentStatus,
            AWB: order.awb ?? "N/A",
            Courier: order.courier ?? "N/A",
            "Return AWB": order.awb_reverse ?? "N/A",
            "Return Courier": order.courier_reverse,
            Customer: customerName,
            Email: order.raw.customer?.email || order.raw?.contact_email || "N/A",
            Phone:
              order.raw.customer?.phone ||
              order.raw.billing_address?.phone ||
              order.raw.shipping_address?.phone ||
              "N/A",
            "Item title": item.title,
            "Item SKU": item.sku || "N/A",
            "Item Quantity": item.quantity,
            "Item Price": Number(item.price).toFixed(),
            "Total Order Price": Number(order.raw.total_price).toFixed(2),
            "Total Discount": Number(order.raw.total_discounts || 0).toFixed(2),
            "Proportionate Discount": Number(item.discount_allocations?.[0]?.amount || 0).toFixed(
              2,
            ),
            "Credits Used": payment_gateway_names.includes("shopify_store_credit")
              ? (Number(order.raw.total_price) - Number(order.raw.total_outstanding)).toFixed(2)
              : 0,
            "DTO Refunded Amount": itemRefundedAmount,
            "DTO Refund Method": order?.refundMethod || "Not Refunded",
            "Billing Address": formatAddress(order.raw.billing_address),
            "Billing City": order.raw.billing_address?.city || "N/A",
            "Billing State": order.raw.billing_address?.province || "N/A",
            "Billing Pincode": order.raw.billing_address?.zip || "N/A",
            "Billing Country": order.raw.billing_address?.country || "N/A",
            "Shipping Address": formatAddress(order.raw.shipping_address),
            "Shipping City": order.raw.shipping_address?.city || "N/A",
            "Shipping State": order.raw.shipping_address?.province || "N/A",
            "Shipping Pincode": order.raw.shipping_address?.zip || "N/A",
            "Shipping Country": order.raw.shipping_address?.country || "N/A",
          });
        });
      });

      console.log(`📊 Generated ${excelData.length} rows (including line items)`);

      // Generate Excel file using ExcelJS
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Orders");

      // Define columns from the first data row
      if (excelData.length > 0) {
        const headers = Object.keys(excelData[0]);

        // Set up columns with headers
        worksheet.columns = headers.map((header) => ({
          header: header,
          key: header,
          width: Math.min(
            Math.max(
              header.length + 2,
              ...excelData.map((row) => String(row[header] || "").length),
            ),
            50,
          ),
        }));

        // Make header row bold
        worksheet.getRow(1).font = { bold: true };

        // Add all data rows
        excelData.forEach((row) => {
          worksheet.addRow(row);
        });

        // Apply borders to all cells
        worksheet.eachRow((row) => {
          row.eachCell((cell) => {
            cell.border = {
              top: { style: "thin" },
              left: { style: "thin" },
              bottom: { style: "thin" },
              right: { style: "thin" },
            };
          });
        });

        // Freeze the header row
        worksheet.views = [{ state: "frozen", ySplit: 1 }];
      }

      // Upload to Firebase Storage
      const date = new Date().toLocaleDateString("en-GB").replace(/\//g, "-");
      const uniqueId = Date.now(); // Timestamp-based unique ID
      const fileName = `Shared_Store_Orders_${date}_${uniqueId}.xlsx`;
      const filePath = `shared_store_orders/${fileName}`;

      const bucket = storage.bucket();
      const file = bucket.file(filePath);

      // Create write stream
      const writeStream = file.createWriteStream({
        metadata: {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          metadata: {
            generatedAt: new Date().toISOString(),
            shop: SHARED_STORE_ID,
            totalOrders: ordersSnapshot.size,
            totalRows: excelData.length,
          },
        },
      });

      // Write Excel directly to stream
      await workbook.xlsx.write(writeStream);

      // Wait for stream to finish
      await new Promise((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });

      // Make the file publicly accessible and get download URL
      await file.makePublic();
      const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

      console.log(`✅ Excel file generated successfully`);
      console.log(`📊 Total Orders: ${ordersSnapshot.size}, Total Rows: ${excelData.length}`);
      console.log(`📄 Download URL: ${downloadUrl}`);

      // Send WhatsApp messages to all phone numbers
      const messagePromises = phoneNumbers.map((phone) =>
        sendSharedStoreOrdersExcelWhatsAppMessage(shopData, downloadUrl, phone),
      );

      await Promise.allSettled(messagePromises);

      console.log(`📱 WhatsApp messages sent to ${phoneNumbers.length} numbers`);

      res.json({
        success: true,
        message: "Excel generated and sent successfully",
        downloadUrl,
        stats: {
          totalOrders: ordersSnapshot.size,
          totalRows: excelData.length,
          sentTo: phoneNumbers,
        },
      });
    } catch (error) {
      console.error("❌ Error generating Excel:", error);
      res.status(500).json({
        error: "excel_generation_failed",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
