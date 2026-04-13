import { onRequest } from "firebase-functions/v2/https";
import { SHARED_STORE_IDS } from "../config";
import { db } from "../firebaseAdmin";

export const auditDTORefundedAmounts = onRequest(
  { cors: true, memory: "2GiB", timeoutSeconds: 540 },
  async (req, res) => {
    const culprits: {
      orderName: string;
      storeId: string;
      orderRefundedAmount: number;
      itemWiseSum: number;
      diff: number;
    }[] = [];

    await Promise.all(
      SHARED_STORE_IDS.map(async (storeId) => {
        const snap = await db
          .collection("accounts")
          .doc(storeId)
          .collection("orders")
          .where("customStatus", "==", "DTO Refunded")
          .get();

        for (const doc of snap.docs) {
          const order = doc.data();

          const orderRefundedAmount = Number(order.refundedAmount ?? 0);

          const lineItems: any[] = Array.isArray(order.raw?.line_items)
            ? order.raw.line_items
            : [];

          const itemWiseSum = lineItems.reduce(
            (sum, item) => sum + Number(item.refundedAmount ?? 0),
            0,
          );

          if (Math.abs(orderRefundedAmount - itemWiseSum) > 0.01) {
            culprits.push({
              orderName: order.name ?? doc.id,
              storeId,
              orderRefundedAmount,
              itemWiseSum,
              diff: Number((orderRefundedAmount - itemWiseSum).toFixed(2)),
            });
          }
        }
      }),
    );

    culprits.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    res.status(200).json({
      total: culprits.length,
      culprits,
    });
  },
);