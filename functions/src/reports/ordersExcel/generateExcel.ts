import { onRequest } from "firebase-functions/v2/https";
// import { ENQUEUE_FUNCTION_SECRET } from "../../config";
// import { requireHeaderSecret } from "../../helpers";
// import { sendSharedStoreOrdersExcelWhatsAppMessage } from "../../services";
import ExcelJS from "exceljs";
import { db, storage } from "../../firebaseAdmin";
import { SHARED_STORE_IDS } from "../../config";

// interface GenerateExcelPayload {
//   phoneNumbers?: string[];
// }

/**
 * Generates Excel file of all orders from shared stores and sends download link
 */
export const generateSharedStoreOrdersExcel = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "2GiB",
    // secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req, res) => {
    try {
      // Validate secret
      // requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      // const { phoneNumbers = ["8950188819", "9132326000", "9779752241"] } = (req.body ||
      // {}) as GenerateExcelPayload;

      console.log("🚀 Starting Excel generation for shared stores...");
      console.log(`🏪 Stores: ${SHARED_STORE_IDS.join(", ")}`);
      // console.log(`📱 Will send to: ${phoneNumbers.join(", ")}`);

      // Fetch shop docs and orders from all shared stores in parallel
      const storeResults = await Promise.all(
        SHARED_STORE_IDS.map(async (storeId) => {
          const [shopDoc, ordersSnapshot] = await Promise.all([
            db.collection("accounts").doc(storeId).get(),
            db
              .collection("accounts")
              .doc(storeId)
              .collection("orders")
              .where("vendors", "array-contains", "ENDORA")
              .get(),
          ]);

          if (!shopDoc.exists) {
            console.warn(`⚠️ Store not found: ${storeId}, skipping...`);
            return { storeId, shopData: null, orders: [] };
          }

          console.log(`✅ Store ${storeId}: fetched ${ordersSnapshot.size} orders`);
          return {
            storeId,
            shopData: shopDoc.data() as any,
            orders: ordersSnapshot.docs,
          };
        }),
      );

      // Use the first valid store's shopData for the WhatsApp message
      const primaryShopData = storeResults.find((r) => r.shopData !== null)?.shopData;
      if (!primaryShopData) {
        res.status(404).json({ error: "no_valid_stores_found" });
        return;
      }

      const totalOrderCount = storeResults.reduce((sum, r) => sum + r.orders.length, 0);
      if (totalOrderCount === 0) {
        res.status(400).json({ error: "no_orders_found" });
        return;
      }

      console.log(`📦 Total orders across all stores: ${totalOrderCount}`);

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

      const getTimestamp = (timestamp: any): number => {
        if (!timestamp) return 0;
        if (timestamp.toDate) return timestamp.toDate().getTime();
        return new Date(timestamp).getTime();
      };

      // Collect all orders across stores with their storeId, then sort by createdAt
      const allOrders = storeResults
        .flatMap(({ storeId, orders }) => orders.map((doc) => ({ storeId, order: doc.data() })))
        .sort((a, b) => getTimestamp(a.order.createdAt) - getTimestamp(b.order.createdAt));

      // Process sorted orders into Excel rows
      const excelData: any[] = [];

      allOrders.forEach(({ storeId, order }) => {
        const items = order.raw?.line_items || [];

        const customerName =
          order.raw.customer?.first_name && order.raw.customer?.last_name
            ? `${order.raw.customer.first_name} ${order.raw.customer.last_name}`
            : order.raw.billing_address?.name || order.raw.shipping_address?.name || "N/A";

        const paymentStatus = order.raw.financial_status;
        const payment_gateway_names: string[] = order.raw.payment_gateway_names;

        const orderTotal =
          Number(order.raw.current_subtotal_price || order.raw.subtotal_price) ||
          items.reduce((sum: number, item: any) => {
            return sum + Number(item.price) * Number(item.quantity);
          }, 0);

        items.forEach((item: any) => {
          const itemTotal = Number(item.price) * Number(item.quantity);
          const proportion = orderTotal > 0 ? itemTotal / orderTotal : 0;

          const refundedAmount = order?.refundedAmount;
          let itemRefundedAmount: string | number = "Not refunded";

          if (refundedAmount !== undefined && refundedAmount !== null && refundedAmount !== "") {
            const refundedAmountNum = Number(refundedAmount);
            if (!isNaN(refundedAmountNum) && refundedAmountNum > 0) {
              itemRefundedAmount = Number(refundedAmountNum * proportion).toFixed(2);
            }
          }

          excelData.push({
            "Store ID": storeId,
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

      if (excelData.length > 0) {
        const headers = Object.keys(excelData[0]);

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

        worksheet.getRow(1).font = { bold: true };

        excelData.forEach((row) => {
          worksheet.addRow(row);
        });

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

        worksheet.views = [{ state: "frozen", ySplit: 1 }];
      }

      // Upload to Firebase Storage
      const date = new Date().toLocaleDateString("en-GB").replace(/\//g, "-");
      const uniqueId = Date.now();
      const fileName = `Shared_Store_Orders_${date}_${uniqueId}.xlsx`;
      const filePath = `shared_store_orders/${fileName}`;

      const bucket = storage.bucket();
      const file = bucket.file(filePath);

      const writeStream = file.createWriteStream({
        metadata: {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          metadata: {
            generatedAt: new Date().toISOString(),
            stores: SHARED_STORE_IDS.join(","),
            totalOrders: totalOrderCount,
            totalRows: excelData.length,
          },
        },
      });

      await workbook.xlsx.write(writeStream);

      await new Promise((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });

      await file.makePublic();
      const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

      console.log(`✅ Excel file generated successfully`);
      console.log(`📊 Total Orders: ${totalOrderCount}, Total Rows: ${excelData.length}`);
      console.log(`📄 Download URL: ${downloadUrl}`);

      // const messagePromises = phoneNumbers.map((phone) =>
      // sendSharedStoreOrdersExcelWhatsAppMessage(primaryShopData, downloadUrl, phone),
      // );

      // await Promise.allSettled(messagePromises);

      // console.log(`📱 WhatsApp messages sent to ${phoneNumbers.length} numbers`);

      res.json({
        success: true,
        message: "Excel generated and sent successfully",
        downloadUrl,
        stats: {
          totalOrders: totalOrderCount,
          totalRows: excelData.length,
          // sentTo: phoneNumbers,
          stores: SHARED_STORE_IDS,
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
