import PDFDocument from "pdfkit";
import { sendUnavailableStockPDFWhatsAppMessage } from "../../services";
import { db, storage } from "../../firebaseAdmin";

export async function generatePDFFunc(phone?: string) {
  try {
    console.log("🔄 Starting unavailable stock report generation...");

    // Get all shops
    const shopsSnapshot = await db.collection("accounts").get();

    for (const shopDoc of shopsSnapshot.docs) {
      const shop = shopDoc.id;
      const shopData = shopDoc.data() as any;
      console.log(`Processing shop: ${shop}`);
      // Query confirmed orders with "Unavailable" tag
      const ordersSnapshot = await db
        .collection("accounts")
        .doc(shop)
        .collection("orders")
        .where("customStatus", "==", "Confirmed")
        .where("tags_confirmed", "array-contains", "Unavailable")
        .get();

      if (ordersSnapshot.empty) {
        console.log(`No unavailable orders for shop: ${shop}`);
        continue;
      }

      // Process orders to create summary and detail data
      const itemSummary: Map<string, number> = new Map();
      const orderDetails: Array<{
        itemSku: string;
        itemQty: number;
        vendor: string;
        orderName: string;
      }> = [];

      ordersSnapshot.forEach((orderDoc) => {
        const order = orderDoc.data();
        const items = order.raw?.line_items || [];

        items.forEach((item: any) => {
          // Add to summary (aggregate by SKU)
          const currentQty = itemSummary.get(item.sku) || 0;
          itemSummary.set(item.sku, currentQty + item.quantity);

          // Add to order details (one row per item)
          orderDetails.push({
            itemSku: item.sku,
            itemQty: item.quantity,
            vendor: item.vendor || "N/A",
            orderName: order.name || "N/A",
          });
        });
      });

      // Calculate totals
      const totalQty = Array.from(itemSummary.values()).reduce((a, b) => a + b, 0);
      const totalOrders = ordersSnapshot.size;

      console.log(`📊 Found ${totalOrders} orders with ${totalQty} total items`);

      // Generate PDF
      const pdfBuffer = await generatePDF(itemSummary, orderDetails, totalQty, totalOrders);

      // Upload to Firebase Storage
      const date = new Date().toLocaleDateString("en-GB").replace(/\//g, "-");
      const fileName = `Unavailable_Stock_Summary_${date}.pdf`;
      const filePath = `unavailable_orders_pdf/${shop}/${fileName}`;

      const bucket = storage.bucket();
      const file = bucket.file(filePath);

      await file.save(pdfBuffer, {
        contentType: "application/pdf",
        metadata: {
          metadata: {
            generatedAt: new Date().toISOString(),
            shop: shop,
            totalOrders: totalOrders,
            totalItems: totalQty,
          },
        },
      });

      // Make the file publicly accessible and get download URL
      await file.makePublic();
      const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

      console.log(`✅ PDF generated successfully for shop: ${shop}`);
      console.log(`📊 Total Orders: ${totalOrders}, Total Items: ${totalQty}`);
      console.log(`📄 Download URL: ${downloadUrl}`);

      if (phone) {
        // Send to specific user
        await sendUnavailableStockPDFWhatsAppMessage(shopData, downloadUrl, phone);
      } else {
        // Send to default numbers (scheduled job)
        await Promise.all([
          sendUnavailableStockPDFWhatsAppMessage(shopData, downloadUrl, "8950188819"),
          sendUnavailableStockPDFWhatsAppMessage(shopData, downloadUrl, "9132326000"),
        ]);
      }
    }
  } catch (error) {
    console.error("❌ Error generating unavailable stock report:", error);
    throw error;
  }
}

/**
 * Generates the PDF with two tables: Summary and Order Details
 */
async function generatePDF(
  itemSummary: Map<string, number>,
  orderDetails: Array<{
    itemSku: string;
    itemQty: number;
    vendor: string;
    orderName: string;
  }>,
  totalQty: number,
  totalOrders: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
      bufferPages: true,
    });

    const chunks: Buffer[] = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Title and Summary Header
    const date = new Date().toLocaleDateString("en-GB");
    doc
      .fontSize(16)
      .fillColor("#FFFFFF")
      .rect(40, 40, doc.page.width - 80, 35)
      .fill("#4472C4");

    doc.fillColor("#FFFFFF").text(`SUMMARY OF UNAVAILABLE STOCK (${date})`, 50, 50, {
      align: "center",
    });

    doc.moveDown(0.3);

    // Total summary box
    const summaryY = doc.y + 10;
    doc
      .rect(40, summaryY, doc.page.width - 80, 25)
      .fill("#4472C4")
      .fillColor("#FFFFFF")
      .fontSize(11)
      .text(`Total Qty : ${totalQty}        Orders Delayed : ${totalOrders}`, 50, summaryY + 7, {
        align: "center",
      });

    doc.moveDown(1.5);

    // Table 1: Items Summary
    drawSummaryTable(doc, itemSummary);

    // Add some space before the second table
    if (doc.y > 600) {
      doc.addPage();
    } else {
      doc.moveDown(2);
    }

    // Table 2: Order Details
    drawOrderDetailsTable(doc, orderDetails);

    // Add page numbers
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .fillColor("#666666")
        .text(`Page ${i + 1} of ${pageCount}`, 40, doc.page.height - 30, { align: "center" });
    }

    doc.end();
  });
}

/**
 * Draws the summary table (Items Required with quantities)
 */
function drawSummaryTable(doc: InstanceType<typeof PDFDocument>, itemSummary: Map<string, number>) {
  const startX = 40;
  const startY = doc.y;
  const colWidths = [70, 390, 55];
  const rowHeight = 20;
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);

  // Header
  doc.fontSize(10).fillColor("#FFFFFF").rect(startX, startY, totalWidth, rowHeight).fill("#4472C4");

  doc
    .fillColor("#FFFFFF")
    .text("Serial No.", startX + 5, startY + 5, {
      width: colWidths[0] - 10,
      align: "left",
    })
    .text("Items Required", startX + colWidths[0] + 5, startY + 5, {
      width: colWidths[1] - 10,
      align: "left",
    })
    .text("Qty", startX + colWidths[0] + colWidths[1] + 5, startY + 5, {
      width: colWidths[2] - 10,
      align: "right",
    });

  let currentY = startY + rowHeight;
  let serialNo = 1;

  // Sort items by SKU for consistent ordering
  const sortedItems = Array.from(itemSummary.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  // Data rows
  sortedItems.forEach(([sku, qty]) => {
    // Check if we need a new page
    if (currentY > doc.page.height - 100) {
      doc.addPage();
      currentY = 50;

      // Redraw header on new page
      doc
        .fontSize(10)
        .fillColor("#FFFFFF")
        .rect(startX, currentY, totalWidth, rowHeight)
        .fill("#4472C4");

      doc
        .fillColor("#FFFFFF")
        .text("Serial No.", startX + 5, currentY + 5, {
          width: colWidths[0] - 10,
        })
        .text("Items Required", startX + colWidths[0] + 5, currentY + 5, {
          width: colWidths[1] - 10,
        })
        .text("Qty", startX + colWidths[0] + colWidths[1] + 5, currentY + 5, {
          width: colWidths[2] - 10,
          align: "right",
        });

      currentY += rowHeight;
    }

    // Draw row with border
    doc
      .lineWidth(0.5)
      .strokeColor("#CCCCCC")
      .rect(startX, currentY, totalWidth, rowHeight)
      .stroke();

    // Draw cell content
    doc
      .fillColor("#000000")
      .fontSize(9)
      .text(serialNo.toString(), startX + 5, currentY + 6, {
        width: colWidths[0] - 10,
      })
      .text(sku, startX + colWidths[0] + 5, currentY + 6, {
        width: colWidths[1] - 10,
      })
      .text(qty.toString(), startX + colWidths[0] + colWidths[1] + 5, currentY + 6, {
        width: colWidths[2] - 10,
        align: "right",
      });

    currentY += rowHeight;
    serialNo++;
  });

  doc.y = currentY + 10;
}

/**
 * Draws the order details table (one row per item in each order)
 */
function drawOrderDetailsTable(
  doc: InstanceType<typeof PDFDocument>,
  orderDetails: Array<{
    itemSku: string;
    itemQty: number;
    vendor: string;
    orderName: string;
  }>,
) {
  const startX = 40;
  let startY = doc.y;
  const colWidths = [50, 200, 65, 80, 120];
  const rowHeight = 20;
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);

  // Section header
  doc.fontSize(12).fillColor("#FFFFFF").rect(startX, startY, totalWidth, 25).fill("#4472C4");

  doc.fillColor("#FFFFFF").text("Order Wise Detail", startX + 5, startY + 6, { align: "left" });

  startY += 25;

  // Table header
  doc.fontSize(10).rect(startX, startY, totalWidth, rowHeight).fill("#4472C4");

  let currentX = startX;
  doc.fillColor("#FFFFFF").text("Sr. No.", currentX + 5, startY + 5, { width: colWidths[0] - 10 });
  currentX += colWidths[0];
  doc.text("Item SKU", currentX + 5, startY + 5, { width: colWidths[1] - 10 });
  currentX += colWidths[1];
  doc.text("Item Qty", currentX + 5, startY + 5, { width: colWidths[2] - 10 });
  currentX += colWidths[2];
  doc.text("Vendor", currentX + 5, startY + 5, { width: colWidths[3] - 10 });
  currentX += colWidths[3];
  doc.text("Order Name", currentX + 5, startY + 5, {
    width: colWidths[4] - 10,
  });

  let currentY = startY + rowHeight;
  let serialNo = 1;

  // Data rows
  orderDetails.forEach((detail) => {
    // Check if we need a new page
    if (currentY > doc.page.height - 100) {
      doc.addPage();
      currentY = 50;

      // Redraw header on new page
      doc.fontSize(10).rect(startX, currentY, totalWidth, rowHeight).fill("#4472C4");

      let headerX = startX;
      doc.fillColor("#FFFFFF").text("Sr. No.", headerX + 5, currentY + 5, {
        width: colWidths[0] - 10,
      });
      headerX += colWidths[0];
      doc.text("Item SKU", headerX + 5, currentY + 5, {
        width: colWidths[1] - 10,
      });
      headerX += colWidths[1];
      doc.text("Item Qty", headerX + 5, currentY + 5, {
        width: colWidths[2] - 10,
      });
      headerX += colWidths[2];
      doc.text("Vendor", headerX + 5, currentY + 5, {
        width: colWidths[3] - 10,
      });
      headerX += colWidths[3];
      doc.text("Order Name", headerX + 5, currentY + 5, {
        width: colWidths[4] - 10,
      });

      currentY += rowHeight;
    }

    // Draw row border
    doc
      .lineWidth(0.5)
      .strokeColor("#CCCCCC")
      .rect(startX, currentY, totalWidth, rowHeight)
      .stroke();

    // Draw cell content
    doc.fillColor("#000000").fontSize(9);

    currentX = startX;
    doc.text(serialNo.toString(), currentX + 5, currentY + 6, {
      width: colWidths[0] - 10,
    });
    currentX += colWidths[0];
    doc.text(detail.itemSku, currentX + 5, currentY + 6, {
      width: colWidths[1] - 10,
    });
    currentX += colWidths[1];
    doc.text(detail.itemQty.toString(), currentX + 5, currentY + 6, {
      width: colWidths[2] - 10,
    });
    currentX += colWidths[2];
    doc.text(detail.vendor, currentX + 5, currentY + 6, {
      width: colWidths[3] - 10,
    });
    currentX += colWidths[3];
    doc.text(detail.orderName, currentX + 5, currentY + 6, {
      width: colWidths[4] - 10,
    });

    currentY += rowHeight;
    serialNo++;
  });

  doc.y = currentY;
}
