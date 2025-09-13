// functions/src/index.ts
import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";
import fetch from "node-fetch";
import { db, FieldValue } from "./firebaseAdmin";
import { createTask } from "./cloudTasks";
import { defineSecret } from "firebase-functions/params";
import { setGlobalOptions } from "firebase-functions/options";
import { buildDelhiveryPayload } from "./buildPayload";

setGlobalOptions({ region: process.env.LOCATION || "asia-south1" });

const TASKS_SECRET = defineSecret("TASKS_SECRET");
const ENQUEUE_FUNCTION_SECRET = defineSecret("ENQUEUE_FUNCTION_SECRET");

type OrderLite = { id: string; order_number?: string | number; [k: string]: any };

// --- Helpers ----------------------------------------------------------------
function requireHeaderSecret(req: Request, header: string, expected: string): void {
  const got = (req.header(header) || "").trim();
  if (!expected || got !== expected) {
    const err: any = new Error("unauthorized");
    err.status = 401;
    throw err;
  }
}

// --- HTTPS function: enqueueShipments (writes docs + schedules tasks) -------
export const enqueueShipmentTasks = onRequest(
  { cors: true, timeoutSeconds: 540, secrets: [ENQUEUE_FUNCTION_SECRET, TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
      if (req.method !== "POST") return void res.status(405).json({ error: "method_not_allowed" });

      const { shop, batchId, orders, pickupName, shippingMode, requestId, triggeredBy } =
        (req.body || {}) as {
          shop?: string;
          batchId?: string;
          orders?: OrderLite[];
          pickupName?: string;
          shippingMode?: string;
          requestId?: string | null;
          triggeredBy?: string | null;
        };

      if (
        !shop ||
        !batchId ||
        pickupName ||
        shippingMode ||
        !Array.isArray(orders) ||
        orders.length === 0
      ) {
        return void res.status(400).json({ error: "bad_payload" });
      }

      const batchRef = db
        .collection("accounts")
        .doc(shop)
        .collection("shipment_batches")
        .doc(batchId);

      // Idempotency on requestId (optional)
      if (requestId) {
        const reqRef = db
          .collection("accounts")
          .doc(shop)
          .collection("shipment_requests")
          .doc(requestId);
        const existing = await reqRef.get();
        if (existing.exists) {
          const data = existing.data() || {};
          return void res.json({ ok: true, batchId: data.batchId || batchId, idempotent: true });
        }
        await reqRef.create({
          batchId,
          createdAt: FieldValue.serverTimestamp(),
          triggeredBy: triggeredBy || null,
        });
      }

      // Create job docs in a single bulk operation
      const jobsCol = batchRef.collection("jobs");
      const batch = db.batch();
      for (const o of orders) {
        const jobId = jobsCol.doc().id;
        batch.set(jobsCol.doc(jobId), {
          orderId: o.id,
          order_number: o.order_number || null,
          createdAt: FieldValue.serverTimestamp(),
          status: "queued" as const,
          attempts: 0,
          errorCode: null,
          errorMessage: null,
        });
      }
      await batch.commit();

      // Schedule Cloud Tasks for each job
      const snap = await jobsCol.get();
      const location = process.env.LOCATION || "asia-south1";
      const projectId = process.env.GCLOUD_PROJECT || process.env.PROJECT_ID!;
      const targetUrl =
        process.env.PROCESS_TASK_URL ||
        `https://${location}-${projectId}.cloudfunctions.net/processShipmentTask`;

      const promises: Promise<any>[] = [];
      for (const doc of snap.docs) {
        const jobId = doc.id;
        promises.push(
          createTask(
            {
              shop,
              batchId,
              jobId,
              pickupName: pickupName || null,
              shippingMode: shippingMode || null,
            },
            {
              tasksSecret: TASKS_SECRET.value() || process.env.TASKS_SECRET,
              targetUrl,
              queueName: process.env.TASKS_QUEUE || "shipments-queue",
              location,
              projectId,
            },
          ),
        );
      }
      await Promise.all(promises);

      return void res.json({ ok: true, batchId, total: snap.size });
    } catch (e: any) {
      const status = e?.status ?? 500;
      return void res
        .status(status)
        .json({ error: "enqueue_failed", details: String(e?.message || e) });
    }
  },
);

// --- HTTPS function: processShipmentTask (handles ONE job) ------------------
export const processShipmentTask = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    let awb: string | undefined;

    try {
      // Verify Cloud Tasks secret
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");

      if (req.method !== "POST") {
        return void res.status(405).json({ error: "method_not_allowed" });
      }

      const { shop, batchId, jobId, pickupName, shippingMode } = (req.body || {}) as {
        shop?: string;
        batchId?: string;
        jobId?: string;
        pickupName?: string | null;
        shippingMode?: string | null;
      };

      if (!shop || !batchId || !jobId || !pickupName || !shippingMode) {
        return void res.status(400).json({ error: "bad_payload" });
      }

      const batchRef = db
        .collection("accounts")
        .doc(shop)
        .collection("shipment_batches")
        .doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(jobId);

      // Mark job as processing (idempotent)
      await db
        .runTransaction(async (trx) => {
          const j = await trx.get(jobRef);
          if (!j.exists) throw new Error("job_not_found");
          const data = j.data() || {};
          if (data.status === "success") {
            // Already done → nothing to do
            throw Object.assign(new Error("already_done"), { httpStatus: 200, already: true });
          }
          if (data.status === "processing") return;

          trx.update(jobRef, {
            status: "processing",
            startedAt: FieldValue.serverTimestamp(),
            attempts: FieldValue.increment(1),
          });
          trx.update(batchRef, {
            queued: FieldValue.increment(-1),
            processing: FieldValue.increment(1),
          });
        })
        .catch((e: any) => {
          if (e?.already) {
            return void res.json({ ok: true, status: "already_done" });
          }
          throw e;
        });

      // (1) Load the order data (adapt path if your order docs live elsewhere)
      const orderRef = db.collection("accounts").doc(shop).collection("orders").doc(jobId);
      const orderSnap = await orderRef.get();
      const orderData: any = orderSnap.exists ? orderSnap.data() : {};

      // (2) Allocate an AWB from your pool (simple example)
      const accountRef = db.collection("accounts").doc(shop);
      const awbAlloc = await db.runTransaction(async (trx) => {
        const acc = await trx.get(accountRef);
        const pool = (acc.data() as any)?.awb_pool || [];
        if (!Array.isArray(pool) || pool.length === 0) {
          throw Object.assign(new Error("no_awb_available"), { httpStatus: 409 });
        }
        const allocated = pool[0];
        const remaining = pool.slice(1);
        trx.update(accountRef, { awb_pool: remaining });
        return allocated as string;
      });
      awb = awbAlloc;

      // (3) Build Delhivery payload (minimal viable)
      const payload = buildDelhiveryPayload({
        awb,
        order: orderData,
        pickupName: pickupName,
        shippingMode: shippingMode || "Express",
      });

      // (4) Call Delhivery create shipment
      const url =
        process.env.DELHIVERY_CREATE_URL || "https://track.delhivery.com/api/cmu/create.json";
      const apiKey = process.env.DELHIVERY_API_KEY || "";
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${apiKey}`,
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      const text = await resp.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }

      if (!resp.ok || (json?.status && String(json.status).toLowerCase() !== "success")) {
        // Permanent (4xx) → mark failed. 5xx → retry
        if (resp.status >= 500) {
          throw Object.assign(new Error(`carrier_5xx:${resp.status}`), {
            retry: true,
            details: json,
          });
        }
        await Promise.all([
          jobRef.update({
            status: "failed",
            errorCode: `carrier_${resp.status}`,
            errorMessage: typeof json === "string" ? json : JSON.stringify(json).slice(0, 1500),
            finishedAt: FieldValue.serverTimestamp(),
          }),
          batchRef.update({
            processing: FieldValue.increment(-1),
            failed: FieldValue.increment(1),
          }),
        ]);
        return void res.status(200).json({ ok: false, failed: true });
      }

      const carrierShipmentId =
        json?.packages?.[0]?.awb || json?.waybill || json?.shipment_id || null;

      // (5) Success → update docs
      await Promise.all([
        jobRef.update({
          status: "success",
          awb,
          carrierShipmentId,
          errorCode: FieldValue.delete(),
          errorMessage: FieldValue.delete(),
          finishedAt: FieldValue.serverTimestamp(),
        }),
        batchRef.update({
          processing: FieldValue.increment(-1),
          success: FieldValue.increment(1),
        }),
        orderRef.set(
          { awb, shipmentStatus: "created", customStatus: "Ready To Dispatch" },
          { merge: true },
        ),
      ]);

      return void res.json({ ok: true, awb, carrierShipmentId });
    } catch (e: any) {
      // If we allocated an AWB and failed, put it back (best effort)
      try {
        if (awb) {
          const accountRef = db.collection("accounts").doc(req.body?.shop || "");
          await accountRef.update({ awb_pool: FieldValue.arrayUnion(awb) });
        }
      } catch (e) {
        void e;
      }

      const transient = Boolean(e?.retry || e?.httpStatus === 503);
      if (transient) {
        // Ask Cloud Tasks to retry
        return void res
          .status(503)
          .json({ error: "transient_failure", details: String(e?.message || e) });
      }

      // Mark failed (best effort)
      try {
        const { shop, batchId, jobId } = req.body || {};
        if (shop && batchId && jobId) {
          const batchRef = db
            .collection("accounts")
            .doc(shop)
            .collection("shipment_batches")
            .doc(batchId);
          const jobRef = batchRef.collection("jobs").doc(jobId);
          await Promise.all([
            jobRef.update({
              status: "failed",
              errorCode: "exception",
              errorMessage: String(e?.message || e).slice(0, 1500),
              finishedAt: FieldValue.serverTimestamp(),
            }),
            batchRef.update({
              processing: FieldValue.increment(-1),
              failed: FieldValue.increment(1),
            }),
          ]);
        }
      } catch (e) {
        void e;
      }

      return void res.status(500).json({ error: "job_failed", details: String(e?.message || e) });
    }
  },
);
