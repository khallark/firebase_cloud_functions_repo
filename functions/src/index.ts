// functions/src/index.ts
import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";
import fetch from "node-fetch";
import { db, FieldValue } from "./firebaseAdmin";
import { createTask } from "./cloudTasks";
import { allocateAwb, releaseAwb } from "./awb";
import { buildDelhiveryPayload, buildShiprocketPayload } from "./buildPayload";
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

      const { shop, batchId, jobIds, courier, pickupName, shippingMode } = (req.body || {}) as {
        shop?: string;
        batchId?: string;
        jobIds?: string[];
        courier?: string;
        pickupName?: string;
        shippingMode?: string;
      };

      if (
        !shop ||
        !batchId ||
        !courier ||
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
            { shop, batchId, jobId, courier, pickupName, shippingMode },
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

// outer catch non-retryable error codes
const NON_RETRYABLE = new Set(["CARRIER_KEY_MISSING", "ORDER_NOT_FOUND"]);

/** Cloud Tasks → processes exactly ONE shipment job */
export const processShipmentTask = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req: Request, res: Response): Promise<void> => {
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

    /** Classify Delhivery create-shipment response */
    function evalDelhiveryResp(carrier: any): {
      ok: boolean;
      retryable: boolean;
      code: string;
      message: string;
      carrierShipmentId?: string | null;
    } {
      const lowerRmk = String(carrier?.rmk ?? "").toLowerCase();

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

      // Known permanent validation errors (don’t retry)
      if (lowerRmk.includes("format key missing")) {
        return {
          ok: false,
          retryable: false,
          code: "FORMAT_MISSING",
          message: carrier?.rmk || "format key missing",
        };
      }
      if (
        lowerRmk.includes("pickup") &&
        (lowerRmk.includes("name") || lowerRmk.includes("location"))
      ) {
        return {
          ok: false,
          retryable: false,
          code: "PICKUP_NAME_INVALID",
          message: carrier?.rmk || "invalid pickup name",
        };
      }
      if (lowerRmk.includes("duplicate") || lowerRmk.includes("already exists")) {
        return {
          ok: false,
          retryable: false,
          code: "DUPLICATE_ORDER",
          message: carrier?.rmk || "duplicate order/waybill",
        };
      }
      if (
        lowerRmk.includes("gst") ||
        lowerRmk.includes("hsn") ||
        lowerRmk.includes("e-waybill") ||
        lowerRmk.includes("ewaybill")
      ) {
        return {
          ok: false,
          retryable: false,
          code: "GST_OR_EWAYBILL",
          message: carrier?.rmk || "gst/e-waybill validation failed",
        };
      }
      if (carrier?.error === true && carrier?.success === false && carrier?.packages_count === 0) {
        // looks like a hard validation error without a helpful rmk
        return {
          ok: false,
          retryable: false,
          code: "VALIDATION_FAILED",
          message: carrier?.rmk || "validation failed",
        };
      }

      // Anything else: treat as transient/carrier-side ambiguity → retry
      return {
        ok: false,
        retryable: true,
        code: "CARRIER_AMBIGUOUS",
        message: carrier?.rmk || "carrier error",
      };
    }

    /** Decide if an HTTP failure status is retryable */
    function httpRetryable(status: number) {
      // 5xx and 429 are retryable; 4xx are usually permanent
      if (status === 429) return true;
      if (status >= 500) return true;
      return false;
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

      // Mark processing (attempt +1)
      await Promise.all([
        jobRef.set(
          { status: "processing", attempts: FieldValue.increment(1), lastAttemptAt: new Date() },
          { merge: true },
        ),
        batchRef.update({ queued: FieldValue.increment(-1), processing: FieldValue.increment(1) }),
      ]);

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

      try {
        // Best-effort extraction of destination pincode from the order
        const pinCandidate = order?.shippingAddress?.zip ?? order?.billing_address?.zip ?? "";

        const pinMatch = String(pinCandidate ?? "").match(/\d{6}/);
        const destPin = pinMatch ? pinMatch[0] : "";

        if (destPin) {
          // Use staging if your base URL mentions staging; otherwise prod
          const svcBase = "https://track.delhivery.com";
          const svcUrl = `${svcBase}/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(destPin)}`;

          const svcResp = await fetch(svcUrl, {
            method: "GET",
            headers: { Authorization: `Token ${apiKey}`, Accept: "application/json" },
          });

          if (svcResp.ok) {
            const svcText = await svcResp.text();
            let svcData: any;
            try {
              svcData = JSON.parse(svcText);
            } catch {
              svcData = svcText; // keep raw for debugging
            }

            const list = Array.isArray(svcData) ? svcData : null;
            const remark = String(list?.[0]?.remark ?? list?.[0]?.remarks ?? "")
              .trim()
              .toLowerCase();

            // Empty list => NSZ (not serviceable) -> PERMANENT failure for Delhivery
            if (!list || list.length === 0) {
              if (awb && !awbReleased) {
                try {
                  await releaseAwb(shop, awb);
                } catch (e) {
                  void e;
                }
              }
              awbReleased = true;

              await Promise.all([
                jobRef.set(
                  {
                    status: "failed",
                    errorCode: "PINCODE_UNSERVICEABLE",
                    errorMessage: "Delhivery: pincode not serviceable (NSZ)",
                    apiResp: svcData,
                  },
                  { merge: true },
                ),
                batchRef.update({
                  processing: FieldValue.increment(-1),
                  failed: FieldValue.increment(1),
                }),
              ]);

              return void res
                .status(200)
                .json({ ok: false, permanent: true, reason: "PINCODE_UNSERVICEABLE" });
            }

            // "Embargo" => temporary NSZ -> treat as non-retryable here
            if (remark === "embargo") {
              if (awb && !awbReleased) {
                try {
                  await releaseAwb(shop, awb);
                } catch (e) {
                  void e;
                }
              }
              awbReleased = true;

              await Promise.all([
                jobRef.set(
                  {
                    status: "failed",
                    errorCode: "PINCODE_EMBARGO",
                    errorMessage: "Delhivery: temporary embargo on this pincode",
                    apiResp: svcData,
                  },
                  { merge: true },
                ),
                batchRef.update({
                  processing: FieldValue.increment(-1),
                  failed: FieldValue.increment(1),
                }),
              ]);

              return void res
                .status(200)
                .json({ ok: false, permanent: true, reason: "PINCODE_EMBARGO" });
            }
          }
          // If serviceability API is down or non-2xx, silently continue to create-shipment.
        }
      } catch (e) {
        void e;
      }

      // Call Delhivery (IMPORTANT: format=json&data=<json>)  – see docs/FAQ
      const base = "https://track.delhivery.com";
      const path = "/api/cmu/create.json";
      const body = new URLSearchParams({ format: "json", data: JSON.stringify(payload) }); // ← required
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
        // Release AWB (so next retry can take a fresh one)
        await releaseAwb(shop, awb);
        awbReleased = true;

        // Retry on 429/5xx; otherwise mark failed permanently
        if (httpRetryable(resp.status)) {
          // record and ask Cloud Tasks to retry (503)
          await Promise.all([
            jobRef.set(
              {
                status: "retrying",
                errorCode: `HTTP_${resp.status}`,
                errorMessage: text.slice(0, 400),
              },
              { merge: true },
            ),
            batchRef.update({ processing: FieldValue.increment(-1) }),
          ]);
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
          return void res
            .status(200)
            .json({ ok: false, permanent: true, reason: `http_${resp.status}` });
        }
      }

      // Parse and evaluate carrier JSON
      const carrier = parseJson(text);
      const verdict = evalDelhiveryResp(carrier);

      if (!verdict.ok) {
        // Release AWB in all failure cases so the next attempt can pick a fresh number
        if (awb && !awbReleased) {
          try {
            await releaseAwb(shop, awb);
          } catch (e) {
            void e;
          }
        }
        awbReleased = true;

        if (verdict.retryable) {
          await Promise.all([
            jobRef.set(
              {
                status: "retrying",
                errorCode: verdict.code,
                errorMessage: verdict.message,
                apiResp: carrier,
              },
              { merge: true },
            ),
            batchRef.update({ processing: FieldValue.increment(-1) }),
          ]);
          // 503 → Cloud Tasks will retry with backoff
          return void res.status(503).json({ retry: true, reason: verdict.code });
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
          // 200 → stop retries, we recorded a permanent failure
          return void res.status(200).json({ ok: false, permanent: true, reason: verdict.code });
        }
      }

      // Success path
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
            shipmentStatus: "created",
            courier: "Delhivery",
            customStatus: "Ready To Dispatch",
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

      return void res.json({ ok: true, awb, carrierShipmentId: verdict.carrierShipmentId ?? null });
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
          await Promise.all([
            jobRef.set(
              {
                status: isRetryable ? "retrying" : "failed",
                errorCode: isRetryable ? "EXCEPTION" : code,
                errorMessage: code,
              },
              { merge: true },
            ),
            batchRef.update(
              isRetryable
                ? { processing: FieldValue.increment(-1) }
                : { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) },
            ),
          ]);
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
      const lower = rawMsg.toLowerCase();

      // Success shape seen in docs: { order_id, shipment_id, status: "NEW", status_code: 1, ... }
      const looksSuccess =
        sr?.order_id != null &&
        sr?.shipment_id != null &&
        (sr?.status_code === 1 || String(sr?.status || "").toUpperCase() === "NEW");

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
      if (lower.includes("channel id does not exist")) {
        return {
          ok: false,
          retryable: false,
          code: "CHANNEL_NOT_FOUND",
          message: rawMsg || "Given channel id does not exist",
        };
      }

      if (lower.includes("invalid data") || sr?.status_code === 422) {
        if (lower.includes("order id field is required")) {
          return {
            ok: false,
            retryable: false,
            code: "ORDER_ID_REQUIRED",
            message: "The order_id field is required.",
          };
        }
        if (lower.includes("already exist") || lower.includes("duplicate")) {
          return {
            ok: false,
            retryable: false,
            code: "DUPLICATE_ORDER_ID",
            message: rawMsg || "order_id already exists / duplicate",
          };
        }
        return {
          ok: false,
          retryable: false,
          code: "VALIDATION_FAILED",
          message: rawMsg || "validation failed",
        };
      }

      if (
        lower.includes("unauthorized") ||
        lower.includes("invalid token") ||
        sr?.status_code === 401
      ) {
        return {
          ok: false,
          retryable: false,
          code: "AUTH_FAILED",
          message: rawMsg || "unauthorized/invalid token",
        };
      }

      // Anything else: transient/ambiguous → retry
      return {
        ok: false,
        retryable: true,
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

      // Mark processing (attempt +1)
      await Promise.all([
        jobRef.set(
          { status: "processing", attempts: FieldValue.increment(1), lastAttemptAt: new Date() },
          { merge: true },
        ),
        batchRef.update({ queued: FieldValue.increment(-1), processing: FieldValue.increment(1) }),
      ]);

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
          if (httpRetryable(resp.status)) {
            await Promise.all([
              jobRef.set(
                {
                  status: "retrying",
                  errorCode: `HTTP_${resp.status}`,
                  errorMessage: text.slice(0, 400),
                },
                { merge: true },
              ),
              batchRef.update({ processing: FieldValue.increment(-1) }),
            ]);
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
            return void res
              .status(200)
              .json({ ok: false, permanent: true, reason: `http_${resp.status}` });
          }
        }

        const orderCreateJson = parseJson(text);
        const v = evalShiprocketResp(orderCreateJson);
        verdict = v;

        if (!v.ok) {
          if (v.retryable) {
            await Promise.all([
              jobRef.set(
                {
                  status: "retrying",
                  errorCode: v.code,
                  errorMessage: v.message,
                  apiResp: orderCreateJson,
                },
                { merge: true },
              ),
              batchRef.update({ processing: FieldValue.increment(-1) }),
            ]);
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
        if (httpRetryable(awbResp.status)) {
          await Promise.all([
            jobRef.set(
              {
                status: "retrying",
                errorCode: `HTTP_${awbResp.status}`,
                errorMessage: awbText.slice(0, 400),
              },
              { merge: true },
            ),
            batchRef.update({ processing: FieldValue.increment(-1) }),
          ]);
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
      const errBits = [
        awbJson?.message,
        awbJson?.msg,
        awbJson?.error,
        awbJson?.error_message,
        node?.message,
        node?.msg,
        node?.error,
        node?.error_message,
        awbJson?.errors ? JSON.stringify(awbJson.errors) : "",
        node?.errors ? JSON.stringify(node.errors) : "",
      ].filter((s) => typeof s === "string" && s.trim().length);
      const msg = errBits.join(" | ");
      const lower = (msg || "").toLowerCase();

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
              shipmentStatus: "created",
              customStatus: "Ready To Dispatch",

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
      if (
        lower.includes("given shipment id does not exist") ||
        lower.includes("no courier serviceable") ||
        lower.includes("invalid data") ||
        lower.includes("channel id does not exist")
      ) {
        await Promise.all([
          jobRef.set(
            {
              status: "failed",
              errorCode: lower.includes("no courier serviceable")
                ? "NO_SERVICEABLE_COURIER"
                : lower.includes("given shipment id does not exist")
                  ? "SHIPMENT_NOT_FOUND"
                  : lower.includes("channel id does not exist")
                    ? "CHANNEL_NOT_FOUND"
                    : "VALIDATION_FAILED",
              errorMessage: msg || "awb assignment failed",
              apiResp: { awbAssign: awbJson },
            },
            { merge: true },
          ),
          batchRef.update({
            processing: FieldValue.increment(-1),
            failed: FieldValue.increment(1),
          }),
        ]);
        return void res
          .status(200)
          .json({ ok: false, permanent: true, reason: "AWB_ASSIGN_FAILED" });
      }

      // Ambiguous → retry
      await Promise.all([
        jobRef.set(
          {
            status: "retrying",
            errorCode: "CARRIER_AMBIGUOUS",
            errorMessage: msg || "carrier error",
            apiResp: { awbAssign: awbJson },
          },
          { merge: true },
        ),
        batchRef.update({ processing: FieldValue.increment(-1) }),
      ]);
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
          await Promise.all([
            jobRef.set(
              {
                status: isRetryable ? "retrying" : "failed",
                errorCode: isRetryable ? "EXCEPTION" : code,
                errorMessage: code,
              },
              { merge: true },
            ),
            batchRef.update(
              isRetryable
                ? { processing: FieldValue.increment(-1) }
                : { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) },
            ),
          ]);
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
