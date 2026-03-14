import { onRequest } from "firebase-functions/v2/https";
import { SHARED_STORE_IDS } from "../config";
import { db } from "../firebaseAdmin";

export const findOrdersMissingQcStatus = onRequest(
  { cors: true, memory: "4GiB", timeoutSeconds: 540 },
  async (req, res) => {
    const allOrders: any[] = [];
    const seenIds = new Set<string>();

    await Promise.all(
      SHARED_STORE_IDS.map(async (storeId) => {
        const snap = await db
          .collection("accounts")
          .doc(storeId)
          .collection("orders")
          .where("customStatus", "in", ["Pending Refunds", "DTO Refunded"])
          .get();

        snap.forEach((doc) => {
          if (seenIds.has(doc.id)) return;
          seenIds.add(doc.id);
          allOrders.push({ id: doc.id, storeId, ...doc.data() });
        });
      }),
    );

    const results = allOrders
      .filter((order) => {
        const lineItems: any[] = order.raw?.line_items || [];
        return lineItems.some((item) => !item.qc_status);
      })
      .map((order) => ({
        orderId: order.id,
        orderName: order.name ?? order.id,
        storeId: order.storeId,
        customStatus: order.customStatus,
        lineItems: (order.raw?.line_items || []).map((item: any) => ({
          sku: item.sku,
          name: item.name,
          qc_status: item.qc_status ?? null,
          hasQcStatus: "qc_status" in item,
        })),
      }));

    res.status(200).json({
      total: results.length,
      orders: results,
    });
  },
);
