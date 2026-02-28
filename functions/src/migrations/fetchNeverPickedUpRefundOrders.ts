import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { SHARED_STORE_ID, SHARED_STORE_ID_2 } from "../config";

const TARGET_STATUSES = ["Pending Refunds", "DTO Refunded", "RTO Processed", "RTO Closed"];
const STORE_IDS = [SHARED_STORE_ID, SHARED_STORE_ID_2];

interface LineItem {
  name: string;
  quantity: number;
  [key: string]: unknown;
}

interface OrderItemSummary {
  orderId: string;
  items: Record<string, number>[];
}

export const fetchNeverPickedUpRefundOrders = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    try {
      const queryPromises = STORE_IDS.flatMap((storeId) =>
        TARGET_STATUSES.map((status) =>
          db.collection(`accounts/${storeId}/orders`).where("customStatus", "==", status).get(),
        ),
      );

      const snapshots = await Promise.all(queryPromises);

      const seenOrderIds = new Set<string>();
      const orderItemSummaries: OrderItemSummary[] = [];
      let totalItems = 0;

      for (const snap of snapshots) {
        for (const doc of snap.docs) {
          const data = doc.data();

          if (data.pickupReady) continue;

          const orderId = doc.id;
          if (seenOrderIds.has(orderId)) continue;
          seenOrderIds.add(orderId);

          const lineItems: LineItem[] = data.raw?.line_items ?? [];

          const itemMap: Record<string, number> = {};
          for (const item of lineItems) {
            const name = item.name ?? "Unknown";
            itemMap[name] = (itemMap[name] ?? 0) + (item.quantity ?? 1);
          }

          totalItems += lineItems.length;

          orderItemSummaries.push({
            orderId,
            items: Object.entries(itemMap).map(([name, qty]) => ({ [name]: qty })),
          });
        }
      }

      res.status(200).json({
        totalOrders: seenOrderIds.size,
        orderItemSummaries,
        totalItems,
      });
    } catch (error) {
      console.error("Error fetching never-picked-up refund orders:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
