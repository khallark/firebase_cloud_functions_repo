// functions/src/functions/shipments/forward/enqueueShipments.ts

import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";
import { createTask } from "../../../services";
import { FieldValue } from "firebase-admin/firestore";
import { ENQUEUE_FUNCTION_SECRET, TASKS_SECRET } from "../../../config";
import { capitalizeWords, requireHeaderSecret } from "../../../helpers";
import { db } from "../../../firebaseAdmin";

/**
 * Enqueues shipment tasks for multiple orders
 * Called by Vercel API to create Cloud Tasks (one per jobId)
 */
export const enqueueShipmentTasks = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [ENQUEUE_FUNCTION_SECRET, TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { businessId, shop, orders, courier, pickupName, shippingMode, requestedBy } =
        (req.body || {}) as {
          businessId?: string;
          shop?: string;
          orders?: string;
          courier?: string;
          pickupName?: string;
          shippingMode?: string;
          requestedBy?: string;
        };

      if (
        !businessId ||
        !shop ||
        !courier ||
        !pickupName ||
        !shippingMode ||
        !Array.isArray(orders) ||
        orders.length === 0
      ) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      const businessRef = await db.collection("users").doc(businessId).get();
      if (!businessRef.exists) {
        res.status(400).json({ error: "business_not_found" });
        return;
      }
      const businessDoc = businessRef.data();

      const priorityCourier =
        courier === "Priority"
          ? businessDoc?.integrations?.couriers?.priorityList?.[0]?.name.toLowerCase()
          : null;

      const url = (() => {
        if (courier === "Delhivery") return String(process.env.SHIPMENT_TASK_TARGET_URL_1);
        if (courier === "Shiprocket") return String(process.env.SHIPMENT_TASK_TARGET_URL_2);
        if (courier === "Xpressbees") return String(process.env.SHIPMENT_TASK_TARGET_URL_3);

        if (courier === "Priority") {
          if (!priorityCourier) {
            throw new Error("Priority courier not configured in shop settings");
          }
          if (priorityCourier === "delhivery")
            return String(process.env.SHIPMENT_TASK_TARGET_URL_1);
          if (priorityCourier === "shiprocket")
            return String(process.env.SHIPMENT_TASK_TARGET_URL_2);
          if (priorityCourier === "xpressbees")
            return String(process.env.SHIPMENT_TASK_TARGET_URL_3);
          throw new Error(`Unsupported priority courier: ${priorityCourier}`);
        }

        throw new Error(`Unsupported courier: ${courier}`);
      })();

      // 1) Create batch header
      const batchRef = businessRef.ref.collection("shipment_batches").doc();

      await batchRef.set({
        shop,
        courier,
        pickupName,
        shippingMode,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: requestedBy, // <-- stamp UID
        total: orders.length,
        queued: orders.length,
        status: "running", // queued | running | complete
        processing: 0,
        success: 0,
        failed: 0,
      });

      // 2) Create job docs
      const writer = db.bulkWriter();

      for (const o of orders) {
        writer.set(
          batchRef.collection("jobs").doc(String(o.orderId)),
          {
            orderId: String(o.orderId),
            ...(courier === "Priority" ? { courier: capitalizeWords(priorityCourier) } : {}),
            orderName: o.name,
            status: "queued",
            attempts: 0,
          },
          { merge: true },
        );
      }
      await writer.close();

      const batchId = batchRef.id;
      const jobIds = orders.map((o) => String(o.orderId));

      // Create one Cloud Task per job
      await Promise.all(
        jobIds.map((jobId) =>
          createTask(
            { businessId, shop, batchId, courier, jobId, pickupName, shippingMode } as any,
            {
              tasksSecret: TASKS_SECRET.value() || "",
              url,
              queue: String(process.env.SHIPMENT_QUEUE_NAME) || "shipments-queue",
            },
          ),
        ),
      );

      await batchRef.update({ status: "running" });
      res.status(202).json({ collectionName: "shipment_batches", batchId });
      return;
    } catch (e: any) {
      console.error("enqueue error:", e);
      res.status(500).json({ error: "start_batch_failed", details: String(e?.message ?? e) });
      return;
    }
  },
);
