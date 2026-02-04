import { onSchedule } from "firebase-functions/v2/scheduler";
import { SHARED_STORE_IDS, SUPER_ADMIN_ID, TASKS_SECRET } from "../../config";
import { BusinessData, hasActiveShipments } from "../helpers";
import { createTask } from "../../services";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../firebaseAdmin";

export const enqueueBlueDartStatusUpdateTasksScheduled = onSchedule(
  {
    schedule: "0 0,4,8,12,16,20 * * *", // 6 times daily
    timeZone: "Asia/Kolkata",
    memory: "512MiB",
    timeoutSeconds: 540,
    secrets: [TASKS_SECRET],
  },
  async () => {
    console.log("[Blue Dart] Starting scheduled status update batch processing...");

    try {
      console.log(
        "[Blue Dart] Looking for active businesses, so that redundant updates can be avoided...",
      );

      const businessesSnapshot = await db.collection("users").get();

      if (businessesSnapshot.empty) {
        console.log("[Blue Dart] No users with business found");
        return;
      }

      // Only process businesses that have orders in active shipping states
      const activeBusinesses = [];
      for (const doc of businessesSnapshot.docs) {
        const data = doc.data() as BusinessData;
        if (data.stores?.length && (await hasActiveShipments(data.stores))) {
          activeBusinesses.push(doc);
        }
      }

      console.log(`[Blue Dart] Found ${activeBusinesses.length} businesses`);
      console.log(
        "[Blue Dart] Creating the individual batches of the shops, which are within these active businesses...",
      );

      let allShopIds = new Set<{ accountId: string; businessId: string }>();
      activeBusinesses.forEach((doc) => {
        if (!doc.id) {
          console.error(
            "[Blue Dart] ⚠️ Found document without ID in activeBusinesses:",
            doc.ref.path,
          );
          return;
        }

        const data = doc.data() as BusinessData;
        data.stores.forEach((acc) => {
          if (!acc) {
            console.error(`[Blue Dart] ⚠️ Found undefined store in business ${doc.id}`);
            return;
          }

          if (SHARED_STORE_IDS.includes(acc)) {
            if (doc.id === SUPER_ADMIN_ID) {
              allShopIds.add({ accountId: acc, businessId: doc.id });
            }
          } else {
            allShopIds.add({ accountId: acc, businessId: doc.id });
          }
        });
      });

      console.log(`[Blue Dart] Found ${allShopIds.size} shops to process.`);
      console.log(
        "[Blue Dart] Proceeding to create a batch and enqueueing all the shops as batch's jobs",
      );

      // Create batch header
      const batchRef = db.collection("status_update_batches").doc();
      const batchId = batchRef.id;

      await batchRef.set({
        createdAt: FieldValue.serverTimestamp(),
        createdBy: "system-scheduled",
        queued: allShopIds.size,
        status: "running",
        processing: 0,
        success: 0,
        failed: 0,
        type: "status_update",
        schedule: "6x_daily",
        courier: "Blue Dart",
      });

      // Create job documents (one per account)
      const writer = db.bulkWriter();
      for (const { accountId, businessId } of allShopIds) {
        writer.set(
          batchRef.collection("jobs").doc(accountId),
          {
            accountId,
            businessId,
            status: "queued",
            attempts: 0,
            createdAt: FieldValue.serverTimestamp(),
            processedOrders: 0,
            updatedOrders: 0,
            totalChunks: 0,
          },
          { merge: true },
        );
      }
      await writer.close();

      const targetUrl = process.env.UPDATE_STATUS_TASK_JOB_TARGET_URL_BLUEDART;
      if (!targetUrl) {
        throw new Error("UPDATE_STATUS_TASK_JOB_TARGET_URL_BLUEDART not configured");
      }

      // Create initial tasks (chunk 0 for each account)
      const taskPromises = Array.from(allShopIds).map(({ accountId, businessId }, index) =>
        createTask(
          {
            accountId,
            businessId,
            batchId,
            jobId: accountId,
            chunkIndex: 0,
            cursor: null,
          } as any,
          {
            tasksSecret: TASKS_SECRET.value() || "",
            url: targetUrl,
            queue: process.env.STATUS_UPDATE_QUEUE_NAME || "statuses-update-queue",
            delaySeconds: Math.floor(index * 2),
          },
        ),
      );

      await Promise.all(taskPromises);

      console.log(`[Blue Dart] Enqueued ${allShopIds.size} initial tasks for batch ${batchId}`);
    } catch (error) {
      console.error("[Blue Dart] enqueueStatusUpdateTasks failed:", error);
      throw error;
    }
  },
);
