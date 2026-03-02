import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { SHARED_STORE_ID, SHARED_STORE_ID_2 } from "../config";
import { DocumentReference, Timestamp, WriteBatch } from "firebase-admin/firestore";

const STORE_IDS = [SHARED_STORE_ID, SHARED_STORE_ID_2];

const VALID_STATUSES = [
  "New",
  "Confirmed",
  "Ready To Dispatch",
  "Dispatched",
  "In Transit",
  "Out For Delivery",
  "Delivered",
  "RTO In Transit",
  "RTO Delivered",
  "DTO Requested",
  "DTO Booked",
  "DTO In Transit",
  "DTO Delivered",
  "Pending Refunds",
  "DTO Refunded",
  "Lost",
  "Closed",
  "RTO Processed",
  "RTO Closed",
  "Cancellation Requested",
  "Cancelled",
];
const VALID_STATUSES_SET = new Set(VALID_STATUSES);

interface StatusLog {
  status: string;
  remarks: string;
  createdAt: Timestamp;
}

interface MismatchedOrder {
  orderId: string;
  orderName: string;
  storeId: string;
  customStatus: string;
  reason: "no_valid_log" | "latest_log_status_mismatch";
  latestValidLogStatus?: string;
}

export const syncLastStatusUpdate = onRequest(
  {
    cors: true,
    timeoutSeconds: 3600,
    memory: "2GiB",
  },
  async (req, res) => {
    try {
      const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;

      const snapshots = await Promise.all(
        STORE_IDS.map((storeId) => db.collection(`accounts/${storeId}/orders`).get()),
      );

      // Batch management
      let currentBatch = db.batch();
      let batchOpCount = 0;
      const batches: WriteBatch[] = [currentBatch];

      const mismatchedOrders: MismatchedOrder[] = [];
      let totalUpdated = 0;

      const addUpdate = (
        ref: DocumentReference,
        data: Record<string, unknown>,
      ) => {
        if (batchOpCount > 0 && batchOpCount % 499 === 0) {
          currentBatch = db.batch();
          batches.push(currentBatch);
        }
        currentBatch.update(ref, data);
        batchOpCount++;
      };

      for (let i = 0; i < STORE_IDS.length; i++) {
        const storeId = STORE_IDS[i];
        const snap = snapshots[i];

        for (const doc of snap.docs) {
          const order = doc.data();
          const logs: StatusLog[] = order.customStatusesLogs ?? [];
          const customStatus: string = order.customStatus ?? "";

          // Filter logs to only those with a valid status
          const validLogs = logs.filter((log) => VALID_STATUSES_SET.has(log.status));

          if (validLogs.length === 0) {
            mismatchedOrders.push({
              orderId: doc.id,
              orderName: order.name ?? doc.id,
              storeId,
              customStatus,
              reason: "no_valid_log",
            });
            continue;
          }

          // Find the log with the latest createdAt among valid logs
          const latestLog = validLogs.reduce((prev, curr) =>
            curr.createdAt.toMillis() > prev.createdAt.toMillis() ? curr : prev,
          );

          if (latestLog.status !== customStatus) {
            mismatchedOrders.push({
              orderId: doc.id,
              orderName: order.name ?? doc.id,
              storeId,
              customStatus,
              reason: "latest_log_status_mismatch",
              latestValidLogStatus: latestLog.status,
            });
            continue;
          }

          // Update lastStatusUpdate to the latest valid log's createdAt
          if (!dryRun) {
            addUpdate(doc.ref, { lastStatusUpdate: latestLog.createdAt });
          }
          totalUpdated++;
        }
      }

      if (!dryRun) {
        for (const batch of batches) {
          await batch.commit();
        }
      }

      res.status(200).json({
        dryRun,
        totalUpdated,
        totalMismatched: mismatchedOrders.length,
        mismatchedOrders,
      });
    } catch (error: any) {
      console.error("Error in syncLastStatusUpdate:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  },
);
