import { onRequest } from "firebase-functions/v2/https";
import { SHARED_STORE_IDS } from "../config";
import { db } from "../firebaseAdmin";
import { Timestamp } from "firebase-admin/firestore";

export const getPendingRefundsWithUpcLogs = onRequest(
  { cors: true, timeoutSeconds: 3600, memory: "2GiB" },
  async (req, res) => {
    const businessId = (req.query.businessId as string) || req.body?.businessId;

    if (!businessId) {
      res.status(400).json({ error: "businessId is required" });
      return;
    }

    // ── 1. Fetch all Pending Refunds and DTO Refunded orders ─────────────────
    const allOrders: any[] = [];
    const seenIds = new Set<string>();

    await Promise.all(
      SHARED_STORE_IDS.map(async (storeId) => {
        const snap = await db
          .collection("accounts")
          .doc(storeId)
          .collection("orders")
          .where("customStatus", "in", ["RTO Closed"])
          .get();

        snap.forEach((doc) => {
          if (seenIds.has(doc.id)) return;
          seenIds.add(doc.id);
          allOrders.push({ id: doc.id, storeId, ...doc.data() });
        });
      }),
    );

    console.log(`📦 Total orders: ${allOrders.length}`);

    // ── 2. Fetch all upcsLogs for each order in parallel ─────────────────────
    const results = await Promise.all(
      allOrders.map(async (order) => {
        const orderId = String(order.orderId);

        const upcLogsSnap = await db
          .collection(`users/${businessId}/upcsLogs`)
          .where("snapshot.orderId", "==", orderId)
          .get();

        const upcLogs = upcLogsSnap.docs.map((doc) => {
          return {
            ...doc.data(),
            timestamp: doc.data()?.timestamp?.toDate()?.toDateString() ?? "abcd",
          };
        });

        const lineItems = (order.raw?.line_items || []).map((item: any) => ({
          sku: item.sku ?? null,
          //   qc_status: String(item.qc_status),
          quantity: item.quantity ?? null,
        }));

        return {
          orderId: order.id,
          lastStatusUpdate:
            (order.lastStatusUpdate as Timestamp | undefined)?.toDate()?.toDateString() ?? "abcd",
          orderName: order.name ?? order.id,
          storeId: order.storeId,
          customStatus: order.customStatus,
          lineItems,
          upcLogs,
        };
      }),
    );

    res.status(200).json({
      total: results.length,
      orders: results,
    });
  },
);
