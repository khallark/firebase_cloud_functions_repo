// Daily Tax Report Generation Function
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, storage } from "./firebaseAdmin";
import ExcelJS from "exceljs";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { sendSharedStoreOrdersExcelWhatsAppMessage } from "./whatsappMessagesSendingFuncs";

const SHARED_STORE_ID = "nfkjgp-sv.myshopify.com";
const REPORT_PHONE_NUMBER = "9779752241";

// Status list for Sales Return Report
const RETURN_STATUSES = new Set([
  "RTO Closed",
  "DTO Refunded", 
  "Lost",
  "Cancellation Requested",
  "Cancelled"
]);

interface ProductInfo {
  hsn: string;
  taxRate: number;
}

interface SalesRow {
  srNo: number;
  billNo: string;
  dateOfBill: string;
  customerName: string;
  state: string;
  itemName: string;
  itemQty: number;
  awb: string;
  mrp: number;
  discountLinewise: number;
  salePrice: number;
  hsn: string;
  taxRate: number;
  taxable: number;
  igst: number;
  sgst: number;
  cgst: number;
  vendor: string;
}

interface SalesReturnRow extends SalesRow {
  dateOfReturn: string;
  finalStatus: string;
  refundAmount: number;
}

interface StatePivot {
  state: string;
  // Gross Sales
  grossQty: number;
  grossTaxable: number;
  grossIGST: number;
  grossSGST: number;
  grossCGST: number;
  grossInvoiceAmount: number;
  // Sales Returns
  returnQty: number;
  returnTaxable: number;
  returnIGST: number;
  returnSGST: number;
  returnCGST: number;
  returnInvoiceAmount: number;
  // Net Sales
  netQty: number;
  netTaxable: number;
  netIGST: number;
  netSGST: number;
  netCGST: number;
  netInvoiceAmount: number;
}

interface HSNPivot {
  hsn: string;
  // Gross Sales
  grossQty: number;
  grossTaxable: number;
  grossIGST: number;
  grossSGST: number;
  grossCGST: number;
  grossInvoiceAmount: number;
  // Sales Returns
  returnQty: number;
  returnTaxable: number;
  returnIGST: number;
  returnSGST: number;
  returnCGST: number;
  returnInvoiceAmount: number;
  // Net Sales
  netQty: number;
  netTaxable: number;
  netIGST: number;
  netSGST: number;
  netCGST: number;
  netInvoiceAmount: number;
}

/**
 * Formats a timestamp to DD-MM-YYYY
 */
function formatDate(timestamp: any): string {
  if (!timestamp) return "N/A";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

/**
 * Gets product HSN and Tax Rate from products collection
 */
async function getProductInfo(productTitle: string): Promise<ProductInfo> {
  try {
    const productsSnapshot = await db
      .collection("accounts")
      .doc(SHARED_STORE_ID)
      .collection("products")
      .where("title", "==", productTitle)
      .limit(1)
      .get();

    if (productsSnapshot.empty) {
      return { hsn: "6109", taxRate: 12 };
    }

    const product = productsSnapshot.docs[0].data();
    const metafields = product.metafields || [];

    // Find HSN and Tax Rate in metafields
    let hsn = "6109";
    let taxRate = 12;

    metafields.forEach((metafield: any) => {
      if (metafield.key === "hsn" || metafield.key === "HSN") {
        hsn = String(metafield.value || "6109");
      }
      if (metafield.key === "tax_rate" || metafield.key === "taxRate" || metafield.key === "tax") {
        const rate = Number(metafield.value);
        if (!isNaN(rate) && rate > 0) {
          taxRate = rate;
        }
      }
    });

    return { hsn, taxRate };
  } catch (error) {
    console.error(`Error fetching product info for ${productTitle}:`, error);
    return { hsn: "6109", taxRate: 12 };
  }
}

/**
 * Calculates taxable amount from sale price (inclusive tax)
 */
function calculateTaxable(salePrice: number, taxRate: number): number {
  return Number((salePrice * 100 / (100 + taxRate)).toFixed(2));
}

/**
 * Calculates tax amounts based on state
 */
function calculateTaxes(taxable: number, taxRate: number, state: string): {
  igst: number;
  sgst: number;
  cgst: number;
} {
  const totalTax = Number((taxable * taxRate / 100).toFixed(2));
  
  if (state === "Punjab") {
    return {
      igst: 0,
      sgst: Number((totalTax / 2).toFixed(2)),
      cgst: Number((totalTax / 2).toFixed(2))
    };
  } else {
    return {
      igst: totalTax,
      sgst: 0,
      cgst: 0
    };
  }
}

/**
 * Calculates proportional refund amount for an item
 */
function calculateProportionalRefund(
  order: any,
  item: any
): number {
  const refundedAmount = order?.refundedAmount;
  
  if (refundedAmount === undefined || refundedAmount === null || refundedAmount === "") {
    return 0;
  }

  const refundedAmountNum = Number(refundedAmount);
  if (isNaN(refundedAmountNum) || refundedAmountNum <= 0) {
    return 0;
  }

  // Calculate item's proportion of total order
  const items = order.raw?.line_items || [];
  const orderTotal = items.reduce((sum: number, lineItem: any) => {
    return sum + (Number(lineItem.price) * Number(lineItem.quantity));
  }, 0);

  if (orderTotal === 0) return 0;

  const itemTotal = Number(item.price) * Number(item.quantity);
  const proportion = itemTotal / orderTotal;

  return Number((refundedAmountNum * proportion).toFixed(2));
}

/**
 * Processes sales orders (created on the target date)
 */
async function processSalesOrders(targetDate: Date): Promise<SalesRow[]> {
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  console.log(`📊 Fetching sales orders from ${startOfDay.toISOString()} to ${endOfDay.toISOString()}`);

  const ordersSnapshot = await db
    .collection("accounts")
    .doc(SHARED_STORE_ID)
    .collection("orders")
    .where("createdAt", ">=", Timestamp.fromDate(startOfDay))
    .where("createdAt", "<=", Timestamp.fromDate(endOfDay))
    .get();

  console.log(`Found ${ordersSnapshot.size} sales orders`);

  const salesRows: SalesRow[] = [];
  let srNo = 1;

  for (const orderDoc of ordersSnapshot.docs) {
    const order = orderDoc.data();
    const items = order.raw?.line_items || [];

    for (const item of items) {
      try {
        const customerName = order.raw.customer?.first_name && order.raw.customer?.last_name
          ? `${order.raw.customer.first_name} ${order.raw.customer.last_name}`
          : order.raw.billing_address?.name || order.raw.shipping_address?.name || "N/A";

        const state = String(
          order.raw.shipping_address?.province || 
          order.raw.billing_address?.province || 
          ""
        );

        const itemQty = Number(item.quantity || 0);
        const itemPrice = Number(item.price || 0);
        const mrp = Number((itemQty * itemPrice).toFixed(2));
        const discountLinewise = Number(item.discount_allocations?.[0]?.amount || 0);
        const salePrice = Number((mrp - discountLinewise).toFixed(2));

        // Get HSN and Tax Rate
        const productInfo = await getProductInfo(item.title);
        const taxable = calculateTaxable(salePrice, productInfo.taxRate);
        const taxes = calculateTaxes(taxable, productInfo.taxRate, state);

        salesRows.push({
          srNo: srNo++,
          billNo: String(order.name || ""),
          dateOfBill: formatDate(order.createdAt),
          customerName: String(customerName),
          state: state,
          itemName: String(item.name || ""),
          itemQty: itemQty,
          awb: String(order.awb || "-"),
          mrp: mrp,
          discountLinewise: discountLinewise,
          salePrice: salePrice,
          hsn: String(productInfo.hsn),
          taxRate: Number(productInfo.taxRate),
          taxable: taxable,
          igst: taxes.igst,
          sgst: taxes.sgst,
          cgst: taxes.cgst,
          vendor: String(item.vendor || "")
        });
      } catch (error) {
        console.error(`Error processing item in order ${order.name}:`, error);
      }
    }
  }

  return salesRows;
}

/**
 * Processes sales return orders (status changed to return statuses on target date)
 */
async function processSalesReturnOrders(targetDate: Date): Promise<SalesReturnRow[]> {
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  console.log(`📊 Fetching sales return orders with status changes on ${targetDate.toDateString()}`);

  // Fetch all orders (we need to filter by customStatusesLogs)
  const ordersSnapshot = await db
    .collection("accounts")
    .doc(SHARED_STORE_ID)
    .collection("orders")
    .get();

  console.log(`Scanning ${ordersSnapshot.size} total orders for returns`);

  const salesReturnRows: SalesReturnRow[] = [];
  let srNo = 1;
  let eligibleOrdersCount = 0;

  for (const orderDoc of ordersSnapshot.docs) {
    const order = orderDoc.data();
    const statusLogs = order.customStatusesLogs || [];

    // Find logs from target date with return statuses
    const returnLogs = statusLogs.filter((log: any) => {
      if (!log.createdAt || !log.status) return false;
      
      const logDate = log.createdAt.toDate ? log.createdAt.toDate() : new Date(log.createdAt);
      const logDateOnly = new Date(logDate);
      logDateOnly.setHours(0, 0, 0, 0);
      
      const targetDateOnly = new Date(targetDate);
      targetDateOnly.setHours(0, 0, 0, 0);
      
      return logDateOnly.getTime() === targetDateOnly.getTime() && 
             RETURN_STATUSES.has(log.status);
    });

    if (returnLogs.length === 0) continue;

    eligibleOrdersCount++;
    const items = order.raw?.line_items || [];

    // Use the first return log for date of return
    const dateOfReturn = returnLogs[0].createdAt;

    for (const item of items) {
      try {
        const customerName = order.raw.customer?.first_name && order.raw.customer?.last_name
          ? `${order.raw.customer.first_name} ${order.raw.customer.last_name}`
          : order.raw.billing_address?.name || order.raw.shipping_address?.name || "N/A";

        const state = String(
          order.raw.shipping_address?.province || 
          order.raw.billing_address?.province || 
          ""
        );

        const itemQty = Number(item.quantity || 0);
        const itemPrice = Number(item.price || 0);
        const mrp = Number((itemQty * itemPrice).toFixed(2));
        const discountLinewise = Number(item.discount_allocations?.[0]?.amount || 0);
        const salePrice = Number((mrp - discountLinewise).toFixed(2));

        // Calculate refund amount
        const refundAmount = calculateProportionalRefund(order, item);

        // Get HSN and Tax Rate
        const productInfo = await getProductInfo(item.title);
        
        // Calculate taxable on refund amount instead of sale price
        const taxable = calculateTaxable(refundAmount, productInfo.taxRate);
        const taxes = calculateTaxes(taxable, productInfo.taxRate, state);

        salesReturnRows.push({
          srNo: srNo++,
          billNo: String(order.name || ""),
          dateOfBill: formatDate(order.createdAt),
          dateOfReturn: formatDate(dateOfReturn),
          customerName: String(customerName),
          state: state,
          itemName: String(item.name || ""),
          itemQty: itemQty,
          finalStatus: String(order.customStatus || ""),
          awb: String(order.awb_reverse || order.awb || "-"),
          mrp: mrp,
          discountLinewise: discountLinewise,
          salePrice: salePrice,
          refundAmount: refundAmount,
          hsn: String(productInfo.hsn),
          taxRate: Number(productInfo.taxRate),
          taxable: taxable,
          igst: taxes.igst,
          sgst: taxes.sgst,
          cgst: taxes.cgst,
          vendor: String(item.vendor || "")
        });
      } catch (error) {
        console.error(`Error processing return item in order ${order.name}:`, error);
      }
    }
  }

  console.log(`Found ${eligibleOrdersCount} eligible return orders`);

  return salesReturnRows;
}

/**
 * Generates state-wise pivot data
 */
function generateStatePivot(
  salesRows: SalesRow[],
  returnRows: SalesReturnRow[]
): StatePivot[] {
  const stateMap = new Map<string, StatePivot>();

  // Process sales data
  salesRows.forEach(row => {
    const state = row.state || "Unknown";
    
    if (!stateMap.has(state)) {
      stateMap.set(state, {
        state,
        grossQty: 0, grossTaxable: 0, grossIGST: 0, grossSGST: 0, grossCGST: 0, grossInvoiceAmount: 0,
        returnQty: 0, returnTaxable: 0, returnIGST: 0, returnSGST: 0, returnCGST: 0, returnInvoiceAmount: 0,
        netQty: 0, netTaxable: 0, netIGST: 0, netSGST: 0, netCGST: 0, netInvoiceAmount: 0
      });
    }

    const pivot = stateMap.get(state)!;
    pivot.grossQty += Number(row.itemQty);
    pivot.grossTaxable += Number(row.taxable);
    pivot.grossIGST += Number(row.igst);
    pivot.grossSGST += Number(row.sgst);
    pivot.grossCGST += Number(row.cgst);
    pivot.grossInvoiceAmount += Number(row.salePrice);
  });

  // Process return data
  returnRows.forEach(row => {
    const state = row.state || "Unknown";
    
    if (!stateMap.has(state)) {
      stateMap.set(state, {
        state,
        grossQty: 0, grossTaxable: 0, grossIGST: 0, grossSGST: 0, grossCGST: 0, grossInvoiceAmount: 0,
        returnQty: 0, returnTaxable: 0, returnIGST: 0, returnSGST: 0, returnCGST: 0, returnInvoiceAmount: 0,
        netQty: 0, netTaxable: 0, netIGST: 0, netSGST: 0, netCGST: 0, netInvoiceAmount: 0
      });
    }

    const pivot = stateMap.get(state)!;
    pivot.returnQty += Number(row.itemQty);
    pivot.returnTaxable += Number(row.taxable);
    pivot.returnIGST += Number(row.igst);
    pivot.returnSGST += Number(row.sgst);
    pivot.returnCGST += Number(row.cgst);
    pivot.returnInvoiceAmount += Number(row.refundAmount);
  });

  // Calculate net sales
  const pivotArray = Array.from(stateMap.values());
  pivotArray.forEach(pivot => {
    pivot.netQty = Number((pivot.grossQty - pivot.returnQty).toFixed(2));
    pivot.netTaxable = Number((pivot.grossTaxable - pivot.returnTaxable).toFixed(2));
    pivot.netIGST = Number((pivot.grossIGST - pivot.returnIGST).toFixed(2));
    pivot.netSGST = Number((pivot.grossSGST - pivot.returnSGST).toFixed(2));
    pivot.netCGST = Number((pivot.grossCGST - pivot.returnCGST).toFixed(2));
    pivot.netInvoiceAmount = Number((pivot.grossInvoiceAmount - pivot.returnInvoiceAmount).toFixed(2));
  });

  return pivotArray.sort((a, b) => a.state.localeCompare(b.state));
}

/**
 * Generates HSN-wise pivot data
 */
function generateHSNPivot(
  salesRows: SalesRow[],
  returnRows: SalesReturnRow[]
): HSNPivot[] {
  const hsnMap = new Map<string, HSNPivot>();

  // Process sales data
  salesRows.forEach(row => {
    const hsn = row.hsn || "Unknown";
    
    if (!hsnMap.has(hsn)) {
      hsnMap.set(hsn, {
        hsn,
        grossQty: 0, grossTaxable: 0, grossIGST: 0, grossSGST: 0, grossCGST: 0, grossInvoiceAmount: 0,
        returnQty: 0, returnTaxable: 0, returnIGST: 0, returnSGST: 0, returnCGST: 0, returnInvoiceAmount: 0,
        netQty: 0, netTaxable: 0, netIGST: 0, netSGST: 0, netCGST: 0, netInvoiceAmount: 0
      });
    }

    const pivot = hsnMap.get(hsn)!;
    pivot.grossQty += Number(row.itemQty);
    pivot.grossTaxable += Number(row.taxable);
    pivot.grossIGST += Number(row.igst);
    pivot.grossSGST += Number(row.sgst);
    pivot.grossCGST += Number(row.cgst);
    pivot.grossInvoiceAmount += Number(row.salePrice);
  });

  // Process return data
  returnRows.forEach(row => {
    const hsn = row.hsn || "Unknown";
    
    if (!hsnMap.has(hsn)) {
      hsnMap.set(hsn, {
        hsn,
        grossQty: 0, grossTaxable: 0, grossIGST: 0, grossSGST: 0, grossCGST: 0, grossInvoiceAmount: 0,
        returnQty: 0, returnTaxable: 0, returnIGST: 0, returnSGST: 0, returnCGST: 0, returnInvoiceAmount: 0,
        netQty: 0, netTaxable: 0, netIGST: 0, netSGST: 0, netCGST: 0, netInvoiceAmount: 0
      });
    }

    const pivot = hsnMap.get(hsn)!;
    pivot.returnQty += Number(row.itemQty);
    pivot.returnTaxable += Number(row.taxable);
    pivot.returnIGST += Number(row.igst);
    pivot.returnSGST += Number(row.sgst);
    pivot.returnCGST += Number(row.cgst);
    pivot.returnInvoiceAmount += Number(row.refundAmount);
  });

  // Calculate net sales
  const pivotArray = Array.from(hsnMap.values());
  pivotArray.forEach(pivot => {
    pivot.netQty = Number((pivot.grossQty - pivot.returnQty).toFixed(2));
    pivot.netTaxable = Number((pivot.grossTaxable - pivot.returnTaxable).toFixed(2));
    pivot.netIGST = Number((pivot.grossIGST - pivot.returnIGST).toFixed(2));
    pivot.netSGST = Number((pivot.grossSGST - pivot.returnSGST).toFixed(2));
    pivot.netCGST = Number((pivot.grossCGST - pivot.returnCGST).toFixed(2));
    pivot.netInvoiceAmount = Number((pivot.grossInvoiceAmount - pivot.returnInvoiceAmount).toFixed(2));
  });

  return pivotArray.sort((a, b) => a.hsn.localeCompare(b.hsn));
}

/**
 * Creates Excel workbook with all sheets
 */
async function createExcelWorkbook(
  salesRows: SalesRow[],
  returnRows: SalesReturnRow[],
  statePivot: StatePivot[],
  hsnPivot: HSNPivot[]
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();

  // Sheet 1: Sales Report
  const salesSheet = workbook.addWorksheet("Sales Report");
  salesSheet.columns = [
    { header: "Sr. No.", key: "srNo", width: 10 },
    { header: "Bill No.", key: "billNo", width: 15 },
    { header: "Date of Bill", key: "dateOfBill", width: 15 },
    { header: "Name of customer", key: "customerName", width: 25 },
    { header: "State", key: "state", width: 20 },
    { header: "Item Name", key: "itemName", width: 30 },
    { header: "Item Qty", key: "itemQty", width: 10 },
    { header: "AWB", key: "awb", width: 20 },
    { header: "MRP", key: "mrp", width: 12 },
    { header: "Discount Line wise", key: "discountLinewise", width: 18 },
    { header: "Sale Price", key: "salePrice", width: 12 },
    { header: "HSN", key: "hsn", width: 10 },
    { header: "Tax Rate", key: "taxRate", width: 10 },
    { header: "Taxable", key: "taxable", width: 12 },
    { header: "IGST", key: "igst", width: 12 },
    { header: "SGST", key: "sgst", width: 12 },
    { header: "CGST", key: "cgst", width: 12 },
    { header: "Vendor", key: "vendor", width: 20 }
  ];

  salesRows.forEach(row => salesSheet.addRow(row));

  // Style header
  salesSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  salesSheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF4472C4" }
  };
  salesSheet.getRow(1).alignment = { vertical: "middle", horizontal: "center" };

  // Sheet 2: Sales Return Report
  const returnSheet = workbook.addWorksheet("Sales Return Report");
  returnSheet.columns = [
    { header: "Sr. No.", key: "srNo", width: 10 },
    { header: "Bill No.", key: "billNo", width: 15 },
    { header: "Date of Bill", key: "dateOfBill", width: 15 },
    { header: "Date of Return", key: "dateOfReturn", width: 15 },
    { header: "Name of customer", key: "customerName", width: 25 },
    { header: "State", key: "state", width: 20 },
    { header: "Item Name", key: "itemName", width: 30 },
    { header: "Item Qty", key: "itemQty", width: 10 },
    { header: "Final Status", key: "finalStatus", width: 20 },
    { header: "AWB", key: "awb", width: 20 },
    { header: "MRP", key: "mrp", width: 12 },
    { header: "Discount Line wise", key: "discountLinewise", width: 18 },
    { header: "Sale Price", key: "salePrice", width: 12 },
    { header: "Refund/Sale Return Amount", key: "refundAmount", width: 25 },
    { header: "HSN", key: "hsn", width: 10 },
    { header: "Tax Rate", key: "taxRate", width: 10 },
    { header: "Taxable", key: "taxable", width: 12 },
    { header: "IGST", key: "igst", width: 12 },
    { header: "SGST", key: "sgst", width: 12 },
    { header: "CGST", key: "cgst", width: 12 },
    { header: "Vendor", key: "vendor", width: 20 }
  ];

  returnRows.forEach(row => returnSheet.addRow(row));

  // Style header
  returnSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  returnSheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF4472C4" }
  };
  returnSheet.getRow(1).alignment = { vertical: "middle", horizontal: "center" };

  // Sheet 3: State Wise Tax Report
  const stateSheet = workbook.addWorksheet("State Wise Tax Report");
  
  // Create multi-level headers
  stateSheet.mergeCells("A1:A2");
  stateSheet.getCell("A1").value = "State";
  
  stateSheet.mergeCells("B1:G1");
  stateSheet.getCell("B1").value = "Gross Sales";
  
  stateSheet.mergeCells("H1:M1");
  stateSheet.getCell("H1").value = "Refund/Sale Return Amount";
  
  stateSheet.mergeCells("N1:S1");
  stateSheet.getCell("N1").value = "Net Sales";
  
  // Sub-headers row 2
  const subHeaders = ["Qty", "Taxable Sales", "IGST", "SGST", "CGST", "Invoice Amount"];
  
  let col = 2; // Column B
  subHeaders.forEach(header => {
    stateSheet.getCell(2, col++).value = header;
  });
  
  subHeaders.forEach(header => {
    stateSheet.getCell(2, col++).value = header;
  });
  
  subHeaders.forEach(header => {
    stateSheet.getCell(2, col++).value = header;
  });

  // Style headers
  [1, 2].forEach(rowNum => {
    const row = stateSheet.getRow(rowNum);
    row.font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF4472C4" }
    };
    row.alignment = { vertical: "middle", horizontal: "center" };
  });

  // Add data rows
  let currentRow = 3;
  statePivot.forEach(pivot => {
    stateSheet.getCell(currentRow, 1).value = pivot.state;
    stateSheet.getCell(currentRow, 2).value = pivot.grossQty;
    stateSheet.getCell(currentRow, 3).value = pivot.grossTaxable;
    stateSheet.getCell(currentRow, 4).value = pivot.grossIGST;
    stateSheet.getCell(currentRow, 5).value = pivot.grossSGST;
    stateSheet.getCell(currentRow, 6).value = pivot.grossCGST;
    stateSheet.getCell(currentRow, 7).value = pivot.grossInvoiceAmount;
    stateSheet.getCell(currentRow, 8).value = pivot.returnQty;
    stateSheet.getCell(currentRow, 9).value = pivot.returnTaxable;
    stateSheet.getCell(currentRow, 10).value = pivot.returnIGST;
    stateSheet.getCell(currentRow, 11).value = pivot.returnSGST;
    stateSheet.getCell(currentRow, 12).value = pivot.returnCGST;
    stateSheet.getCell(currentRow, 13).value = pivot.returnInvoiceAmount;
    stateSheet.getCell(currentRow, 14).value = pivot.netQty;
    stateSheet.getCell(currentRow, 15).value = pivot.netTaxable;
    stateSheet.getCell(currentRow, 16).value = pivot.netIGST;
    stateSheet.getCell(currentRow, 17).value = pivot.netSGST;
    stateSheet.getCell(currentRow, 18).value = pivot.netCGST;
    stateSheet.getCell(currentRow, 19).value = pivot.netInvoiceAmount;
    currentRow++;
  });

  // Add grand total row
  const totalRow = currentRow;
  stateSheet.getCell(totalRow, 1).value = "Grand Total";
  stateSheet.getCell(totalRow, 1).font = { bold: true };
  
  for (let col = 2; col <= 19; col++) {
    let sum = 0;
    for (let row = 3; row < totalRow; row++) {
      sum += Number(stateSheet.getCell(row, col).value || 0);
    }
    stateSheet.getCell(totalRow, col).value = Number(sum.toFixed(2));
    stateSheet.getCell(totalRow, col).font = { bold: true };
  }

  // Sheet 4: HSN Wise Tax Report
  const hsnSheet = workbook.addWorksheet("HSN Wise Tax Report");
  
  // Create multi-level headers (same structure as state sheet)
  hsnSheet.mergeCells("A1:A2");
  hsnSheet.getCell("A1").value = "HSN";
  
  hsnSheet.mergeCells("B1:G1");
  hsnSheet.getCell("B1").value = "Gross Sales";
  
  hsnSheet.mergeCells("H1:M1");
  hsnSheet.getCell("H1").value = "Refund/Sale Return Amount";
  
  hsnSheet.mergeCells("N1:S1");
  hsnSheet.getCell("N1").value = "Net Sales";
  
  // Sub-headers row 2
  col = 2;
  subHeaders.forEach(header => {
    hsnSheet.getCell(2, col++).value = header;
  });
  
  subHeaders.forEach(header => {
    hsnSheet.getCell(2, col++).value = header;
  });
  
  subHeaders.forEach(header => {
    hsnSheet.getCell(2, col++).value = header;
  });

  // Style headers
  [1, 2].forEach(rowNum => {
    const row = hsnSheet.getRow(rowNum);
    row.font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF4472C4" }
    };
    row.alignment = { vertical: "middle", horizontal: "center" };
  });

  // Add data rows
  currentRow = 3;
  hsnPivot.forEach(pivot => {
    hsnSheet.getCell(currentRow, 1).value = pivot.hsn;
    hsnSheet.getCell(currentRow, 2).value = pivot.grossQty;
    hsnSheet.getCell(currentRow, 3).value = pivot.grossTaxable;
    hsnSheet.getCell(currentRow, 4).value = pivot.grossIGST;
    hsnSheet.getCell(currentRow, 5).value = pivot.grossSGST;
    hsnSheet.getCell(currentRow, 6).value = pivot.grossCGST;
    hsnSheet.getCell(currentRow, 7).value = pivot.grossInvoiceAmount;
    hsnSheet.getCell(currentRow, 8).value = pivot.returnQty;
    hsnSheet.getCell(currentRow, 9).value = pivot.returnTaxable;
    hsnSheet.getCell(currentRow, 10).value = pivot.returnIGST;
    hsnSheet.getCell(currentRow, 11).value = pivot.returnSGST;
    hsnSheet.getCell(currentRow, 12).value = pivot.returnCGST;
    hsnSheet.getCell(currentRow, 13).value = pivot.returnInvoiceAmount;
    hsnSheet.getCell(currentRow, 14).value = pivot.netQty;
    hsnSheet.getCell(currentRow, 15).value = pivot.netTaxable;
    hsnSheet.getCell(currentRow, 16).value = pivot.netIGST;
    hsnSheet.getCell(currentRow, 17).value = pivot.netSGST;
    hsnSheet.getCell(currentRow, 18).value = pivot.netCGST;
    hsnSheet.getCell(currentRow, 19).value = pivot.netInvoiceAmount;
    currentRow++;
  });

  // Add grand total row
  const hsnTotalRow = currentRow;
  hsnSheet.getCell(hsnTotalRow, 1).value = "Grand Total";
  hsnSheet.getCell(hsnTotalRow, 1).font = { bold: true };
  
  for (let col = 2; col <= 19; col++) {
    let sum = 0;
    for (let row = 3; row < hsnTotalRow; row++) {
      sum += Number(hsnSheet.getCell(row, col).value || 0);
    }
    hsnSheet.getCell(hsnTotalRow, col).value = Number(sum.toFixed(2));
    hsnSheet.getCell(hsnTotalRow, col).font = { bold: true };
  }

  return workbook;
}

/**
 * Main scheduled function - runs daily at 12:00 AM
 */
export const generateDailyTaxReport = onSchedule(
  {
    schedule: "0 0 * * *", // 12:00 AM daily
    timeZone: "Asia/Kolkata",
    region: process.env.LOCATION || "asia-south1",
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
      
      console.log(`📅 Generating report for: ${yesterday.toDateString()}`);

      // Step 1: Process Sales Orders
      console.log("\n📊 Step 1: Processing Sales Orders...");
      const salesRows = await processSalesOrders(yesterday);
      console.log(`✅ Processed ${salesRows.length} sales line items`);

      // Step 2: Process Sales Return Orders
      console.log("\n📊 Step 2: Processing Sales Return Orders...");
      const returnRows = await processSalesReturnOrders(yesterday);
      console.log(`✅ Processed ${returnRows.length} return line items`);

      // Step 3: Generate State Pivot
      console.log("\n📊 Step 3: Generating State Wise Report...");
      const statePivot = generateStatePivot(salesRows, returnRows);
      console.log(`✅ Generated data for ${statePivot.length} states`);

      // Step 4: Generate HSN Pivot
      console.log("\n📊 Step 4: Generating HSN Wise Report...");
      const hsnPivot = generateHSNPivot(salesRows, returnRows);
      console.log(`✅ Generated data for ${hsnPivot.length} HSN codes`);

      // Step 5: Create Excel Workbook
      console.log("\n📊 Step 5: Creating Excel Workbook...");
      const workbook = await createExcelWorkbook(salesRows, returnRows, statePivot, hsnPivot);
      console.log("✅ Excel workbook created");

      // Step 6: Upload to Firebase Storage
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

      // Step 7: Send WhatsApp Message
      console.log("\n📊 Step 7: Sending WhatsApp Message...");
      const shopDoc = await db.collection("accounts").doc(SHARED_STORE_ID).get();
      const shopData = shopDoc.data();

      if (shopData) {
        await sendSharedStoreOrdersExcelWhatsAppMessage(
          shopData,
          downloadUrl,
          REPORT_PHONE_NUMBER
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
  }
);