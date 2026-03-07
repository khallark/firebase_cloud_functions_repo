import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { SHARED_STORE_IDS } from "../config";

export const convertToRTOClosed = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    try {
      const { dryRun } = req.body as { dryRun?: boolean };

      if (typeof dryRun !== "boolean") {
        res.status(400).json({
          success: false,
          message: "dryRun must be true or false",
        });
        return;
      }

      const ordersWithoutLog: string[] = [];
      let totalOrdersFound = 0;
      for (const storeId of SHARED_STORE_IDS) {
        const ordersRef = db.collection(`accounts/${storeId}/orders`);

        const snapshot = await ordersRef.where("customStatus", "==", "RTO Processed").get();
        totalOrdersFound += snapshot.docs.length;

        for (const doc of snapshot.docs) {
          const order = doc.data();
          const logs = order.customStatusesLogs || [];

          const logIndex = logs.findIndex((l: any) => l.status === "RTO Processed");

          if (logIndex === -1) {
            ordersWithoutLog.push(order.name);
            continue;
          }

          if (!dryRun) {
            logs[logIndex] = {
              ...logs[logIndex],
              status: "RTO Closed",
              remarks: "This order was returned and received by the owner and manually closed",
            };

            await doc.ref.update({
              customStatus: "RTO Closed",
              customStatusesLogs: logs,
            });
          }
        }
      }

      res.status(200).json({
        success: true,
        dryRun,
        totalOrdersFound,
        ordersWithoutLog,
      });
    } catch (error: any) {
      console.error("Error converting RTO orders:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Internal server error",
      });
    }
  },
);
