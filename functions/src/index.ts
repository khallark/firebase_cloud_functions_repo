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
import { getStorage } from "firebase-admin/storage"; // ⬅️ NEW
import { PDFDocument } from "pdf-lib";

setGlobalOptions({ region: process.env.LOCATION || "asia-south1" });

const TASKS_SECRET = defineSecret("TASKS_SECRET");
const ENQUEUE_FUNCTION_SECRET = defineSecret("ENQUEUE_FUNCTION_SECRET");

/** Small helper to require a shared secret header */
function requireHeaderSecret(req: Request, header: string, expected: string) {
  const got = (req.get(header) || "").trim();
  if (!got || got !== (expected || "").trim()) throw new Error(`UNAUTH_${header}`);
}

/** ⬇️ NEW: fetch Delhivery packing slip PDF and store it */
async function fetchAndStorePackingSlip({
  shop,
  awb,
  apiKey,
  pdfSize = "A4",
}: {
  shop: string;
  awb: string;
  apiKey: string;
  pdfSize?: "A4" | "4R" | string;
}) {
  const base = "https://track.delhivery.com";
  const url = `${base}/api/p/packing_slip?wbns=${encodeURIComponent(awb)}&pdf=true&pdf_size=${encodeURIComponent(pdfSize)}`;

  // First call: usually JSON with S3 link
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Token ${apiKey}`,
      // Accept anything; some setups return application/json, some return pdf directly
      Accept: "*/*",
    },
  });

  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  const ab = await resp.arrayBuffer();
  let buf = Buffer.from(ab);

  // Helper: does a buffer look like a PDF?
  const looksPdf = buf.length >= 5 && buf.toString("ascii", 0, 5) === "%PDF-";

  // If the first response is already a PDF, use it.
  // Otherwise parse JSON, pull the S3 URL, and download the PDF.
  if (!looksPdf) {
    let json: any = {};
    try {
      json = JSON.parse(buf.toString("utf8"));
    } catch {
      // Not JSON either — record and bail
      await db
        .collection("accounts")
        .doc(shop)
        .collection("awb_slips")
        .doc(awb)
        .set(
          {
            status: "error",
            error: !resp.ok ? `HTTP_${resp.status}` : "SLIP_NOT_PDF",
            contentType: ct,
            preview:
              ct.includes("text") || ct.includes("json")
                ? buf.toString("utf8").slice(0, 400)
                : `non-text body (len=${buf.length}, ct=${ct})`,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      throw new Error(!resp.ok ? `SLIP_HTTP_${resp.status}` : "SLIP_NOT_PDF");
    }

    // Try to find a PDF URL anywhere in the JSON.
    // (Delhivery responses vary; this generic finder works well.)
    const findPdfUrl = (obj: any): string | null => {
      if (typeof obj === "string" && /^https?:\/\//i.test(obj) && /\.pdf(\?|$)/i.test(obj)) {
        return obj;
      }
      if (obj && typeof obj === "object") {
        for (const k of Object.keys(obj)) {
          const got = findPdfUrl(obj[k]);
          if (got) return got;
        }
      }
      if (Array.isArray(obj)) {
        for (const v of obj) {
          const got = findPdfUrl(v);
          if (got) return got;
        }
      }
      return null;
    };

    const pdfUrl =
      findPdfUrl(json) || json?.pdf || json?.pdf_url || json?.pdfLink || json?.url || null;

    if (!pdfUrl) {
      await db
        .collection("accounts")
        .doc(shop)
        .collection("awb_slips")
        .doc(awb)
        .set(
          {
            status: "error",
            error: "SLIP_URL_NOT_FOUND",
            contentType: ct,
            preview: JSON.stringify(json).slice(0, 400),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      throw new Error("SLIP_URL_NOT_FOUND");
    }

    // Second call: fetch the S3 URL (usually no auth needed)
    const pdfResp = await fetch(pdfUrl);
    if (!pdfResp.ok) {
      await db
        .collection("accounts")
        .doc(shop)
        .collection("awb_slips")
        .doc(awb)
        .set(
          {
            status: "error",
            error: `SLIP_PDF_FETCH_${pdfResp.status}`,
            url: pdfUrl,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      throw new Error(`SLIP_PDF_FETCH_${pdfResp.status}`);
    }
    const pdfAb = await pdfResp.arrayBuffer();
    buf = Buffer.from(pdfAb);

    if (!(buf.length >= 5 && buf.toString("ascii", 0, 5) === "%PDF-")) {
      await db.collection("accounts").doc(shop).collection("awb_slips").doc(awb).set(
        {
          status: "error",
          error: "SLIP_PDF_INVALID",
          url: pdfUrl,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      throw new Error("SLIP_PDF_INVALID");
    }
  }

  // Save to Storage
  const bucket = getStorage().bucket();
  const storagePath = `awb_slips/${shop}/${awb}.pdf`;
  await bucket.file(storagePath).save(buf, {
    contentType: "application/pdf",
    resumable: false,
    metadata: { cacheControl: "public, max-age=31536000" },
  });

  // Index in Firestore
  await db.collection("accounts").doc(shop).collection("awb_slips").doc(awb).set(
    {
      path: storagePath,
      contentType: "application/pdf",
      size: buf.length,
      status: "ready",
      pdfSize,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
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

      // Call Delhivery (IMPORTANT: format=json&data=<json>)
      const base = process.env.CARRIER_BASE_URL || "https://track.delhivery.com";
      const path = process.env.CARRIER_CREATE_PATH || "/api/cmu/create.json";
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
        await releaseAwb(shop, awb);
        awbReleased = true;

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

      // Parse and evaluate carrier JSON
      const carrier = parseJson(text);
      const verdict = evalDelhiveryResp(carrier);

      if (!verdict.ok) {
        if (awb && !awbReleased) {
          try {
            await releaseAwb(shop, awb);
          } catch {
            /* ignore */
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
              },
              { merge: true },
            ),
            batchRef.update({ processing: FieldValue.increment(-1) }),
          ]);
          return void res.status(503).json({ retry: true, reason: verdict.code });
        } else {
          await Promise.all([
            jobRef.set(
              {
                status: "failed",
                errorCode: verdict.code,
                errorMessage: verdict.message,
              },
              { merge: true },
            ),
            batchRef.update({
              processing: FieldValue.increment(-1),
              failed: FieldValue.increment(1),
            }),
          ]);
          return void res.status(200).json({ ok: false, permanent: true, reason: verdict.code });
        }
      }

      // ⬇️ NEW: start packing slip fetch/upload (non-blocking failure)
      const slipPromise = fetchAndStorePackingSlip({ shop, awb, apiKey }).catch(async (err) => {
        await db
          .collection("accounts")
          .doc(shop)
          .collection("awb_slips")
          .doc(awb!)
          .set(
            {
              status: "error",
              error: String(err?.message ?? err),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
      });

      // Success path (run in parallel with slip fetching)
      await Promise.all([
        jobRef.update({
          status: "success",
          awb,
          carrierShipmentId: verdict.carrierShipmentId ?? null,
          errorCode: FieldValue.delete(),
          errorMessage: FieldValue.delete(),
        }),
        batchRef.update({ processing: FieldValue.increment(-1), success: FieldValue.increment(1) }),
        orderRef.set(
          { awb, shipmentStatus: "created", customStatus: "Ready To Dispatch" },
          { merge: true },
        ),
        slipPromise, // ← we await it, but it’s usually quick; failures don't fail the job
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
            } catch {
              /* ignore */
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
              { status: "retrying", errorCode: "EXCEPTION", errorMessage: String(e?.message ?? e) },
              { merge: true },
            ),
            batchRef.update({ processing: FieldValue.increment(-1) }),
          ]);
        }
      } catch {
        /* ignore secondary failure */
      }
      // 503 → ask Cloud Tasks to retry the task
      return void res
        .status(503)
        .json({ error: "job_failed_transient", details: String(e?.message ?? e) });
    }
  },
);

/** Merge multiple AWB slip PDFs and return a single PDF */
export const mergeAwbSlips = onRequest(
  { cors: true, timeoutSeconds: 180, secrets: [ENQUEUE_FUNCTION_SECRET] },
  async (req, res) => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");
      if (req.method !== "POST") {
        return void res.status(405).json({ error: "method_not_allowed" });
      }

      // NEW: optional outSize to control the target page size of the merged PDF
      const { shop, awbs, filename, outSize } = (req.body || {}) as {
        shop?: string;
        awbs?: string[];
        filename?: string;
        outSize?: "A4" | "4R" | "LETTER";
      };
      if (!shop || !Array.isArray(awbs) || awbs.length === 0) {
        return void res.status(400).json({ error: "bad_payload" });
      }

      // Target canvas sizes (points, 72pt/in)
      const SIZES: Record<string, { w: number; h: number }> = {
        A4: { w: 595.28, h: 841.89 }, // 8.27 × 11.69 in
        LETTER: { w: 612, h: 792 }, // 8.5 × 11 in
        "4R": { w: 288, h: 432 }, // 4 × 6 in
      };
      const target = outSize && SIZES[outSize] ? SIZES[outSize] : null;

      const storagePaths = awbs.map((awb) => `awb_slips/${shop}/${awb}.pdf`);
      const present: { awb: string; data: Buffer }[] = [];
      const missing: string[] = [];
      const invalid: string[] = [];

      const bucket = getStorage().bucket();

      // fetch each stored slip
      await Promise.all(
        storagePaths.map(async (p, i) => {
          const f = bucket.file(p);
          const [exists] = await f.exists();
          if (!exists) {
            missing.push(awbs[i]);
            return;
          }
          const [buf] = await f.download(); // Buffer

          // quick PDF signature check
          const head = buf.length >= 5 ? buf.toString("ascii", 0, 5) : "";
          if (head !== "%PDF-") {
            invalid.push(awbs[i]);
            return;
          }
          present.push({ awb: awbs[i], data: buf });
        }),
      );

      if (present.length === 0) {
        return void res.status(404).json({ error: "no_valid_slips", missing, invalid });
      }

      // merge (and optionally re-layout to a target page size)
      const merged = await PDFDocument.create();

      for (const f of present) {
        try {
          const src = await PDFDocument.load(f.data, { ignoreEncryption: true });

          // If no target size requested, just copy pages as-is (your original behavior)
          if (!target) {
            const pages = await merged.copyPages(src, src.getPageIndices());
            pages.forEach((p) => merged.addPage(p));
            continue;
          }

          // Reflow each source page onto the chosen target canvas (e.g., A4)
          for (const idx of src.getPageIndices()) {
            // 1) get the source page
            const srcPage = src.getPage(idx);

            // 2) embed it into the merged doc (returns PDFEmbeddedPage)
            //    (use embedPages to avoid multiple xref round-trips if you want)
            const [embedded] = await merged.embedPages([srcPage]); // PDFEmbeddedPage

            const sw = embedded.width;
            const sh = embedded.height;
            const tw = target.w;
            const th = target.h;

            // 3) scale to fit while preserving aspect ratio, and center
            const scale = Math.min(tw / sw, th / sh);
            const x = (tw - sw * scale) / 2;
            const y = (th - sh * scale) / 2;

            // 4) create a fresh target-sized page and draw the embedded page onto it
            const page = merged.addPage([tw, th]);
            page.drawPage(embedded, { x, y, xScale: scale, yScale: scale });
          }
        } catch {
          invalid.push(f.awb);
        }
      }

      if (merged.getPageCount() === 0) {
        return void res.status(404).json({ error: "no_valid_pages", missing, invalid });
      }

      const out = await merged.save();
      const safeName = (filename || `awb-slips-${shop}-${Date.now()}.pdf`).replace(
        /[^a-z0-9_.]+/gi,
        "_",
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      if (missing.length) res.setHeader("X-Missing-AWBs", String(missing.length));
      if (invalid.length) res.setHeader("X-Invalid-AWBs", String(invalid.length));
      return void res.status(200).send(Buffer.from(out));
    } catch (e: any) {
      return void res.status(500).json({ error: "merge_failed", details: String(e?.message ?? e) });
    }
  },
);
