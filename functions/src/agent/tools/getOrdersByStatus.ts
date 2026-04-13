import { db, storage } from '../../firebaseAdmin';
import { Timestamp } from 'firebase-admin/firestore';
import { toCamelCase } from '../../helpers';
import ExcelJS from 'exceljs';

export async function getOrdersByStatus(params: {
  businessId: string;
  status: string;
  dateRange: {
    startDate: string;
    endDate: string;
  };
  limit: number;
}): Promise<{ downloadUrl: string; count: number }> {
  try {
    // ── Validate ──────────────────────────────────────────────────────────────
    if (!params.businessId?.trim()) throw new Error('Missing businessId');
    if (!params.status?.trim()) throw new Error('Missing status');
    if (!params.dateRange?.startDate || !params.dateRange?.endDate) {
      throw new Error('Missing dateRange');
    }

    const startTs = Timestamp.fromDate(new Date(`${params.dateRange.startDate}T00:00:00+05:30`));
    const endTs = Timestamp.fromDate(new Date(`${params.dateRange.endDate}T23:59:59+05:30`));

    if (isNaN(startTs.toDate().getTime()) || isNaN(endTs.toDate().getTime())) {
      throw new Error('Invalid dateRange — could not parse dates');
    }

    // ── Fetch stores ──────────────────────────────────────────────────────────
    const businessDoc = await db.collection('users').doc(params.businessId).get();
    if (!businessDoc.exists) throw new Error(`Business ${params.businessId} not found`);

    const stores: string[] = businessDoc.data()?.stores ?? [];
    if (stores.length === 0) return { downloadUrl: '', count: 0 };

    // ── Query each store using the status timestamp field ─────────────────────
    const statusField = `${toCamelCase(params.status)}At`; // e.g. "readyToDispatchAt"

    interface OrderRow {
      orderName: string;
      status: string;
      dateTime: string; // formatted IST
    }

    const rows: OrderRow[] = [];

    const formatIST = (ts: Timestamp): string => {
      return ts.toDate().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    };

    await Promise.all(
      stores.map(async (storeId) => {
        const snap = await db
          .collection('accounts')
          .doc(storeId)
          .collection('orders')
          .where(statusField, '>=', startTs)
          .where(statusField, '<=', endTs)
          .get();

        snap.docs.forEach((doc) => {
          const data = doc.data();
          if (!data.name) return;

          const ts: Timestamp | undefined = data[statusField];
          rows.push({
            orderName: String(data.name),
            status: params.status,
            dateTime: ts ? formatIST(ts) : '',
          });
        });
      })
    );

    // Sort by dateTime ascending, then apply limit
    rows.sort((a, b) => a.dateTime.localeCompare(b.dateTime));
    const limited = rows.slice(0, params.limit);

    // ── Build Excel ───────────────────────────────────────────────────────────
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Orders');

    sheet.columns = [
      { header: 'Sr. No.', key: 'srNo', width: 10 },
      { header: 'Order Name', key: 'orderName', width: 18 },
      { header: 'Status', key: 'status', width: 25 },
      { header: 'Date & Time (IST)', key: 'dateTime', width: 25 },
    ];

    // Style header
    const headerRow = sheet.getRow(1);
    for (let col = 1; col <= 4; col++) {
      const cell = headerRow.getCell(col);
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' },
      };
    }

    limited.forEach((row, i) => {
      sheet.addRow({ srNo: i + 1, ...row });
    });

    // Side borders on data rows
    for (let row = 2; row <= limited.length + 1; row++) {
      for (let col = 1; col <= 4; col++) {
        const cell = sheet.getCell(row, col);
        cell.border = { left: { style: 'thin' }, right: { style: 'thin' } };
        if (row === limited.length + 1) cell.border.bottom = { style: 'thin' };
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();

    // ── Upload to Firebase Storage ────────────────────────────────────────────
    const fileName = `${toCamelCase(params.status)}_orders_${params.dateRange.startDate}_to_${params.dateRange.endDate}_${Date.now()}.xlsx`;
    const filePath = `majime_agent/getOrdersByStatus/${params.businessId}/${fileName}`;

    const bucket = storage.bucket();
    const file = bucket.file(filePath);

    await file.save(Buffer.from(buffer), {
      metadata: { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    });

    await file.makePublic();
    const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

    console.log(`✅ getOrdersByStatus: ${limited.length} orders → ${filePath}`);

    return { downloadUrl, count: limited.length };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ getOrdersByStatus failed:`, message);
    throw new Error(message);
  }
}