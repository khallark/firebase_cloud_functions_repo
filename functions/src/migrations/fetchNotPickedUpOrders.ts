import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { SHARED_STORE_ID, SHARED_STORE_ID_2 } from "../config";

const STORE_IDS = [SHARED_STORE_ID, SHARED_STORE_ID_2];

interface LineItem {
  sku: string;
  quantity: number;
  [key: string]: unknown;
}

export const fetchNotPickedUpOrders = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    try {
      const snapshots = await Promise.all(
        STORE_IDS.map((storeId) => db.collection(`accounts/${storeId}/orders`).where("customStatus", "in", ["Dispatched", "In Transit", "Out For Delivery", "Delivered", "RTO In Transit", "RTO Delivered", "DTO Requested", "DTO Booked", "DTO In Transit", "DTO Delivered"]).get())
      );

      const seenOrderIds = new Set<string>();
      const result: { name: string; line_items: { sku: string; quantity: number }[] }[] = [];

      for (const snap of snapshots) {
        for (const doc of snap.docs) {
          const data = doc.data();

          if (data.pickupReady) continue;
          if (seenOrderIds.has(doc.id)) continue;
          seenOrderIds.add(doc.id);

          const lineItems: LineItem[] = data.raw?.line_items ?? [];

          result.push({
            name: data.name ?? data.raw?.name ?? doc.id,
            line_items: lineItems.map((item) => ({
              sku: item.sku,
              quantity: item.quantity,
            })),
          });
        }
      }

      res.status(200).json({ total: result.length, orders: result });
    } catch (error) {
      console.error("Error fetching not-picked-up orders:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);