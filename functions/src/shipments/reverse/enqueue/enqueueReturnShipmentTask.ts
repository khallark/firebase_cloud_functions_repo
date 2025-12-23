import { onRequest } from "firebase-functions/v2/https";
import { ENQUEUE_FUNCTION_SECRET, TASKS_SECRET } from "../../../config";
import { requireHeaderSecret } from "../../../helpers";
import { createTask } from "../../../services";
import { FieldValue, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { db } from "../../../firebaseAdmin";

export const enqueueReturnShipmentTasks = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [ENQUEUE_FUNCTION_SECRET, TASKS_SECRET] },
  async (req, res) => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { businessId, shop, orderIds, shippingMode, requestedBy } = (req.body || {}) as {
        businessId?: string;
        shop?: string;
        orderIds?: string[];
        shippingMode?: string;
        requestedBy?: string;
      };

      if (
        !businessId ||
        !shop ||
        !shippingMode ||
        !Array.isArray(orderIds) ||
        orderIds.length === 0
      ) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      const shopDoc = (await db.collection("accounts").doc(shop).get()).data();
      if (!shopDoc) {
        res.status(400).json({ error: "shop_not_found" });
        return;
      }

      // Validate orders
      const orderRefs = orderIds.map((o) =>
        db.collection("accounts").doc(shop).collection("orders").doc(String(o)),
      );

      const orderSnapshots = await db.getAll(...orderRefs);
      const orderDataMap = new Map<string, any>();

      for (let i = 0; i < orderSnapshots.length; i++) {
        const snap = orderSnapshots[i];
        if (!snap.exists) {
          res.status(400).json({
            error: "order_not_found",
            orderId: orderIds[i],
          });
          return;
        }

        const orderData = snap.data()!;

        // Validate courier exists
        if (!orderData.courier) {
          res.status(400).json({
            error: "order_missing_courier",
            orderId: orderIds[i],
            message: "Cannot create return for order without courier",
          });
          return;
        }

        // Validate customStatus is either "Delivered" or "DTO Requested"
        const status = orderData.customStatus;
        if (status !== "Delivered" && status !== "DTO Requested") {
          res.status(400).json({
            error: "invalid_order_status",
            orderId: orderIds[i],
            currentStatus: status,
            message: 'Order status must be "Delivered" or "DTO Requested" to create return',
          });
          return;
        }

        orderDataMap.set(String(orderIds[i]), orderData);
      }

      // Create batch header
      const batchRef = db
        .collection("users")
        .doc(businessId)
        .collection("book_return_batches")
        .doc();

      await batchRef.set({
        shop,
        shippingMode,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: requestedBy || "system",
        total: orderIds.length,
        queued: orderIds.length,
        status: "queued",
        processing: 0,
        success: 0,
        failed: 0,
      });

      // Create job docs and enqueue tasks
      const writer = db.bulkWriter();
      const taskPromises: Promise<any>[] = [];

      const taskUrl = process.env.RETURN_TASK_TARGET_URL_1;
      if (!taskUrl) {
        throw new Error("RETURN_TASK_TARGET_URL_1 not configured");
      }

      for (const o of orderIds) {
        const orderData = orderDataMap.get(String(o))!;
        const courier = orderData.courier;
        const normalizedCourier = courier.split(":")[0].trim();

        // Create job document
        writer.set(
          batchRef.collection("jobs").doc(String(o)),
          {
            orderId: String(o),
            orderName: orderData.name,
            courier: normalizedCourier,
            status: "queued",
            attempts: 0,
          },
          { merge: true },
        );

        // Queue Cloud Task
        taskPromises.push(
          createTask(
            {
              businessId,
              shop,
              batchId: batchRef.id,
              jobId: String(o),
              shippingMode,
            } as any,
            {
              tasksSecret: TASKS_SECRET.value() || "",
              url: taskUrl,
              queue: String(process.env.RETURN_SHIPMENT_QUEUE_NAME) || "return-shipments-queue",
            },
          ).catch((taskError) => {
            console.error(`Failed to create task for order ${o}:`, taskError);
            return batchRef
              .collection("jobs")
              .doc(String(o))
              .update({
                status: "failed",
                errorCode: "TASK_CREATION_FAILED",
                errorMessage: taskError.message || String(taskError),
              });
          }),
        );
      }

      await writer.close();
      await Promise.allSettled(taskPromises);

      // Recalculate batch counters after task creation
      const jobsSnap = await batchRef.collection("jobs").get();
      let queuedCount = 0;
      let failedCount = 0;

      jobsSnap.forEach((jobDoc: QueryDocumentSnapshot) => {
        const jobData = jobDoc.data();
        if (jobData.status === "queued") {
          queuedCount++;
        } else if (jobData.status === "failed") {
          failedCount++;
        }
      });

      await batchRef.update({
        status:
          queuedCount > 0 ? "running" : failedCount === orderIds.length ? "completed" : "running",
        queued: queuedCount,
        failed: failedCount,
      });

      res.status(202).json({
        collectionName: "book_return_batches",
        batchId: batchRef.id,
        queued: queuedCount,
        failed: failedCount,
      });
      return;
    } catch (e: any) {
      console.error("enqueue return error:", e);
      res.status(500).json({
        error: "start_return_batch_failed",
        details: String(e?.message ?? e),
      });
      return;
    }
  },
);
