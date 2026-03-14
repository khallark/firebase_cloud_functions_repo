import { onRequest } from "firebase-functions/v2/https";
import { SHARED_STORE_IDS } from "../config";
import { db } from "../firebaseAdmin";

export const getRtoClosedPickupReadyWithNullPutAway = onRequest(
  { cors: true, timeoutSeconds: 540, memory: "1GiB" },
  async (req, res) => {
    const businessId = (req.query.businessId as string) || req.body?.businessId;

    if (!businessId) {
      res.status(400).json({ error: "businessId is required" });
      return;
    }

    // ── 1. Fetch all RTO Closed orders where pickupReady == true ─────────────
    const allOrders: any[] = [];
    const seenIds = new Set<string>();

    await Promise.all(
      SHARED_STORE_IDS.map(async (storeId) => {
        const snap = await db
          .collection("accounts")
          .doc(storeId)
          .collection("orders")
          .where("customStatus", "==", "RTO Closed")
          .where("pickupReady", "==", true)
          .get();

        snap.forEach((doc) => {
          if (seenIds.has(doc.id)) return;
          seenIds.add(doc.id);
          allOrders.push({ id: doc.id, storeId, ...doc.data() });
        });
      }),
    );

    console.log(`📦 RTO Closed + pickupReady orders: ${allOrders.length}`);

    // ── 2. For each order, fetch UPCs with putAway == null ───────────────────
    const flaggedOrders: any[] = [];

    await Promise.all(
      allOrders.map(async (order) => {
        const orderId = String(order.orderId);

        const upcsSnap = await db
          .collection(`users/${businessId}/upcs`)
          .where("orderId", "==", orderId)
          .where("putAway", "==", null)
          .get();

        if (upcsSnap.empty) return;

        const nullPutAwayUpcs = upcsSnap.docs.map((doc) => ({
          upcId: doc.id,
          ...doc.data(),
        }));

        flaggedOrders.push({
          orderId: order.id,
          orderName: order.name ?? order.id,
          storeId: order.storeId,
          nullPutAwayUpcs,
        });
      }),
    );

    res.status(200).json({
      total: flaggedOrders.length,
      orders: flaggedOrders,
    });
  },
);
