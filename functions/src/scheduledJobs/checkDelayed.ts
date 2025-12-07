import { onSchedule } from "firebase-functions/v2/scheduler";
import { TASKS_SECRET } from "../config";
import {
  createTask,
  sendConfirmedDelayedLvl1WhatsAppMessage,
  sendConfirmedDelayedLvl2WhatsAppMessage,
  sendConfirmedDelayedLvl3WhatsAppMessage,
} from "../services";
import { onRequest } from "firebase-functions/v2/https";
import { chunkArray, requireHeaderSecret } from "../helpers";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebaseAdmin";

interface ProcessDelayedOrdersPayload {
  accountId: string;
  delayLevel: {
    hours: number;
    tag: string;
    handlerIndex: number; // Index into DELAY_LEVELS array
  };
}

const DELAY_LEVELS = [
  { hours: 44, tag: "Delay Level-1", handler: sendConfirmedDelayedLvl1WhatsAppMessage },
  { hours: 96, tag: "Delay Level-2", handler: sendConfirmedDelayedLvl2WhatsAppMessage },
  { hours: 144, tag: "Delay Level-3", handler: sendConfirmedDelayedLvl3WhatsAppMessage },
] as const;

// ============================================================================
// CRON JOB - Enqueue tasks for delayed confirmed orders
// ============================================================================
export const checkDelayedConfirmedOrders = onSchedule(
  {
    schedule: "0 2 * * *",
    timeZone: "Asia/Kolkata",
    memory: "256MiB",
    timeoutSeconds: 540,
    secrets: [TASKS_SECRET],
  },
  async () => {
    console.log("🚀 Starting checkDelayedConfirmedOrders job - Enqueueing tasks");

    const accountsSnapshot = await db.collection("accounts").get();
    console.log(`📊 Found ${accountsSnapshot.size} accounts to check`);

    let tasksEnqueued = 0;
    let tasksFailed = 0;

    // Create a task for each account x delay level combination
    const taskPromises: Promise<void>[] = [];

    for (const accountDoc of accountsSnapshot.docs) {
      for (let i = 0; i < DELAY_LEVELS.length; i++) {
        const level = DELAY_LEVELS[i];

        const payload: ProcessDelayedOrdersPayload = {
          accountId: accountDoc.id,
          delayLevel: {
            hours: level.hours,
            tag: level.tag,
            handlerIndex: i,
          },
        };

        const taskPromise = createTask(payload, {
          tasksSecret: TASKS_SECRET.value() || "",
          url: process.env.CONFIRMED_DELAYED_TARGET_URL!,
          queue: process.env.CONFIRMED_DELAYED_QUEUE_NAME || "confirmed-delayed-orders-queue",
        })
          .then(() => {
            tasksEnqueued++;
          })
          .catch((error) => {
            tasksFailed++;
            console.error(
              `❌ Failed to enqueue task for account ${accountDoc.id}, level ${level.tag}:`,
              error,
            );
          });

        taskPromises.push(taskPromise);
      }
    }

    // Wait for all tasks to be enqueued
    await Promise.allSettled(taskPromises);

    console.log(`✅ Job complete - Tasks enqueued: ${tasksEnqueued}, Failed: ${tasksFailed}`);
  },
);

// ============================================================================
// HTTP ENDPOINT - Process delayed orders for one account and one delay level
// ============================================================================
export const processDelayedOrdersTask = onRequest(
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
    const payload = req.body as ProcessDelayedOrdersPayload;

    if (!payload || !payload.accountId || !payload.delayLevel) {
      res.status(400).json({
        error: "invalid_payload",
        message: "Missing required fields: accountId, delayLevel",
      });
      return;
    }

    const { accountId, delayLevel } = payload;

    console.log(`🔄 Processing account ${accountId} for ${delayLevel.tag} (${delayLevel.hours}h)`);

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

      const shop = accountDoc.data() as any;
      const cutoffTime = new Date(Date.now() - delayLevel.hours * 60 * 60 * 1000);

      // ✅ FIXED: Use dedicated tracking field instead of array check
      const ordersSnapshot = await accountDoc.ref
        .collection("orders")
        .where("customStatus", "==", "Confirmed")
        .where("lastStatusUpdate", "<=", cutoffTime)
        .where(`delayNotified_${delayLevel.hours}h`, "==", null) // ✅ Only get orders NOT yet notified
        .limit(500)
        .get();

      if (ordersSnapshot.empty) {
        console.log(`✓ No orders to process for account ${accountId}, level ${delayLevel.tag}`);
        res.status(200).json({
          success: true,
          message: "No orders to process",
          ordersProcessed: 0,
        });
        return;
      }

      console.log(`📦 Found ${ordersSnapshot.size} orders to process for account ${accountId}`);

      // Process in batches (Firestore batch limit is 500 operations)
      const BATCH_SIZE = 500;
      const orderChunks = chunkArray(ordersSnapshot.docs, BATCH_SIZE);

      for (const chunk of orderChunks) {
        const batch = db.batch();
        const messagePromises: Promise<any>[] = [];

        chunk.forEach((doc) => {
          // Update the order with the delay tag
          batch.update(doc.ref, {
            tags_confirmed: FieldValue.arrayUnion(delayLevel.tag),
            [`delayNotified_${delayLevel.hours}h`]: FieldValue.serverTimestamp(),
            delayNotificationAttempts: FieldValue.increment(1),
          });

          // Queue the message to be sent in parallel
          const order = doc.data() as any;
          const handler = DELAY_LEVELS[delayLevel.handlerIndex].handler;

          messagePromises.push(
            handler(shop, order).catch((error: Error) => {
              console.error(
                `❌ Failed to send ${delayLevel.tag} message for order ${doc.id}:`,
                error.message,
              );
              // Don't throw - we still want to mark the order as processed
            }),
          );
        });

        // Execute batch update and send messages in parallel
        await Promise.all([
          batch.commit(),
          ...messagePromises.map((p) => p.catch((e) => console.error(e))),
        ]);

        console.log(`✅ Processed batch of ${chunk.length} orders`);
      }

      console.log(
        `✅ Completed processing ${ordersSnapshot.size} orders for account ${accountId}, level ${delayLevel.tag}`,
      );

      // ✅ SUCCESS RESPONSE
      res.status(200).json({
        success: true,
        accountId,
        delayLevel: delayLevel.tag,
        ordersProcessed: ordersSnapshot.size,
      });
    } catch (error: any) {
      console.error(`❌ Error processing account ${accountId}, level ${delayLevel.tag}:`, error);

      // ✅ ERROR RESPONSE
      res.status(500).json({
        error: "processing_failed",
        accountId,
        delayLevel: delayLevel.tag,
        message: error.message,
      });
    }
  },
);
