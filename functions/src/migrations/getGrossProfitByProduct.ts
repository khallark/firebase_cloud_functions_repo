import { onRequest } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { SHARED_STORE_IDS } from "../config";
import { db } from "../firebaseAdmin";

interface ProductLineItem {
  sku: string;
  quantity: number;
}

interface ProductOrderEntry {
  orderName: string;
  lineItems: ProductLineItem[];
}

interface ProductResult {
  productId: string;
  openingStockQty: number;
  closingStockQty: number;
  saleQty: number;
  saleReturnQty: number;
  purchaseQty: number;
  grossProfitQty: number; // sale - saleReturn - purchase - openingStock + closingStock
  saleOrders: ProductOrderEntry[];
  saleReturnOrders: ProductOrderEntry[];
}

export const getGrossProfitByProduct = onRequest(
  { cors: true, timeoutSeconds: 540, memory: "2GiB" },
  async (req, res) => {
    const businessId = (req.query.businessId as string) || req.body?.businessId;
    const startDate = (req.query.startDate as string) || req.body?.startDate; // YYYY-MM-DD
    const endDate = (req.query.endDate as string) || req.body?.endDate;

    if (!businessId || !startDate || !endDate) {
      res.status(400).json({ error: "businessId, startDate, endDate are required" });
      return;
    }

    const startTs = Timestamp.fromDate(new Date(`${startDate}T00:00:00+05:30`));
    const endTs = Timestamp.fromDate(new Date(`${endDate}T23:59:59+05:30`));

    // ── 1. Derive opening snapshot date (startDate - 1 day) ──────────────────
    const openingDate = (() => {
      const d = new Date(`${startDate}T00:00:00`);
      d.setDate(d.getDate() - 1);
      return d.toISOString().split("T")[0];
    })();

    // ── 2. Fetch opening & closing inventory snapshots + GRNs in parallel ────
    const [openingSnap, closingSnap, grnSnap] = await Promise.all([
      db
        .collection("users")
        .doc(businessId)
        .collection("inventory_snapshots")
        .where("date", "==", openingDate)
        .get(),
      db
        .collection("users")
        .doc(businessId)
        .collection("inventory_snapshots")
        .where("date", "==", endDate)
        .get(),
      db
        .collection("users")
        .doc(businessId)
        .collection("grns")
        .where("completedAt", ">=", startTs)
        .where("completedAt", "<=", endTs)
        .get(),
    ]);

    const openingByProduct = new Map<string, number>();
    for (const doc of openingSnap.docs) {
      const data = doc.data();
      const productId = data.productId as string;
      if (!productId) continue;
      const qty =
        Number(data.stockLevel ?? 0) - Number(data.exactDocState?.inventory?.blockedStock ?? 0);
      openingByProduct.set(productId, (openingByProduct.get(productId) ?? 0) + qty);
    }

    const closingByProduct = new Map<string, number>();
    for (const doc of closingSnap.docs) {
      const data = doc.data();
      const productId = data.productId as string;
      if (!productId) continue;
      const qty =
        Number(data.stockLevel ?? 0) - Number(data.exactDocState?.inventory?.blockedStock ?? 0);
      closingByProduct.set(productId, (closingByProduct.get(productId) ?? 0) + qty);
    }

    // GRN items: sku == productId, direct match
    const purchaseByProduct = new Map<string, number>();
    for (const doc of grnSnap.docs) {
      const grn = doc.data();
      for (const item of grn.items ?? []) {
        const productId = item.sku as string;
        if (!productId) continue;
        const qty = Number(item.receivedQty ?? 0);
        purchaseByProduct.set(productId, (purchaseByProduct.get(productId) ?? 0) + qty);
      }
    }

    const allProductIds = new Set<string>([
      ...openingByProduct.keys(),
      ...closingByProduct.keys(),
      ...purchaseByProduct.keys(),
    ]);

    // ── 3. Fetch sale orders ──────────────────────────────────────────────────
    const saleOrders: any[] = [];
    const seenSaleIds = new Set<string>();

    await Promise.all(
      SHARED_STORE_IDS.map(async (storeId) => {
        const snap = await db
          .collection("accounts")
          .doc(storeId)
          .collection("orders")
          .where("createdAt", ">=", `${startDate}T00:00:00+05:30`)
          .where("createdAt", "<=", `${endDate}T23:59:59+05:30`)
          .get();
        snap.forEach((doc) => {
          if (seenSaleIds.has(doc.id)) return;
          seenSaleIds.add(doc.id);
          saleOrders.push({ _docId: doc.id, ...doc.data() });
        });
      }),
    );

    // ── 4. Fetch sale return orders ───────────────────────────────────────────
    const returnOrders: any[] = [];
    const seenReturnIds = new Set<string>();

    await Promise.all(
      SHARED_STORE_IDS.map(async (storeId) => {
        const baseQuery = db.collection("accounts").doc(storeId).collection("orders");

        const [rtoSnap, pendingRefundsSnap, cancellationSnap, cancelledSnap] = await Promise.all([
          baseQuery
            .where("customStatus", "==", "RTO Closed")
            .where("lastStatusUpdate", ">=", startTs)
            .where("lastStatusUpdate", "<=", endTs)
            .get(),
          baseQuery
            .where("pendingRefundsAt", ">=", startTs)
            .where("pendingRefundsAt", "<=", endTs)
            .get(),
          baseQuery
            .where("cancellationRequestedAt", ">=", startTs)
            .where("cancellationRequestedAt", "<=", endTs)
            .get(),
          baseQuery
            .where("customStatus", "==", "Cancelled")
            .where("lastStatusUpdate", ">=", startTs)
            .where("lastStatusUpdate", "<=", endTs)
            .get(),
        ]);

        for (const snap of [rtoSnap, pendingRefundsSnap, cancellationSnap]) {
          for (const doc of snap.docs) {
            if (seenReturnIds.has(doc.id)) continue;
            seenReturnIds.add(doc.id);
            returnOrders.push({ _docId: doc.id, ...doc.data() });
          }
        }

        // Cancelled: only fall back to lastStatusUpdate if cancellationRequestedAt is absent
        for (const doc of cancelledSnap.docs) {
          if (seenReturnIds.has(doc.id)) continue;
          const cancelReqAt = doc.data().cancellationRequestedAt as Timestamp | undefined;
          if (cancelReqAt) continue;
          seenReturnIds.add(doc.id);
          returnOrders.push({ _docId: doc.id, ...doc.data() });
        }
      }),
    );

    // ── 5. SKU → productId matcher ────────────────────────────────────────────
    const findProductId = (sku: string): string | null => {
      const skuLower = sku.toLowerCase();
      for (const productId of allProductIds) {
        if (productId.toLowerCase().includes(skuLower)) return productId;
      }
      return null;
    };

    // ── 6. Initialize product result map ─────────────────────────────────────
    const productMap = new Map<string, ProductResult>();

    const getOrCreate = (productId: string): ProductResult => {
      if (!productMap.has(productId)) {
        productMap.set(productId, {
          productId,
          openingStockQty: openingByProduct.get(productId) ?? 0,
          closingStockQty: closingByProduct.get(productId) ?? 0,
          purchaseQty: purchaseByProduct.get(productId) ?? 0,
          saleQty: 0,
          saleReturnQty: 0,
          grossProfitQty: 0,
          saleOrders: [],
          saleReturnOrders: [],
        });
      }
      return productMap.get(productId)!;
    };

    for (const productId of allProductIds) getOrCreate(productId);

    // ── 7. Process sale orders ────────────────────────────────────────────────
    const EXCLUDED_VENDORS = ["ENDORA", "STYLE 05"];

    for (const order of saleOrders) {
      const vendors: string[] = order.vendors ?? [];
      if (vendors.length === 1 && vendors.some((v) => EXCLUDED_VENDORS.includes(v))) continue;

      const productHits = new Map<string, ProductLineItem[]>();

      for (const item of order?.raw?.line_items ?? []) {
        const sku = item.sku ?? "";
        if (!sku) continue;
        const productId = findProductId(sku);
        if (!productId) {
          console.log(`UNMATCHED SKU: ${sku} in order ${order.name}`);
          continue;
        }
        console.log(`SKU: ${sku} → ${productId}`); // ← add this
        if (!productId) continue;
        const qty = Number(item.quantity ?? 0);
        if (!productHits.has(productId)) productHits.set(productId, []);
        productHits.get(productId)!.push({ sku, quantity: qty });
      }

      for (const [productId, items] of productHits) {
        const result = getOrCreate(productId);
        result.saleQty += items.reduce((s, i) => s + i.quantity, 0);
        result.saleOrders.push({ orderName: order.name ?? order._docId, lineItems: items });
      }
    }

    // ── 8. Process sale return orders ─────────────────────────────────────────
    const QC_FILTERED_STATUSES = ["Pending Refunds", "DTO Refunded"];

    for (const order of returnOrders) {
      const vendors: string[] = order.vendors ?? [];
      if (vendors.length === 1 && vendors.some((v) => EXCLUDED_VENDORS.includes(v))) continue;

      const isQcFiltered = QC_FILTERED_STATUSES.includes(order.customStatus);
      const productHits = new Map<string, ProductLineItem[]>();

      for (const item of order?.raw?.line_items ?? []) {
        const sku = item.sku ?? "";
        if (!sku) continue;
        if (isQcFiltered && item.qc_status !== "QC Pass") continue;
        const productId = findProductId(sku);
        if (!productId) continue;
        const qty = Number(item.quantity ?? 0);
        if (!productHits.has(productId)) productHits.set(productId, []);
        productHits.get(productId)!.push({ sku, quantity: qty });
      }

      for (const [productId, items] of productHits) {
        const result = getOrCreate(productId);
        result.saleReturnQty += items.reduce((s, i) => s + i.quantity, 0);
        result.saleReturnOrders.push({ orderName: order.name ?? order._docId, lineItems: items });
      }
    }

    // ── 9. Compute grossProfitQty and return ──────────────────────────────────
    const results = [...productMap.values()]
      .map((r) => ({
        ...r,
        grossProfitQty:
          r.saleQty - r.saleReturnQty - r.purchaseQty - r.openingStockQty + r.closingStockQty,
      }))
      .sort((a, b) => a.productId.localeCompare(b.productId));

    res.status(200).json({
      total: results.length,
      openingDate,
      closingDate: endDate,
      products: results,
    });
  },
);
