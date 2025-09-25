// functions/src/index.ts
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/scheduler";
import type { Request, Response } from "express";
import fetch from "node-fetch";
import { db, FieldValue } from "./firebaseAdmin";
import { createTask } from "./cloudTasks";
import { allocateAwb, releaseAwb } from "./awb";
import { buildDelhiveryPayload, buildShiprocketPayload } from "./buildPayload";
import { defineSecret } from "firebase-functions/params";
import { setGlobalOptions } from "firebase-functions/options";
import { DocumentReference, Timestamp } from "firebase-admin/firestore";

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

      const { shop, orders, courier, pickupName, shippingMode, requestedBy } = (req.body || {}) as {
        shop?: string;
        orders?: string;
        courier?: string;
        pickupName?: string;
        shippingMode?: string;
        requestedBy?: string;
      };

      if (
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

      // 1) Create batch header
      const batchRef = db.collection("accounts").doc(shop).collection("shipment_batches").doc();

      await batchRef.set({
        shop,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: requestedBy, // <-- stamp UID
        total: orders.length,
        queued: orders.length,
        status: "running", // queued | running | complete
        carrier: courier,
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

      const url =
        courier === "Delhivery"
          ? String(process.env.SHIPMENT_TASK_TARGET_URL_1)
          : String(process.env.SHIPMENT_TASK_TARGET_URL_2);

      // Create one Cloud Task per job
      await Promise.all(
        jobIds.map((jobId) =>
          createTask({ shop, batchId, jobId, courier, pickupName, shippingMode } as any, {
            tasksSecret: TASKS_SECRET.value() || "",
            url,
            queue: String(process.env.SHIPMENT_QUEUE_NAME) || "shipments-queue",
          }),
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

// outer catch non-retryable error codes
const NON_RETRYABLE = new Set(["CARRIER_KEY_MISSING", "ORDER_NOT_FOUND"]);

/** Cloud Tasks → processes exactly ONE shipment job */
export const processShipmentTask = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    let awb: string | undefined;
    let awbReleased = false;

    // --- helpers -------------------------------------------------------------
    const parseJson = (t: string) => {
      try {
        return JSON.parse(t);
      } catch {
        return { raw: t };
      }
    };

    async function maybeCompleteBatch(batchRef: DocumentReference) {
      await db.runTransaction(async (tx) => {
        const b = await tx.get(batchRef);
        const d = b.data() || {};
        const total = Number(d.total || 0);
        const success = Number(d.success || 0);
        const failed = Number(d.failed || 0);
        const processing = Number(d.processing || 0);
        if (total && success + failed === total && processing === 0) {
          tx.update(batchRef, { status: "completed" });
        }
      });
    }

    async function attemptsExhausted(jobRef: DocumentReference) {
      const snap = await jobRef.get();
      const data = snap.data() || {};
      const attempts = Number(data.attempts || 0);
      return attempts >= Number(process.env.SHIPMENT_QUEUE_MAX_ATTEMPTS) ? true : false;
    }

    /** Classify Delhivery create-shipment response */
    function evalDelhiveryResp(carrier: any): {
      ok: boolean;
      retryable: boolean;
      code: string;
      message: string;
      carrierShipmentId?: string | null;
    } {
      const remarksArr = carrier.packages[0].remarks;
      let remarks = "";
      if (Array.isArray(remarksArr)) remarks = remarksArr.join("\n ");

      // Success signals seen in Delhivery responses
      const waybill =
        carrier?.shipment_id ?? carrier?.packets?.[0]?.waybill ?? carrier?.waybill ?? null;

      const okFlag = (carrier?.success === true && carrier?.error !== true) || Boolean(waybill);

      if (okFlag) {
        return {
          ok: true,
          retryable: false,
          code: "OK",
          message: "created",
          carrierShipmentId: waybill,
        };
      }

      // ----- Known permanent validation/business errors (non-retryable) -----
      return {
        ok: false,
        retryable: false,
        code: "CARRIER_AMBIGUOUS",
        message: remarks,
      };
    }

    /** Decide if an HTTP failure status is retryable */
    function httpRetryable(status: number) {
      // transient: throttling / contention / timeouts / early hints
      if (status === 429 || status === 408 || status === 409 || status === 425) return true;
      if (status >= 500) return true;
      return false;
    }
    // -------------------------------------------------------------------------

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

      // Idempotency: if already success, just ack
      const jSnap = await jobRef.get();
      if (jSnap.exists && jSnap.data()?.status === "success") {
        res.json({ ok: true, dedup: true });
        return;
      }

      // --- Start bookkeeping (transaction) -----------------------------------
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(jobRef);
        const data = snap.data() || {};
        const prevAttempts = Number(data.attempts || 0);
        const firstAttempt = prevAttempts === 0 || data.status === "queued" || !data.status;

        // move to processing, increment attempts
        tx.set(
          jobRef,
          {
            status: "processing",
            attempts: (prevAttempts || 0) + 1,
            lastAttemptAt: new Date(),
          },
          { merge: true },
        );

        const inc: any = { processing: FieldValue.increment(1) };
        if (firstAttempt) inc.queued = FieldValue.increment(-1);
        tx.update(batchRef, inc);
      });
      // -----------------------------------------------------------------------

      // Allocate AWB
      awb = await allocateAwb(shop);

      // Load order
      const ordSnap = await orderRef.get();
      if (!ordSnap.exists) throw new Error("ORDER_NOT_FOUND");
      const order = ordSnap.data();

      // Build payload for Delhivery
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

      // Call Delhivery (IMPORTANT: format=json&data=<json>)
      const base = "https://track.delhivery.com";
      const path = "/api/cmu/create.json";
      const body = new URLSearchParams({ format: "json", data: JSON.stringify(payload) });
      const resp = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });

      const text = await resp.text();

      // Handle HTTP layer errors (non-2xx)
      if (!resp.ok) {
        if (awb && !awbReleased) {
          try {
            await releaseAwb(shop, awb);
          } catch (e) {
            void e;
          }
        }
        awbReleased = true;
        const areAttempsExhausted = await attemptsExhausted(jobRef);
        if (httpRetryable(resp.status)) {
          await Promise.all([
            jobRef.set(
              {
                status: areAttempsExhausted ? "failed" : "retrying",
                errorCode: `HTTP_${resp.status}`,
                errorMessage: text.slice(0, 400),
              },
              { merge: true },
            ),
            batchRef.update(
              areAttempsExhausted
                ? { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) }
                : { processing: FieldValue.increment(-1) },
            ),
          ]);
          await maybeCompleteBatch(batchRef);
          res.status(503).json({ retry: true, reason: `http_${resp.status}` });
          return;
        } else {
          await Promise.all([
            jobRef.set(
              {
                status: "failed",
                errorCode: `HTTP_${resp.status}`,
                errorMessage: text.slice(0, 400),
              },
              { merge: true },
            ),
            batchRef.update({
              processing: FieldValue.increment(-1),
              failed: FieldValue.increment(1),
            }),
          ]);
          await maybeCompleteBatch(batchRef);
          res.status(200).json({ ok: false, permanent: true, reason: `http_${resp.status}` });
          return;
        }
      }

      // Parse and evaluate carrier JSON
      const carrier = parseJson(text);
      const verdict = evalDelhiveryResp(carrier);

      if (!verdict.ok) {
        if (awb && !awbReleased) {
          try {
            await releaseAwb(shop, awb);
          } catch (e) {
            void e;
          }
        }
        awbReleased = true;
        const areAttempsExhausted = await attemptsExhausted(jobRef);
        if (verdict.retryable) {
          await Promise.all([
            jobRef.set(
              {
                status: areAttempsExhausted ? "failed" : "retrying",
                errorCode: verdict.code,
                errorMessage: verdict.message,
                apiResp: carrier,
              },
              { merge: true },
            ),
            batchRef.update(
              areAttempsExhausted
                ? { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) }
                : { processing: FieldValue.increment(-1) },
            ),
          ]);
          await maybeCompleteBatch(batchRef);
          res.status(503).json({ retry: true, reason: verdict.code });
          return;
        } else {
          await Promise.all([
            jobRef.set(
              {
                status: "failed",
                errorCode: verdict.code,
                errorMessage: verdict.message,
                apiResp: carrier,
              },
              { merge: true },
            ),
            batchRef.update({
              processing: FieldValue.increment(-1),
              failed: FieldValue.increment(1),
            }),
          ]);
          await maybeCompleteBatch(batchRef);
          res.status(200).json({ ok: false, permanent: true, reason: verdict.code });
          return;
        }
      }

      // --- Success path ------------------------------------------------------
      awbReleased = true; // guard: DO NOT release a used AWB if anything throws after this

      await Promise.all([
        jobRef.update({
          status: "success",
          awb,
          carrierShipmentId: verdict.carrierShipmentId ?? null,
          errorCode: FieldValue.delete(),
          errorMessage: FieldValue.delete(),
          apiResp: carrier,
        }),
        batchRef.update({ processing: FieldValue.increment(-1), success: FieldValue.increment(1) }),
        orderRef.set(
          {
            awb,
            courier: "Delhivery",
            customStatus: "Ready To Dispatch",
            shippingMode,
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Ready To Dispatch",
              createdAt: Timestamp.now(),
              remarks: `The order's shipment was successfully made on Delhivery (${shippingMode}) (AWB: ${awb})`,
            }),
          },
          { merge: true },
        ),
      ]);

      // If batch is done, close it
      await db.runTransaction(async (tx) => {
        const b = await tx.get(batchRef);
        const d = b.data() || {};
        const done = (d.success || 0) + (d.failed || 0);
        if (done >= d.total) tx.update(batchRef, { status: "completed" });
      });

      res.json({ ok: true, awb, carrierShipmentId: verdict.carrierShipmentId ?? null });
      return;
    } catch (e: any) {
      // Generic failure (network/bug/etc.)
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.split(/\s/)[0]; // first token
      const isRetryable = !NON_RETRYABLE.has(code);

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
            } catch (e) {
              void e;
            }
          }
          const batchRef = db
            .collection("accounts")
            .doc(shop)
            .collection("shipment_batches")
            .doc(batchId);
          const jobRef = batchRef.collection("jobs").doc(String(jobId));
          const areAttempsExhausted = await attemptsExhausted(jobRef);
          await Promise.all([
            jobRef.set(
              {
                status: isRetryable ? (areAttempsExhausted ? "failed" : "retrying") : "failed",
                errorCode: isRetryable ? "EXCEPTION" : code,
                errorMessage: msg,
              },
              { merge: true },
            ),
            batchRef.update(
              isRetryable
                ? areAttempsExhausted
                  ? { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) }
                  : { processing: FieldValue.increment(-1) }
                : { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) },
            ),
          ]);
          await maybeCompleteBatch(batchRef);
        }
      } catch {
        /* best-effort */
      }

      if (isRetryable) {
        res.status(503).json({ error: "job_failed_transient", code, message: msg });
      } else {
        res.status(200).json({ ok: false, permanent: true, reason: code, message: msg });
      }
    }
  },
);

/** Cloud Tasks → processes exactly ONE shipment job (Shiprocket: create order → assign AWB) */
export const processShipmentTask2 = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    // NOTE: Shiprocket order creation does NOT allocate an AWB from your pool.
    // We keep `awb` only to mirror your generic catch/finalization shape.
    let awb: string | undefined;
    let awbReleased = false;

    // --- small helpers -------------------------------------------------------
    const parseJson = (t: string) => {
      try {
        return JSON.parse(t);
      } catch {
        return { raw: t };
      }
    };

    async function maybeCompleteBatch(batchRef: DocumentReference) {
      await db.runTransaction(async (tx) => {
        const b = await tx.get(batchRef);
        const d = b.data() || {};
        const total = Number(d.total || 0);
        const success = Number(d.success || 0);
        const failed = Number(d.failed || 0);
        const processing = Number(d.processing || 0);
        if (total && success + failed === total && processing === 0) {
          tx.update(batchRef, { status: "completed" });
        }
      });
    }

    async function attemptsExhausted(jobRef: DocumentReference) {
      const snap = await jobRef.get();
      const data = snap.data() || {};
      const attempts = Number(data.attempts || 0);
      return attempts >= Number(process.env.SHIPMENT_QUEUE_MAX_ATTEMPTS) ? true : false;
    }

    /** Decide if an HTTP failure status is retryable */
    function httpRetryable(status: number) {
      // 5xx and 429 are retryable; 4xx are usually permanent
      if (status === 429) return true;
      if (status >= 500) return true;
      return false;
    }

    /** Classify Shiprocket create-order response */
    function evalShiprocketResp(sr: any): {
      ok: boolean;
      retryable: boolean;
      code: string;
      message: string;
      orderId?: string | number | null;
      shipmentId?: string | number | null;
    } {
      const msgFields = [
        sr?.message,
        sr?.msg,
        sr?.error,
        sr?.error_message,
        sr?.errors ? JSON.stringify(sr?.errors) : "",
      ]
        .filter((x) => typeof x === "string" && x.length)
        .join(" | ");

      const rawMsg = msgFields || "";

      // Success shape seen in docs: { order_id, shipment_id, status: "NEW", status_code: 1, ... }
      const looksSuccess =
        "order_id" in (sr ?? {}) &&
        sr.order_id != null &&
        "shipment_id" in (sr ?? {}) &&
        sr.shipment_id != null &&
        sr?.status_code === 1;

      if (looksSuccess) {
        return {
          ok: true,
          retryable: false,
          code: "OK",
          message: "created",
          orderId: sr?.order_id ?? null,
          shipmentId: sr?.shipment_id ?? null,
        };
      }

      // ----- Known permanent validation/business errors (non-retryable) -----
      return {
        ok: false,
        retryable: false,
        code: "CARRIER_AMBIGUOUS",
        message: rawMsg || "carrier error",
      };
    }
    // -------------------------------------------------------------------------

    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");
      if (req.method !== "POST") return void res.status(405).json({ error: "method_not_allowed" });

      const { shop, batchId, jobId, pickupName, shippingMode } = (req.body || {}) as {
        shop?: string;
        batchId?: string;
        jobId?: string;
        pickupName?: string;
        shippingMode?: string;
      };
      if (!shop || !batchId || !jobId || !pickupName || !shippingMode) {
        return void res.status(400).json({ error: "bad_payload" });
      }

      const batchRef = db
        .collection("accounts")
        .doc(shop)
        .collection("shipment_batches")
        .doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(String(jobId));
      const orderRef = db.collection("accounts").doc(shop).collection("orders").doc(String(jobId));
      const accountRef = db.collection("accounts").doc(shop);

      // Idempotency: if already success, just ack
      const jSnap = await jobRef.get();
      if (jSnap.exists && jSnap.data()?.status === "success") {
        return void res.json({ ok: true, dedup: true });
      }

      // --- Start bookkeeping (transaction) -----------------------------------
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(jobRef);
        const data = snap.data() || {};
        const prevAttempts = Number(data.attempts || 0);
        const firstAttempt = prevAttempts === 0 || data.status === "queued" || !data.status;

        // move to processing, increment attempts
        tx.set(
          jobRef,
          {
            status: "processing",
            attempts: (prevAttempts || 0) + 1,
            lastAttemptAt: new Date(),
          },
          { merge: true },
        );

        const inc: any = { processing: FieldValue.increment(1) };
        if (firstAttempt) inc.queued = FieldValue.increment(-1);
        tx.update(batchRef, inc);
      });
      // -----------------------------------------------------------------------

      // Load order
      const ordSnap = await orderRef.get();
      if (!ordSnap.exists) throw new Error("ORDER_NOT_FOUND");
      const order = ordSnap.data();

      // Carrier token/config
      const accSnap = await accountRef.get();
      const shiprocketCfg = accSnap.data()?.integrations?.couriers?.shiprocket || {};
      const srToken =
        shiprocketCfg?.accessToken ||
        shiprocketCfg?.token ||
        shiprocketCfg?.apiKey ||
        shiprocketCfg?.bearer;

      if (!srToken) throw new Error("CARRIER_KEY_MISSING");

      // ---- Create payload (minimal/defensive) ----
      const payload = buildShiprocketPayload({
        orderId: String(jobId),
        order,
        pickupName,
        shippingMode,
      });

      // --- Idempotency: reuse previously created Shiprocket IDs on retry ----
      const prior = jSnap.data() || {};
      let srOrderId: string | number | undefined = prior.shiprocketOrderId;
      let srShipmentId: string | number | undefined = prior.shiprocketShipmentId;

      // If we already created the SR order earlier, skip creation
      type SRVerdict = ReturnType<typeof evalShiprocketResp>;
      let verdict: SRVerdict;

      if (srShipmentId) {
        verdict = {
          ok: true,
          retryable: false,
          code: "OK",
          message: "created",
          orderId: srOrderId ?? null,
          shipmentId: srShipmentId,
        };
      } else {
        // ---- Shiprocket Create Order ----
        const base = "https://apiv2.shiprocket.in";
        const createPath = "/v1/external/orders/create/adhoc";

        const resp = await fetch(`${base}${createPath}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${srToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        const text = await resp.text();

        // HTTP errors
        if (!resp.ok) {
          const areAttempsExhausted = await attemptsExhausted(jobRef);
          if (httpRetryable(resp.status)) {
            await Promise.all([
              jobRef.set(
                {
                  status: areAttempsExhausted ? "failed" : "retrying",
                  errorCode: `HTTP_${resp.status}`,
                  errorMessage: text.slice(0, 400),
                },
                { merge: true },
              ),
              batchRef.update(
                areAttempsExhausted
                  ? { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) }
                  : { processing: FieldValue.increment(-1) },
              ),
            ]);
            await maybeCompleteBatch(batchRef);
            return void res.status(503).json({ retry: true, reason: `http_${resp.status}` });
          } else {
            await Promise.all([
              jobRef.set(
                {
                  status: "failed",
                  errorCode: `HTTP_${resp.status}`,
                  errorMessage: text.slice(0, 400),
                },
                { merge: true },
              ),
              batchRef.update({
                processing: FieldValue.increment(-1),
                failed: FieldValue.increment(1),
              }),
            ]);
            await maybeCompleteBatch(batchRef);
            return void res
              .status(200)
              .json({ ok: false, permanent: true, reason: `http_${resp.status}` });
          }
        }

        const orderCreateJson = parseJson(text);
        const v = evalShiprocketResp(orderCreateJson);
        verdict = v;

        if (!v.ok) {
          const areAttempsExhausted = await attemptsExhausted(jobRef);
          if (v.retryable) {
            await Promise.all([
              jobRef.set(
                {
                  status: areAttempsExhausted ? "failed" : "retrying",
                  errorCode: v.code,
                  errorMessage: v.message,
                  apiResp: orderCreateJson,
                },
                { merge: true },
              ),
              batchRef.update(
                areAttempsExhausted
                  ? { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) }
                  : { processing: FieldValue.increment(-1) },
              ),
            ]);
            await maybeCompleteBatch(batchRef);
            return void res.status(503).json({ retry: true, reason: v.code });
          } else {
            await Promise.all([
              jobRef.set(
                {
                  status: "failed",
                  errorCode: v.code,
                  errorMessage: v.message,
                  apiResp: orderCreateJson,
                },
                { merge: true },
              ),
              batchRef.update({
                processing: FieldValue.increment(-1),
                failed: FieldValue.increment(1),
              }),
            ]);
            await maybeCompleteBatch(batchRef);
            return void res.status(200).json({ ok: false, permanent: true, reason: v.code });
          }
        }

        // Persist IDs immediately so retries can skip creation
        srOrderId = v.orderId ?? srOrderId;
        srShipmentId = v.shipmentId ?? srShipmentId;
        await jobRef.set(
          {
            shiprocketOrderId: srOrderId ?? null,
            shiprocketShipmentId: srShipmentId ?? null,
            stage: "order_created",
          },
          { merge: true },
        );

        // Wait for a second
        function sleep(ms: number): Promise<void> {
          return new Promise((resolve) => setTimeout(resolve, ms));
        }
        await sleep(1000);
      }

      // ---- Shiprocket Assign AWB ----
      const base = "https://apiv2.shiprocket.in";
      const awbPath = "/v1/external/courier/assign/awb";

      const awbResp = await fetch(`${base}${awbPath}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${srToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          shipment_id: verdict.shipmentId, // required
          // courier_id: <number>, // optional if you want to force a courier
        }),
      });

      const awbText = await awbResp.text();

      // HTTP layer handling
      if (!awbResp.ok) {
        const areAttempsExhausted = await attemptsExhausted(jobRef);
        if (httpRetryable(awbResp.status)) {
          await Promise.all([
            jobRef.set(
              {
                status: areAttempsExhausted ? "failed" : "retrying",
                errorCode: `HTTP_${awbResp.status}`,
                errorMessage: awbText.slice(0, 400),
              },
              { merge: true },
            ),
            batchRef.update(
              areAttempsExhausted
                ? { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) }
                : { processing: FieldValue.increment(-1) },
            ),
          ]);
          await maybeCompleteBatch(batchRef);
          return void res.status(503).json({ retry: true, reason: `http_${awbResp.status}` });
        } else {
          await Promise.all([
            jobRef.set(
              {
                status: "failed",
                errorCode: `HTTP_${awbResp.status}`,
                errorMessage: awbText.slice(0, 400),
              },
              { merge: true },
            ),
            batchRef.update({
              processing: FieldValue.increment(-1),
              failed: FieldValue.increment(1),
            }),
          ]);
          await maybeCompleteBatch(batchRef);
          return void res
            .status(200)
            .json({ ok: false, permanent: true, reason: `http_${awbResp.status}` });
        }
      }

      // ---- Parse and extract according to Shiprocket structure ----
      const awbJson = parseJson(awbText) ?? {};
      // Most Shiprocket success payloads: { awb_assign_status, response: { data: { ... } } }
      const node = awbJson?.response?.data ?? awbJson?.data ?? awbJson?.response ?? awbJson; // fallbacks for odd variants
      // Build a readable error message from common fields (top-level & nested)
      const errorIfAny = (awbJson?.message || "").toLowerCase();

      // Correct fields per your example JSON
      const awbCode = node?.awb_code ?? null;
      const courierName = node?.courier_name ?? null;
      const courierId = node?.courier_company_id ?? null;

      // Success → we have an AWB
      if (awbCode) {
        await Promise.all([
          jobRef.update({
            status: "success",
            awb: awbCode,
            carrierShipmentId: verdict.shipmentId ?? null,
            carrier: "Shiprocket",
            courierName: courierName ?? null,
            courierCompanyId: courierId ?? null,
            errorCode: FieldValue.delete(),
            errorMessage: FieldValue.delete(),
            apiResp: {
              orderCreate: srOrderId ? "persisted" : "fresh",
              awbAssign: awbJson,
            },
          }),
          batchRef.update({
            processing: FieldValue.increment(-1),
            success: FieldValue.increment(1),
          }),
          orderRef.set(
            {
              awb: awbCode,
              courier: `Shiprocket: ${courierName ?? "Unknown"}`,
              customStatus: "Ready To Dispatch",
              customStatusesLogs: FieldValue.arrayUnion({
                status: "Ready To Dispatch",
                createdAt: Timestamp.now(),
                remarks: `The order's shipment was successfully made on ${courierName} via Shiprocket (AWB: ${awbCode})`,
              }),

              // Persist Shiprocket IDs for future reference
              shiprocketOrderId: srOrderId ?? null,
              shiprocketShipmentId: verdict.shipmentId ?? null,
            },
            { merge: true },
          ),
        ]);

        // If batch is done, close it
        await db.runTransaction(async (tx) => {
          const b = await tx.get(batchRef);
          const d = b.data() || {};
          const done = (d.success || 0) + (d.failed || 0);
          if (done >= d.total) tx.update(batchRef, { status: "completed" });
        });

        return void res.json({
          ok: true,
          awb: awbCode,
          carrierShipmentId: verdict.shipmentId ?? null,
          shiprocketOrderId: srOrderId ?? null,
        });
      }

      // Non-retryable AWB cases (based on typical Shiprocket messages)
      if (errorIfAny) {
        await Promise.all([
          jobRef.set(
            {
              status: "failed",
              errorCode: awbJson?.message || "Awb assign failed",
              errorMessage: awbJson?.message || "Awb assign failed",
              apiResp: { awbAssign: awbJson },
            },
            { merge: true },
          ),
          batchRef.update({
            processing: FieldValue.increment(-1),
            failed: FieldValue.increment(1),
          }),
        ]);
        await maybeCompleteBatch(batchRef);
        return void res
          .status(200)
          .json({ ok: false, permanent: true, reason: "AWB_ASSIGN_FAILED" });
      }

      const areAttempsExhausted = await attemptsExhausted(jobRef);
      // Ambiguous → retry
      await Promise.all([
        jobRef.set(
          {
            status: areAttempsExhausted ? "failed" : "retrying",
            errorCode: "CARRIER_AMBIGUOUS",
            errorMessage: "carrier error",
            apiResp: { awbAssign: awbJson },
          },
          { merge: true },
        ),
        batchRef.update(
          areAttempsExhausted
            ? { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) }
            : { processing: FieldValue.increment(-1) },
        ),
      ]);
      await maybeCompleteBatch(batchRef);
      return void res.status(503).json({ retry: true, reason: "CARRIER_AMBIGUOUS" });
    } catch (e: any) {
      // Generic failure (network/bug/etc.)
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.split(/\s/)[0]; // first token
      const isRetryable = !NON_RETRYABLE.has(code);

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
            } catch (e) {
              void e;
            }
          }
          const batchRef = db
            .collection("accounts")
            .doc(shop)
            .collection("shipment_batches")
            .doc(batchId);
          const jobRef = batchRef.collection("jobs").doc(String(jobId));
          const areAttempsExhausted = await attemptsExhausted(jobRef);
          await Promise.all([
            jobRef.set(
              {
                status: isRetryable ? (areAttempsExhausted ? "failed" : "retying") : "failed",
                errorCode: isRetryable ? "EXCEPTION" : code,
                errorMessage: code,
              },
              { merge: true },
            ),
            batchRef.update(
              isRetryable
                ? areAttempsExhausted
                  ? { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) }
                  : { processing: FieldValue.increment(-1) }
                : { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) },
            ),
          ]);
          await maybeCompleteBatch(batchRef);
        }
      } catch (e) {
        void e;
      }
      // 503 → ask Cloud Tasks to retry the task
      return void res
        .status(isRetryable ? 503 : 200)
        .json(
          isRetryable
            ? { error: "job_failed_transient", details: String(e?.message ?? e) }
            : { ok: false, permanent: true, reason: code },
        );
    }
  },
);

/** Vercel → starts a fulfillment batch and enqueues one task per orderId */
export const enqueueOrdersFulfillmentTasks = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [ENQUEUE_FUNCTION_SECRET, TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { shop, orderIds, requestedBy } = (req.body || {}) as {
        shop?: string;
        orderIds?: Array<string | number>;
        requestedBy?: string;
      };

      if (!shop || !Array.isArray(orderIds) || orderIds.length === 0) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      // Validate account + token
      const accountRef = db.collection("accounts").doc(shop);
      const accountSnap = await accountRef.get();
      if (!accountSnap.exists) {
        res.status(404).json({ error: "shop_not_found" });
        return;
      }
      const accessToken = accountSnap.get("accessToken");
      if (!accessToken) {
        res.status(500).json({ error: "missing_access_token" });
        return;
      }

      // Create summary doc
      const summaryRef = accountRef.collection("orders_fulfillment_summary").doc();
      const summaryId = summaryRef.id;
      const now = FieldValue.serverTimestamp();
      const total = orderIds.length;

      await summaryRef.set({
        shop,
        createdBy: requestedBy ?? null,
        createdAt: now,
        status: "running", // queued | running | complete
        total,
        processing: 0,
        success: 0,
        failed: 0,
      });

      // Seed job docs
      const batch = db.batch();
      const jobsCol = summaryRef.collection("jobs");
      for (const oid of orderIds) {
        const jobRef = jobsCol.doc(String(oid)); // deterministic per order
        batch.set(jobRef, {
          orderId: String(oid),
          status: "queued", // queued | processing | retrying | success | failed
          attempts: 0,
          updatedAt: now,
        });
      }
      await batch.commit();

      // Enqueue Cloud Tasks
      const workerUrl = process.env.FULFILLMENT_TASK_TARGET_URL || "";
      if (!workerUrl) {
        res.status(500).json({ error: "worker_url_not_configured" });
        return;
      }

      await Promise.all(
        orderIds.map((oid) =>
          createTask(
            {
              shop,
              summaryId,
              jobId: String(oid),
              orderId: String(oid),
            } as any, // widen payload; your createTask is generic
            {
              tasksSecret: TASKS_SECRET.value() || "",
              url: workerUrl,
              queue: process.env.FULFILLMENT_QUEUE_NAME || "fulfillments-queue",
              delaySeconds: 1,
            },
          ),
        ),
      );

      await summaryRef.update({ status: "running" });
      res.status(202).json({ collectionName: "orders_fulfillment_summary", summaryId });
      return;
    } catch (e: any) {
      console.error("startOrdersFulfillmentBatch error:", e);
      res.status(500).json({ error: "start_batch_failed", details: String(e?.message ?? e) });
      return;
    }
  },
);

// Fulfill ONE Shopify order (handles on_hold/scheduled → open)
async function fulfillOrderOnShopify(
  shop: string,
  accessToken: string,
  orderId: string | number,
  awb: string | number,
  courier: string,
): Promise<{ fulfillmentId?: string; nothingToDo?: boolean }> {
  const V = "2025-07";
  const headers = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };

  // 1) Get Fulfillment Orders (requires merchant-managed FO scopes if it's your own location)
  const foUrl = `https://${shop}/admin/api/${V}/orders/${orderId}/fulfillment_orders.json`;
  const foResp = await fetch(foUrl, { headers });
  if (!foResp.ok) {
    const text = await foResp.text();
    const err: any = new Error(`FO fetch failed: HTTP_${foResp.status}`);
    err.code = `HTTP_${foResp.status}`;
    err.detail = text;
    throw err;
  }
  let { fulfillment_orders: fos } = (await foResp.json()) as any;

  // If no FOs are visible, it’s almost always a scope issue
  if (!Array.isArray(fos) || fos.length === 0) {
    return { nothingToDo: true }; // caller can treat this as "check app scopes"
  }

  // Helpers
  const releaseHold = (id: number | string) =>
    fetch(`https://${shop}/admin/api/${V}/fulfillment_orders/${id}/release_hold.json`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });

  const openFO = (id: number | string) =>
    fetch(`https://${shop}/admin/api/${V}/fulfillment_orders/${id}/open.json`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });

  // 2) Try to convert on_hold/scheduled to open
  let touched = false;
  for (const fo of fos) {
    if (fo.status === "on_hold") {
      await releaseHold(fo.id);
      touched = true;
    } else if (fo.status === "scheduled") {
      await openFO(fo.id);
      touched = true;
    }
  }
  if (touched) {
    const refetch = await fetch(foUrl, { headers });
    if (!refetch.ok) {
      const text = await refetch.text();
      const err: any = new Error(`FO refetch failed: HTTP_${refetch.status}`);
      err.code = `HTTP_${refetch.status}`;
      err.detail = text;
      throw err;
    }
    fos = ((await refetch.json()) as any).fulfillment_orders;
  }

  // 3) Only work on fulfillable FOs
  const fulfillableFOs = (fos || []).filter(
    (fo: any) => fo.status === "open" || fo.status === "in_progress",
  );
  if (!fulfillableFOs.length) return { nothingToDo: true };

  // 4) Create the fulfillment:
  //    Pass only the FO IDs → fulfill all remaining quantities automatically.
  const lineItemsByFO = fulfillableFOs.map((fo: any) => ({
    fulfillment_order_id: fo.id,
    // Omit fulfillment_order_line_items to fulfill all remaining; safer than sending li.quantity.
  }));

  const fulfillUrl = `https://${shop}/admin/api/${V}/fulfillments.json`;
  const resp = await fetch(fulfillUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fulfillment: {
        line_items_by_fulfillment_order: lineItemsByFO,
        tracking_info: {
          number: String(awb) || "",
          // Optionally set company/url so the link is clickable in Admin:
          company: courier,
          url: String(courier).toLowerCase().includes("shiprocket")
            ? `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`
            : `https://track.delhivery.com/api/v1/packages/json/?waybill=${awb}&ref_ids=`,
        },
        notify_customer: false,
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    const err: any = new Error(`Fulfillment create failed: HTTP_${resp.status}`);
    err.code = `HTTP_${resp.status}`;
    err.detail = text;
    throw err;
  }

  const json: any = await resp.json();
  return { fulfillmentId: json?.fulfillment?.id };
}

/** Cloud Tasks → fulfills exactly ONE order and updates the summary */
export const processFulfillmentTask = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    function httpRetryable(status: number): boolean {
      return status === 408 || status === 429 || (status >= 500 && status <= 599);
    }
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");
      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { shop, summaryId, jobId, orderId } = (req.body || {}) as {
        shop?: string;
        summaryId?: string;
        jobId?: string;
        orderId?: string;
      };
      if (!shop || !summaryId || !jobId || !orderId) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      const summaryRef = db
        .collection("accounts")
        .doc(shop)
        .collection("orders_fulfillment_summary")
        .doc(summaryId);
      const jobRef = summaryRef.collection("jobs").doc(jobId);
      const orderRef = db.collection("accounts").doc(shop).collection("orders").doc(String(jobId));
      const order = await orderRef.get();
      let awb = "";
      let courier = "";
      if (order.exists) {
        awb = order.get("awb");
        courier = order.get("courier");
      }

      const [accountSnap, jobSnap] = await Promise.all([
        db.collection("accounts").doc(shop).get(),
        jobRef.get(),
      ]);

      if (!accountSnap.exists) {
        res.status(404).json({ error: "shop_not_found" });
        return;
      }
      const accessToken = accountSnap.get("accessToken");
      if (!accessToken) {
        res.status(500).json({ error: "missing_access_token" });
        return;
      }

      if (!jobSnap.exists) {
        // Deleted or missing job: ack and move on (idempotency)
        res.json({ noop: true });
        return;
      }

      const job = jobSnap.data()!;
      if (job.status === "success") {
        res.json({ alreadyDone: true });
        return;
      }

      const MAX_ATTEMPTS = Number(process.env.FULFILLMENT_QUEUE_MAX_ATTEMPTS) || 3;

      // mark processing + attempt++
      await Promise.all([
        jobRef.set(
          {
            status: "processing",
            attempts: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        ),
        summaryRef.update({ processing: FieldValue.increment(1) }),
      ]);

      try {
        const result = await fulfillOrderOnShopify(shop, accessToken, orderId, awb, courier);

        await Promise.all([
          jobRef.set(
            {
              status: "success",
              fulfillmentId: result.fulfillmentId ?? null,
              nothingToDo: !!result.nothingToDo,
              errorCode: FieldValue.delete(),
              errorMessage: FieldValue.delete(),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          ),
          summaryRef.update({
            processing: FieldValue.increment(-1),
            success: FieldValue.increment(1),
          }),
          orderRef.set(
            {
              customStatus: "Dispatched",
              customStatusesLogs: FieldValue.arrayUnion({
                status: "Dispatched",
                createdAt: Timestamp.now(),
                remarks: `The order's shipment was dipatched from the warehouse.`,
              }),
            },
            { merge: true },
          ),
        ]);

        await maybeCompleteSummary(summaryRef);
        res.json({ ok: true });
        return;
      } catch (err: any) {
        const attempts = (job.attempts ?? 0) + 1;
        const codeStr: string = err?.code || "UNKNOWN";
        const httpCode = /^HTTP_(\d+)$/.exec(codeStr)?.[1];
        const retryable = httpCode ? httpRetryable(Number(httpCode)) : true;

        if (retryable) {
          const areAttempsExhausted = attempts >= Number(MAX_ATTEMPTS);
          await Promise.all([
            jobRef.set(
              {
                status: areAttempsExhausted ? "failed" : "retrying",
                errorCode: codeStr,
                errorMessage: (err?.detail || err?.message || "").slice(0, 400),
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true },
            ),
            summaryRef.update(
              areAttempsExhausted
                ? { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) }
                : { processing: FieldValue.increment(-1) },
            ),
          ]);

          await maybeCompleteSummary(summaryRef);
          // 503 tells Cloud Tasks to retry per queue policy
          res.status(503).json({ retry: true, reason: codeStr });
          return;
        } else {
          await Promise.all([
            jobRef.set(
              {
                status: "failed",
                errorCode: codeStr,
                errorMessage: (err?.detail || err?.message || "").slice(0, 400),
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true },
            ),
            summaryRef.update({
              processing: FieldValue.increment(-1),
              failed: FieldValue.increment(1),
            }),
          ]);
          await maybeCompleteSummary(summaryRef);
          res.json({ failed: true, reason: codeStr });
          return;
        }
      }
    } catch (e: any) {
      console.error("processFulfillmentTask error:", e);
      res.status(500).json({ error: "worker_failed", details: String(e?.message ?? e) });
      return;
    }
  },
);

async function maybeCompleteSummary(summaryRef: DocumentReference) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(summaryRef);
    if (!snap.exists) return;
    const d = snap.data() as any;
    const total = d.total ?? 0;
    const done = (d.success ?? 0) + (d.failed ?? 0);
    const processing = d.processing ?? 0;

    if (done >= total && processing === 0 && d.status !== "complete") {
      tx.update(summaryRef, { status: "complete", completedAt: FieldValue.serverTimestamp() });
    }
  });
}

/** Scheduled function that runs 6 times daily to enqueue status update tasks */
export const enqueueStatusUpdateTasksScheduled = onSchedule(
  {
    schedule: "0 0,4,8,12,16,20 * * *", // 12am, 4am, 8am, 12pm, 4pm, 8pm daily
    timeZone: "Asia/Kolkata",
    region: process.env.LOCATION || "asia-south1",
    memory: "512MiB",
    timeoutSeconds: 540, // 9 minutes
    secrets: [TASKS_SECRET],
  },
  async (event) => {
    console.log(`Starting scheduled status update batch processing... ${event ? "" : ""}`);

    try {
      // Get all users who have active accounts with Delhivery integration
      const usersSnapshot = await db.collection("users").where("activeAccountId", "!=", null).get();

      if (usersSnapshot.empty) {
        console.log("No users with active accounts found");
        return;
      }

      console.log(`Found ${usersSnapshot.size} users with active accounts`);

      // Filter users whose accounts have Delhivery configured
      const eligibleUserIds: string[] = [];

      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const activeAccountId = userDoc.get("activeAccountId");

        if (!activeAccountId) continue;

        try {
          const accountDoc = await db.collection("accounts").doc(activeAccountId).get();
          if (!accountDoc.exists) continue;

          const apiKey = accountDoc.data()?.integrations?.couriers?.delhivery?.apiKey;
          if (apiKey) {
            eligibleUserIds.push(userId);
          }
        } catch (error) {
          console.error(`Error checking account ${activeAccountId} for user ${userId}:`, error);
        }
      }

      if (eligibleUserIds.length === 0) {
        console.log("No users with Delhivery integration found");
        return;
      }

      console.log(`Found ${eligibleUserIds.length} users with Delhivery integration`);

      // Create global batch header
      const batchRef = db.collection("status_update_batches").doc();
      const batchId = batchRef.id;

      await batchRef.set({
        createdAt: FieldValue.serverTimestamp(),
        createdBy: "system-scheduled",
        total: eligibleUserIds.length,
        queued: eligibleUserIds.length,
        status: "running", // queued | running | completed
        processing: 0,
        success: 0,
        failed: 0,
        type: "status_update",
        schedule: "6x_daily",
      });

      // Create job documents
      const writer = db.bulkWriter();
      for (const userId of eligibleUserIds) {
        writer.set(
          batchRef.collection("jobs").doc(userId), // userId as jobId since one job per user
          {
            userId,
            status: "queued",
            attempts: 0,
            createdAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
      await writer.close();

      // Get the target URL for status update tasks
      const targetUrl = process.env.UPDATE_STATUS_TASK_JOB_TARGET_URL;
      if (!targetUrl) {
        throw new Error("UPDATE_STATUS_TASK_TARGET_URL not configured");
      }

      // Create one Cloud Task per user
      await Promise.all(
        eligibleUserIds.map((userId) =>
          createTask(
            {
              userId,
              batchId,
              jobId: userId, // userId as jobId
            } as any,
            {
              tasksSecret: TASKS_SECRET.value() || "",
              url: targetUrl,
              queue: process.env.STATUS_UPDATE_QUEUE_NAME || "statuses-updates-queue",
              delaySeconds: Math.floor(Math.random() * 300), // Random delay 0-5 minutes to spread load
            },
          ),
        ),
      );

      await batchRef.update({ status: "running" });

      console.log(
        `Successfully enqueued ${eligibleUserIds.length} status update tasks in batch ${batchId}`,
      );
    } catch (error) {
      console.error("enqueueStatusUpdateTasks failed:", error);
      throw error; // This will mark the scheduled function as failed in Cloud Scheduler
    }
  },
);

/** Cloud Tasks → updates Delhivery shipment statuses for a user's orders */
export const updateDelhiveryStatusesJob = onRequest(
  { cors: true, timeoutSeconds: 300, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    // --- Helper functions ---
    async function maybeCompleteBatch(batchRef: DocumentReference) {
      await db.runTransaction(async (tx) => {
        const b = await tx.get(batchRef);
        const d = b.data() || {};
        const total = Number(d.total || 0);
        const success = Number(d.success || 0);
        const failed = Number(d.failed || 0);
        const processing = Number(d.processing || 0);
        if (total && success + failed === total && processing === 0) {
          tx.update(batchRef, { status: "completed" });
        }
      });
    }

    async function attemptsExhausted(jobRef: DocumentReference) {
      const snap = await jobRef.get();
      const data = snap.data() || {};
      const attempts = Number(data.attempts || 0);
      return attempts >= Number(process.env.STATUS_UPDATE_QUEUE_MAX_ATTEMPTS || 1);
    }

    try {
      // Authentication
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { userId, batchId, jobId } = (req.body || {}) as {
        userId?: string;
        batchId?: string;
        jobId?: string;
      };

      if (!userId || !batchId || !jobId) {
        res.status(400).json({ error: "missing_required_params" });
        return;
      }

      // Setup references
      const batchRef = db.collection("status_update_batches").doc(batchId);

      const jobRef = batchRef.collection("jobs").doc(jobId);

      // Idempotency: if already success, just ack
      const jSnap = await jobRef.get();
      if (jSnap.exists && jSnap.data()?.status === "success") {
        res.json({ ok: true, dedup: true });
        return;
      }

      // Get user's active account
      const userDoc = await db.collection("users").doc(userId).get();
      if (!userDoc.exists) {
        throw new Error("USER_NOT_FOUND");
      }

      const activeAccountId = userDoc.get("activeAccountId");
      if (!activeAccountId) {
        throw new Error("NO_ACTIVE_ACCOUNT");
      }

      // --- Start bookkeeping (transaction) ---
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(jobRef);
        const data = snap.data() || {};
        const prevAttempts = Number(data.attempts || 0);
        const firstAttempt = prevAttempts === 0 || data.status === "queued" || !data.status;

        // move to processing, increment attempts
        tx.set(
          jobRef,
          {
            status: "processing",
            attempts: (prevAttempts || 0) + 1,
            lastAttemptAt: new Date(),
            userId,
            accountId: activeAccountId,
          },
          { merge: true },
        );

        const inc: any = { processing: FieldValue.increment(1) };
        if (firstAttempt) inc.queued = FieldValue.increment(-1);
        tx.update(batchRef, inc);
      });
      // -----------------------------------------------------------------------

      // Get account and API key
      const accountDoc = await db.collection("accounts").doc(activeAccountId).get();
      if (!accountDoc.exists) {
        throw new Error("ACCOUNT_NOT_FOUND");
      }

      const apiKey = accountDoc.data()?.integrations?.couriers?.delhivery?.apiKey;
      if (!apiKey) {
        throw new Error("API_KEY_MISSING");
      }

      // Statuses to exclude
      const excludedStatuses = new Set([
        "New",
        "Confirmed",
        "Ready To Dispatch",
        "Lost",
        "Delivered",
        "RTO Delivered",
        "Closed",
        "RTO Closed",
        "DTO Delivered",
        "Cancelled",
      ]);

      // Get eligible orders for this account
      const ordersSnapshot = await db
        .collection("accounts")
        .doc(activeAccountId)
        .collection("orders")
        .where("courier", "==", "Delhivery")
        .get();

      const eligibleOrders = ordersSnapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter(
          (order: any) =>
            order.awb && order.customStatus && !excludedStatuses.has(order.customStatus),
        );

      if (eligibleOrders.length === 0) {
        // No eligible orders - mark job as success
        await Promise.all([
          jobRef.update({
            status: "success",
            message: "no_eligible_orders",
            total: 0,
            updated: 0,
            errorCode: FieldValue.delete(),
            errorMessage: FieldValue.delete(),
          }),
          batchRef.update({
            processing: FieldValue.increment(-1),
            success: FieldValue.increment(1),
          }),
        ]);

        await maybeCompleteBatch(batchRef);
        res.json({ ok: true, message: "no_eligible_orders", total: 0, updated: 0 });
        return;
      }

      console.log(`Found ${eligibleOrders.length} eligible orders for status update`);

      // Process orders in batches of 50
      const batchSize = 50;
      let totalUpdated = 0;
      const updatePromises: Promise<any>[] = [];
      const errors: string[] = [];

      for (let i = 0; i < eligibleOrders.length; i += batchSize) {
        const batch = eligibleOrders.slice(i, i + batchSize);
        const waybills = batch
          .map((order: any) => (order.customStatus.includes("DTO") ? order.awb_reverse : order.awb))
          .join(",");

        try {
          // Call Delhivery tracking API
          const trackingUrl = `https://track.delhivery.com/api/v1/packages/json/?waybill=${waybills}`;
          const response = await fetch(trackingUrl, {
            headers: {
              Authorization: `Token ${apiKey}`,
              Accept: "application/json",
            },
          });

          if (!response.ok) {
            const errorMsg = `Delhivery API error for batch ${i / batchSize + 1}: ${response.status}`;
            console.error(errorMsg);
            errors.push(errorMsg);

            // If this is a retryable HTTP error, we should retry the whole job
            if (response.status >= 500 || response.status === 429) {
              throw new Error(`HTTP_${response.status}`);
            }
            continue;
          }

          const trackingData = (await response.json()) as any;
          const shipments = trackingData.ShipmentData || [];

          // Create map of order name to order for efficient lookup
          const ordersByName = new Map();
          batch.forEach((order: any) => {
            if (order.name) {
              ordersByName.set(order.name, order);
            }
          });

          // Process each shipment
          for (const shipmentWrapper of shipments) {
            const shipment = shipmentWrapper.Shipment;
            if (!shipment || !shipment.ReferenceNo) continue;

            const order = ordersByName.get(shipment.ReferenceNo);
            if (!order) continue;

            const status = shipment.Status;
            if (!status) continue;

            // Determine new status based on Delhivery response
            let newStatus: string | null = null;

            if (status.Status === "In Transit" && status.StatusType === "UD") {
              newStatus = "In Transit";
            } else if (status.Status === "Pending" && status.StatusType === "UD") {
              newStatus = "In Transit";
            } else if (status.Status === "In Transit" && status.StatusType === "RT") {
              newStatus = "RTO In Transit";
            } else if (status.Status === "Pending" && status.StatusType === "RT") {
              newStatus = "RTO In Transit";
            } else if (status.Status === "Dispatched" && status.StatusType === "UD") {
              newStatus = "Out For Delivery";
            } else if (status.Status === "Delivered" && status.StatusType === "DL") {
              newStatus = "Delivered";
            } else if (status.Status === "Delivered" && status.StatusType === "RT") {
              newStatus = "RTO Delivered";
            } else if (status.Status === "In Transit" && status.StatusType === "PU") {
              newStatus = "DTO In Transit";
            } else if (status.Status === "Pending" && status.StatusType === "PU") {
              newStatus = "DTO In Transit";
            } else if (status.Status === "Delivered" && status.StatusType === "PU") {
              newStatus = "DTO Delivered";
            } else if (status.Status === "Lost" && status.StatusType === "LT") {
              newStatus = "Lost";
            }

            // Update order if status changed
            if (newStatus && newStatus !== order.customStatus) {
              const orderRef = db
                .collection("accounts")
                .doc(activeAccountId)
                .collection("orders")
                .doc(order.id);

              updatePromises.push(
                orderRef
                  .update({
                    customStatus: newStatus,
                    lastStatusUpdate: FieldValue.serverTimestamp(),
                    customStatusesLogs: FieldValue.arrayUnion({
                      status: newStatus,
                      createdAt: Timestamp.now(),
                      remarks: (() => {
                        let remarks = "";
                        switch (newStatus) {
                          case "In Transit":
                            remarks = "This order was being moved from origin to the destination";
                            break;
                          case "RTO In Transit":
                            remarks =
                              "This order was returned and being moved from pickup to origin";
                            break;
                          case "Out For Delivery":
                            remarks = "This order was about to reach its final destination";
                            break;
                          case "Delivered":
                            remarks = "This order was successfully delivered to its destination";
                            break;
                          case "RTO Delivered":
                            remarks = "This order was successfully returned to its destination";
                            break;
                          case "DTO In Transit":
                            remarks =
                              "This order was returned by the customer and was being moved to the origin";
                            break;
                          case "DTO Delivered":
                            remarks =
                              "This order was returned by the customer and successfully returned to its origin";
                            break;
                          case "Lost":
                            remarks = "This order was lost";
                            break;
                        }
                        return remarks;
                      })(),
                    }),
                  })
                  .then(() => {
                    console.log(`Updated order ${order.id} (${order.name}) to ${newStatus}`);
                    return 1;
                  })
                  .catch((error) => {
                    console.error(`Failed to update order ${order.id}:`, error);
                    errors.push(`Failed to update order ${order.id}: ${error.message}`);
                    return 0;
                  }),
              );
            }
          }

          // Small delay between API calls to be respectful
          if (i + batchSize < eligibleOrders.length) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (error: any) {
          const errorMsg = `Error processing batch ${i / batchSize + 1}: ${error.message}`;
          console.error(errorMsg);
          errors.push(errorMsg);

          // If it's a retryable HTTP error, rethrow to trigger job retry
          if (error.message.startsWith("HTTP_")) {
            throw error;
          }
        }
      }

      // Wait for all updates to complete
      const updateResults = await Promise.all(updatePromises);
      totalUpdated = updateResults.reduce((sum, result) => sum + result, 0);

      console.log(
        `Status update completed: ${totalUpdated}/${eligibleOrders.length} orders updated`,
      );

      // Mark job as successful
      await Promise.all([
        jobRef.update({
          status: "success",
          message: "status_update_completed",
          total: eligibleOrders.length,
          updated: totalUpdated,
          errors: errors.length > 0 ? errors.slice(0, 10) : FieldValue.delete(), // Limit errors to prevent doc size issues
          errorCode: FieldValue.delete(),
          errorMessage: FieldValue.delete(),
        }),
        batchRef.update({
          processing: FieldValue.increment(-1),
          success: FieldValue.increment(1),
        }),
      ]);

      await maybeCompleteBatch(batchRef);
      res.json({
        ok: true,
        message: "status_update_completed",
        total: eligibleOrders.length,
        updated: totalUpdated,
        userId,
        accountId: activeAccountId,
        batchId,
        jobId,
      });
    } catch (error: any) {
      console.error("updateDelhiveryStatuses error:", error);

      const msg = error instanceof Error ? error.message : String(error);
      const code = msg.split(/\s/)[0]; // first token
      const NON_RETRYABLE = new Set([
        "USER_NOT_FOUND",
        "NO_ACTIVE_ACCOUNT",
        "ACCOUNT_NOT_FOUND",
        "API_KEY_MISSING",
      ]);
      const isRetryable = !NON_RETRYABLE.has(code);

      try {
        const { userId, batchId, jobId } = (req.body || {}) as {
          userId?: string;
          batchId?: string;
          jobId?: string;
        };

        if (userId && batchId && jobId) {
          const batchRef = db.collection("status_update_batches").doc(batchId);
          const jobRef = batchRef.collection("jobs").doc(jobId);

          const areAttemptsExhausted = await attemptsExhausted(jobRef);

          await Promise.all([
            jobRef.set(
              {
                status: isRetryable ? (areAttemptsExhausted ? "failed" : "retrying") : "failed",
                errorCode: isRetryable ? "EXCEPTION" : code,
                errorMessage: msg.slice(0, 400),
              },
              { merge: true },
            ),
            batchRef.update(
              isRetryable
                ? areAttemptsExhausted
                  ? { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) }
                  : { processing: FieldValue.increment(-1) }
                : { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) },
            ),
          ]);

          await maybeCompleteBatch(batchRef);
        }
      } catch (e) {
        // Best effort
        console.error("Failed to update job with error status:", e);
      }

      if (isRetryable) {
        res.status(503).json({ error: "job_failed_transient", code, message: msg });
      } else {
        res.status(200).json({ ok: false, permanent: true, reason: code, message: msg });
      }
    }
  },
);

/** User callable function → updates Delhivery shipment statuses for a user's orders */
export const updateDelhiveryStatusesManual = onRequest(
  { cors: true, timeoutSeconds: 300, secrets: [ENQUEUE_FUNCTION_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
    try {
      // Authentication
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { shop, orderIds, requestedBy } = (req.body || {}) as {
        shop?: string;
        orderIds?: string[];
        requestedBy?: string;
      };

      if (!shop) {
        res.status(400).json({ error: "missing_shop_id" });
        return;
      }

      if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
        res.status(400).json({ error: "missing_or_empty_order_ids" });
        return;
      }

      // Get account and API key
      const accountDoc = await db.collection("accounts").doc(shop).get();
      if (!accountDoc.exists) {
        res.status(404).json({ error: "account_not_found" });
        return;
      }

      const apiKey = accountDoc.data()?.integrations?.couriers?.delhivery?.apiKey;
      if (!apiKey) {
        res.status(400).json({ error: "delhivery_api_key_missing" });
        return;
      }

      // Statuses to exclude
      const excludedStatuses = new Set([
        "New",
        "Confirmed",
        "Ready To Dispatch",
        "Lost",
        "Delivered",
        "RTO Delivered",
        "Closed",
        "RTO Closed",
        "DTO Delivered",
        "Cancelled",
      ]);

      // Get eligible orders for this account using the provided orderIds
      const ordersRefs = orderIds.map((orderId) =>
        db.collection("accounts").doc(shop).collection("orders").doc(orderId),
      );

      // Fetch orders in batches to avoid Firestore limits
      const orderDocs: any[] = [];
      let batchSize = 500; // Firestore getAll limit

      for (let i = 0; i < ordersRefs.length; i += batchSize) {
        const batch = ordersRefs.slice(i, i + batchSize);
        const docs = await db.getAll(...batch);
        orderDocs.push(...docs);
      }

      // Filter existing orders and map to our format
      const existingOrders = orderDocs
        .filter((doc) => doc.exists)
        .map((doc) => ({ id: doc.id, ...doc.data() }));

      if (existingOrders.length === 0) {
        res.status(404).json({
          error: "no_orders_found",
          message: "None of the provided order IDs exist in the account",
          requestedCount: orderIds.length,
          accountId: shop,
        });
        return;
      }

      // Filter eligible orders (Delhivery orders with AWB and not in excluded statuses)
      const eligibleOrders = existingOrders.filter(
        (order: any) =>
          order.courier === "Delhivery" &&
          order.awb &&
          order.customStatus &&
          !excludedStatuses.has(order.customStatus),
      );

      if (eligibleOrders.length === 0) {
        res.json({
          error: "no_eligible_orders",
          total: 0,
          updated: 0,
          accountId: shop,
        });
        return;
      }

      console.log(
        `Found ${eligibleOrders.length} eligible orders for status update (shop: ${shop})`,
      );

      // Process orders in batches of 50
      batchSize = 50;
      let totalUpdated = 0;
      const updatePromises: Promise<any>[] = [];
      const errors: string[] = [];
      const updatedOrders: any[] = [];

      for (let i = 0; i < eligibleOrders.length; i += batchSize) {
        const batch = eligibleOrders.slice(i, i + batchSize);
        const waybills = batch
          .map((order: any) => (order.customStatus.includes("DTO") ? order.awb_reverse : order.awb))
          .join(",");

        try {
          // Call Delhivery tracking API
          const trackingUrl = `https://track.delhivery.com/api/v1/packages/json/?waybill=${waybills}`;
          const response = await fetch(trackingUrl, {
            headers: {
              Authorization: `Token ${apiKey}`,
              Accept: "application/json",
            },
          });

          if (!response.ok) {
            const errorMsg = `Delhivery API error for batch ${i / batchSize + 1}: ${response.status}`;
            console.error(errorMsg);
            errors.push(errorMsg);
            continue;
          }

          const trackingData = (await response.json()) as any;
          const shipments = trackingData.ShipmentData || [];

          // Create map of order name to order for efficient lookup
          const ordersByName = new Map();
          batch.forEach((order: any) => {
            if (order.name) {
              ordersByName.set(order.name, order);
            }
          });

          // Process each shipment
          for (const shipmentWrapper of shipments) {
            const shipment = shipmentWrapper.Shipment;
            if (!shipment || !shipment.ReferenceNo) continue;

            const order = ordersByName.get(shipment.ReferenceNo);
            if (!order) continue;

            const status = shipment.Status;
            if (!status) continue;

            // Determine new status based on Delhivery response
            let newStatus: string | null = null;

            if (status.Status === "In Transit" && status.StatusType === "UD") {
              newStatus = "In Transit";
            } else if (status.Status === "Pending" && status.StatusType === "UD") {
              newStatus = "In Transit";
            } else if (status.Status === "In Transit" && status.StatusType === "RT") {
              newStatus = "RTO In Transit";
            } else if (status.Status === "Pending" && status.StatusType === "RT") {
              newStatus = "RTO In Transit";
            } else if (status.Status === "Dispatched" && status.StatusType === "UD") {
              newStatus = "Out For Delivery";
            } else if (status.Status === "Delivered" && status.StatusType === "DL") {
              newStatus = "Delivered";
            } else if (status.Status === "Delivered" && status.StatusType === "RT") {
              newStatus = "RTO Delivered";
            } else if (status.Status === "In Transit" && status.StatusType === "PU") {
              newStatus = "DTO In Transit";
            } else if (status.Status === "Pending" && status.StatusType === "PU") {
              newStatus = "DTO In Transit";
            } else if (status.Status === "Delivered" && status.StatusType === "PU") {
              newStatus = "DTO Delivered";
            } else if (status.Status === "Lost" && status.StatusType === "LT") {
              newStatus = "Lost";
            }

            // Update order if status changed
            if (newStatus && newStatus !== order.customStatus) {
              const orderRef = db
                .collection("accounts")
                .doc(shop)
                .collection("orders")
                .doc(order.id);

              updatePromises.push(
                orderRef
                  .update({
                    customStatus: newStatus,
                    lastStatusUpdate: FieldValue.serverTimestamp(),
                    lastManualUpdate: FieldValue.serverTimestamp(),
                    lastUpdateRequestedBy: requestedBy || "manual",
                    customStatusesLogs: FieldValue.arrayUnion({
                      status: newStatus,
                      createdAt: Timestamp.now(),
                      remarks: (() => {
                        let remarks = ``;
                        switch (newStatus) {
                          case "In Transit":
                            remarks = "This order was being moved from origin to the destination";
                            break;
                          case "RTO In Transit":
                            remarks =
                              "This order was returned and being moved from pickup to origin";
                            break;
                          case "Out For Delivery":
                            remarks = "This order was about to reach its final destination";
                            break;
                          case "Delivered":
                            remarks = "This order was successfully delivered to its destination";
                            break;
                          case "RTO Delivered":
                            remarks = "This order was successfully returned to its destination";
                            break;
                          case "DTO In Transit":
                            remarks =
                              "This order was returned by the customer and was being moved to the origin";
                            break;
                          case "DTO Delivered":
                            remarks =
                              "This order was returned by the customer and successfully returned to its origin";
                            break;
                          case "Lost":
                            remarks = "This order was lost";
                            break;
                        }
                        return remarks;
                      })(),
                    }),
                  })
                  .then(() => {
                    console.log(
                      `Updated order ${order.id} (${order.name}) from ${order.customStatus} to ${newStatus}`,
                    );
                    updatedOrders.push({
                      orderId: order.id,
                      orderName: order.name,
                      oldStatus: order.customStatus,
                      newStatus: newStatus,
                      awb: order.awb,
                    });
                    return 1;
                  })
                  .catch((error) => {
                    console.error(`Failed to update order ${order.id}:`, error);
                    errors.push(`Failed to update order ${order.id}: ${error.message}`);
                    return 0;
                  }),
              );
            }
          }

          // Small delay between API calls to be respectful
          if (i + batchSize < eligibleOrders.length) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (error: any) {
          const errorMsg = `Error processing batch ${i / batchSize + 1}: ${error.message}`;
          console.error(errorMsg);
          errors.push(errorMsg);
        }
      }

      // Wait for all updates to complete
      const updateResults = await Promise.all(updatePromises);
      totalUpdated = updateResults.reduce((sum, result) => sum + result, 0);

      console.log(
        `Manual status update completed: ${totalUpdated}/${eligibleOrders.length} orders updated for shop ${shop}`,
      );

      res.json({
        message: "status_update_completed",
        total: eligibleOrders.length,
        updated: totalUpdated,
        accountId: shop,
        requestedBy: requestedBy || "manual",
        timestamp: new Date().toISOString(),
        updatedOrders: updatedOrders.slice(0, 20), // Limit to first 20 for response size
        errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
        summary: {
          apiCallsMade: Math.ceil(eligibleOrders.length / batchSize),
          ordersProcessed: eligibleOrders.length,
          ordersUpdated: totalUpdated,
          ordersSkipped: eligibleOrders.length - totalUpdated,
          errorsEncountered: errors.length,
        },
      });
    } catch (error: any) {
      console.error("updateDelhiveryStatusesManual error:", error);
      res.status(500).json({
        error: "status_update_failed",
        details: String(error?.message ?? error),
        timestamp: new Date().toISOString(),
      });
    }
  },
);
