import { onSchedule } from "firebase-functions/v2/scheduler";
import { CLOSE_AFTER_HOURS, TASKS_SECRET } from "../config";
import { createTask } from "../services";
import { onRequest } from "firebase-functions/v2/https";
import { chunkArray, requireHeaderSecret } from "../helpers";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firebaseAdmin";

interface CloseDeliveredOrdersPayload {
  accountId: string;
  cutoffTime: string; // ISO string
}
// ============================================================================
// CRON JOB - Enqueue tasks to close delivered orders after 360 hours
// ============================================================================
export const closeDeliveredOrdersJob = onSchedule(
  {
    schedule: "0 3 * * *",
    timeZone: "Asia/Kolkata",
    memory: "256MiB",
    timeoutSeconds: 540,
    secrets: [TASKS_SECRET],
  },
  async () => {
    console.log("🚀 Starting closeDeliveredOrdersJob - Enqueueing tasks");

    const cutoffTimeMs = CLOSE_AFTER_HOURS * 60 * 60 * 1000;
    const cutoffTime = new Date(Date.now() - cutoffTimeMs);

    console.log(`📅 Cutoff time: ${cutoffTime.toISOString()}`);

    const accountsSnapshot = await db.collection("accounts").get();
    console.log(`📊 Found ${accountsSnapshot.size} accounts to check`);

    let tasksEnqueued = 0;
    let tasksFailed = 0;

    const taskPromises: Promise<void>[] = [];

    for (const accountDoc of accountsSnapshot.docs) {
      const payload: CloseDeliveredOrdersPayload = {
        accountId: accountDoc.id,
        cutoffTime: cutoffTime.toISOString(),
      };

      const taskPromise = createTask(payload, {
        tasksSecret: TASKS_SECRET.value() || "",
        queue: process.env.CLOSE_DELIVERED_QUEUE_NAME || "close-delivered-orders-queue",
        url: process.env.CLOSE_DELIVERED_TARGET_URL!,
      })
        .then(() => {
          tasksEnqueued++;
        })
        .catch((error) => {
          tasksFailed++;
          console.error(`❌ Failed to enqueue task for account ${accountDoc.id}:`, error);
        });

      taskPromises.push(taskPromise);
    }

    // Wait for all tasks to be enqueued
    await Promise.allSettled(taskPromises);

    console.log(`✅ Job complete - Tasks enqueued: ${tasksEnqueued}, Failed: ${tasksFailed}`);
  },
);

// ============================================================================
// HTTP ENDPOINT - Close delivered orders for one account
// ============================================================================
export const closeDeliveredOrdersTask = onRequest(
  {
    cors: true,
    timeoutSeconds: 300,
    secrets: [TASKS_SECRET],
    memory: "512MiB",
  },
  async (req, res) => {
    // ✅ AUTHENTICATION
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");
    } catch (error: any) {
      console.error("❌ Authentication failed:", error);
      res.status(401).json({ error: "Unauthorized", message: error.message });
      return;
    }

    // ✅ METHOD CHECK
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    // ✅ PARSE PAYLOAD
    const payload = req.body as CloseDeliveredOrdersPayload;

    if (!payload || !payload.accountId || !payload.cutoffTime) {
      res.status(400).json({
        error: "invalid_payload",
        message: "Missing required fields: accountId, cutoffTime",
      });
      return;
    }

    const { accountId, cutoffTime } = payload;

    console.log(`🔄 Processing account ${accountId} - closing delivered orders`);

    try {
      const accountDoc = await db.collection("accounts").doc(accountId).get();

      if (!accountDoc.exists) {
        console.warn(`⚠️ Account ${accountId} not found - skipping`);
        res.status(404).json({
          error: "account_not_found",
          accountId,
        });
        return;
      }

      const cutoffDate = new Date(cutoffTime);

      // Query orders that need to be closed
      const ordersToClose = await accountDoc.ref
        .collection("orders")
        .where("customStatus", "==", "Delivered")
        .where("lastStatusUpdate", "<=", cutoffDate)
        .limit(500)
        .get();

      if (ordersToClose.empty) {
        console.log(`✓ No orders to close for account ${accountId}`);
        res.status(200).json({
          success: true,
          message: "No orders to close",
          ordersClosed: 0,
        });
        return;
      }

      console.log(`📦 Found ${ordersToClose.size} orders to close for account ${accountId}`);

      // Process in batches (Firestore batch limit is 500 operations)
      const BATCH_SIZE = 500;
      const orderChunks = chunkArray(ordersToClose.docs, BATCH_SIZE);

      for (const chunk of orderChunks) {
        const batch = db.batch();

        chunk.forEach((doc) => {
          batch.update(doc.ref, {
            customStatus: "Closed",
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Closed",
              createdAt: Timestamp.now(),
              remarks: "This order Closed after approximately 15 days of being Delivered.",
            }),
          });
        });

        await batch.commit();
        console.log(`✅ Closed batch of ${chunk.length} orders`);
      }

      console.log(`✅ Successfully closed ${ordersToClose.size} orders for account ${accountId}`);

      // ✅ SUCCESS RESPONSE
      res.status(200).json({
        success: true,
        accountId,
        ordersClosed: ordersToClose.size,
      });
    } catch (error: any) {
      console.error(`❌ Error closing orders for account ${accountId}:`, error);

      // ✅ ERROR RESPONSE
      res.status(500).json({
        error: "processing_failed",
        accountId,
        message: error.message,
      });
    }
  },
);
