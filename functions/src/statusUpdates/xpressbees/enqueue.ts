import { onSchedule } from "firebase-functions/v2/scheduler";
import { SHARED_STORE_ID, SUPER_ADMIN_ID, TASKS_SECRET } from "../../config";
import { BusinessData, hasActiveShipments } from "../helpers";
import { FieldValue } from "firebase-admin/firestore";
import { createTask } from "../../services";
import { db } from "../../firebaseAdmin";

export const enqueueXpressbeesStatusUpdateTasksScheduled = onSchedule(
  {
    schedule: "0 0,4,8,12,16,20 * * *", // 6 times daily
    timeZone: "Asia/Kolkata",
    memory: "512MiB",
    timeoutSeconds: 540,
    secrets: [TASKS_SECRET],
  },
  async (event) => {
    console.log(`Starting scheduled status update batch processing...${event ? "" : ""}`);

    try {
      console.log("Looking for active businesses, so that redundant updates can be avoided...");
      // Get all the Business (User) docs
      const businessesSnapshot = await db.collection("users").get();

      if (businessesSnapshot.empty) {
        console.log("No users with business found");
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

      console.log(`Found ${activeBusinesses.length} businesses`);
      console.log(
        "Creating the individual batches of the shops, which are within these active businesses...",
      );

      let allShopIds = new Set<{ accountId: string; businessId: string }>();
      activeBusinesses.forEach((doc) => {
        if (!doc.id) {
          console.error("⚠️ Found document without ID in activeBusinesses:", doc.ref.path);
          return; // Skip this document
        }

        const data = doc.data() as BusinessData;
        data.stores.forEach((acc) => {
          if (!acc) {
            console.error(`⚠️ Found undefined store in business ${doc.id}`);
            return;
          }

          if (acc === SHARED_STORE_ID) {
            if (doc.id === SUPER_ADMIN_ID) {
              allShopIds.add({ accountId: acc, businessId: doc.id });
            }
          } else {
            allShopIds.add({ accountId: acc, businessId: doc.id });
          }
        });
      });

      // Option 1: Convert to array and log (most readable)
      console.log("All shop IDs:", JSON.stringify(Array.from(allShopIds.values()), null, 2));

      console.log(`Found ${allShopIds.size} shops to process.`);
      console.log("Proceeding to create a batch and enqueueing all the shops as batch's jobs");

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
        courier: "Xpressbees",
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

      const targetUrl = process.env.UPDATE_STATUS_TASK_JOB_TARGET_URL_XPRESSBEES;
      if (!targetUrl) {
        throw new Error("UPDATE_STATUS_TASK_TARGET_URL not configured");
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

      console.log(`Enqueued ${allShopIds.size} initial tasks for batch ${batchId}`);
    } catch (error) {
      console.error("enqueueStatusUpdateTasks failed:", error);
      throw error;
    }
  },
);
