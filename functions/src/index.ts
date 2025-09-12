// functions/src/index.ts
import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";
import fetch from "node-fetch";
import { db, FieldValue } from "./firebaseAdmin";
import { createTask } from "./cloudTasks";
import { allocateAwb, releaseAwb } from "./awb";
import { buildDelhiveryPayload } from "./buildPayload";
import { defineSecret } from "firebase-functions/params";
import { setGlobalOptions } from "firebase-functions/options";

setGlobalOptions({ region: process.env.LOCATION || "asia-south1" });

const TASKS_SECRET = defineSecret("TASKS_SECRET");
const ENQUEUE_FUNCTION_SECRET = defineSecret("ENQUEUE_FUNCTION_SECRET");

/** Small helper to require a shared secret header */
function requireHeaderSecret(req: Request, header: string, expected: string) {
  const got = (req.get(header) || "").trim();
  if (!got || got !== (expected || "").trim()) throw new Error(`UNAUTH_${header}`);
}

/** Called by Vercel API to enqueue Cloud Tasks (one per jobId) */
export const enqueueShipmentTasks = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [ENQUEUE_FUNCTION_SECRET, TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { shop, batchId, jobIds, pickupName, shippingMode } = (req.body || {}) as {
        shop?: string;
        batchId?: string;
        jobIds?: string[];
        pickupName?: string;
        shippingMode?: string;
      };

      if (
        !shop ||
        !batchId ||
        !pickupName ||
        !shippingMode ||
        !Array.isArray(jobIds) ||
        jobIds.length === 0
      ) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      // Create one Cloud Task per job
      await Promise.all(
        jobIds.map((jobId) =>
          createTask(
            { shop, batchId, jobId, pickupName, shippingMode },
            { tasksSecret: TASKS_SECRET.value() || "" },
          ),
        ),
      );

      res.json({ ok: true, enqueued: jobIds.length });
      return;
    } catch (e: any) {
      console.error("enqueue error:", e);
      res.status(500).json({ error: "enqueue_failed", details: String(e?.message ?? e) });
      return;
    }
  },
);

/** Cloud Tasks → processes exactly ONE shipment job */
export const processShipmentTask = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    let awb: string | undefined;
    let awbReleased = false;
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { shop, batchId, jobId, pickupName, shippingMode } = (req.body || {}) as {
        shop?: string;
        batchId?: string;
        jobId?: string;
        pickupName?: string;
        shippingMode?: string;
      };

      if (!shop || !batchId || !jobId || !pickupName || !shippingMode) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      const batchRef = db
        .collection("accounts")
        .doc(shop)
        .collection("shipment_batches")
        .doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(String(jobId));
      const orderRef = db.collection("accounts").doc(shop).collection("orders").doc(String(jobId));
      const accountRef = db.collection("accounts").doc(shop);

      // Idempotency: if already success, return OK
      const jSnap = await jobRef.get();
      if (jSnap.exists && jSnap.data()?.status === "success") {
        res.json({ ok: true, dedup: true });
        return;
      }

      // Mark processing
      await Promise.all([
        jobRef.set(
          { status: "processing", attempts: FieldValue.increment(1), lastAttemptAt: new Date() },
          { merge: true },
        ),
        batchRef.update({ queued: FieldValue.increment(-1), processing: FieldValue.increment(1) }),
      ]);

      // Allocate AWB
      awb = await allocateAwb(shop);

      // Load order data
      const ordSnap = await orderRef.get();
      if (!ordSnap.exists) throw new Error("ORDER_NOT_FOUND");
      const order = ordSnap.data();

      // Build carrier payload
      const payload = buildDelhiveryPayload({
        orderId: String(jobId),
        awb,
        order,
        pickupName,
        shippingMode,
      });

      // Carrier API key
      const accSnap = await accountRef.get();
      const apiKey = accSnap.data()?.integrations?.couriers?.delhivery?.apiKey as
        | string
        | undefined;
      if (!apiKey) throw new Error("CARRIER_KEY_MISSING");

      // Call carrier (ONE shipment)
      const base = process.env.CARRIER_BASE_URL || "https://track.delhivery.com";
      const path = process.env.CARRIER_CREATE_PATH || "/api/cmu/create.json";
      const resp = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const text = await resp.text();
      if (!resp.ok) {
        // Optional: push AWB back
        await releaseAwb(shop, awb);
        awbReleased = true;
        throw new Error(`CARRIER_${resp.status}:${text.slice(0, 400)}`);
      }

      // Parse carrier response
      let carrier: any;
      try {
        carrier = JSON.parse(text);
      } catch {
        carrier = { raw: text };
      }
      const carrierShipmentId = carrier?.shipment_id ?? carrier?.packets?.[0]?.waybill ?? null;

      // Persist success
      await Promise.all([
        jobRef.update({
          status: "success",
          awb,
          carrierShipmentId,
          errorCode: FieldValue.delete(),
          errorMessage: FieldValue.delete(),
          apiResp: carrier,
        }),
        batchRef.update({ processing: FieldValue.increment(-1), success: FieldValue.increment(1) }),
        orderRef.set(
          { awb, shipmentStatus: "created", customStatus: "Ready To Dispatch" },
          { merge: true },
        ),
      ]);

      // Finalize batch if done
      await db.runTransaction(async (tx) => {
        const b = await tx.get(batchRef);
        const d = b.data() || {};
        const done = (d.success || 0) + (d.failed || 0);
        if (done >= d.total) tx.update(batchRef, { status: "completed" });
      });

      res.json({ ok: true, awb, carrierShipmentId });
      return;
    } catch (e: any) {
      try {
        const { shop, batchId, jobId } = (req.body || {}) as {
          shop?: string;
          batchId?: string;
          jobId?: string;
        };
        if (shop && batchId && jobId) {
          if (awb && !awbReleased) {
            try {
              await releaseAwb(shop, awb);
            } catch (secondaryErr) {
              void secondaryErr;
            }
          }
          const batchRef = db
            .collection("accounts")
            .doc(shop)
            .collection("shipment_batches")
            .doc(batchId);
          const jobRef = batchRef.collection("jobs").doc(String(jobId));
          await Promise.all([
            jobRef.set(
              { status: "failed", errorCode: "ERR", errorMessage: String(e?.message ?? e) },
              { merge: true },
            ),
            batchRef.update({
              processing: FieldValue.increment(-1),
              failed: FieldValue.increment(1),
            }),
          ]);
        }
      } catch {
        // ignore secondary failure
      }
      res.status(500).json({ error: "job_failed", details: String(e?.message ?? e), awb });
      return;
    }
  },
);
