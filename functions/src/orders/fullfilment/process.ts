import { onRequest } from "firebase-functions/v2/https";
import { SHARED_STORE_ID, TASKS_SECRET } from "../../config";
import {
  BusinessIsAuthorisedToProcessThisOrder,
  maybeCompleteSummary,
  requireHeaderSecret,
} from "../../helpers";
import { sendDispatchedOrderWhatsAppMessage } from "../../services";
import { db } from "../../firebaseAdmin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

export const processFulfillmentTask = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [TASKS_SECRET] },
  async (req, res) => {
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");
      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { businessId, shop, summaryId, jobId, orderId } = (req.body || {}) as {
        businessId?: string;
        shop?: string;
        summaryId?: string;
        jobId?: string;
        orderId?: string;
      };

      if (!businessId || !shop || !summaryId || !jobId || !orderId) {
        res.status(400).json({ error: "bad_payload" });
        return;
      }

      const summaryRef = db
        .collection("users")
        .doc(businessId)
        .collection("orders_fulfillment_summary")
        .doc(summaryId);
      const jobRef = summaryRef.collection("jobs").doc(jobId);

      // ✅ Get job first to see if we need cleanup
      const jobSnap = await jobRef.get();

      if (!jobSnap.exists) {
        // Idempotency: job was deleted or never created
        res.json({ noop: true });
        return;
      }

      const job = jobSnap.data()!;

      if (job.status === "success") {
        res.json({ alreadyDone: true });
        return;
      }

      function httpRetryable(status: number): boolean {
        return status === 408 || status === 429 || (status >= 500 && status <= 599);
      }

      // ✅ Helper function to mark job as failed and update summary
      const markJobFailed = async (errorCode: string, errorMessage: string) => {
        await Promise.all([
          jobRef.set(
            {
              status: "failed",
              errorCode,
              errorMessage: errorMessage.slice(0, 400),
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
      };

      // ✅ Now wrap all validation in try-catch
      try {
        const shopRef = db.collection("accounts").doc(shop);
        const orderRef = shopRef.collection("orders").doc(String(jobId));

        const shopDoc = await shopRef.get();
        if (!shopDoc.exists) {
          await markJobFailed("shop_not_found", `Shop ${shop} not found`);
          res.status(404).json({ error: "shop_not_found" });
          return;
        }

        const shopData = shopDoc.data() as any;

        const businessDoc = await db.collection("users").doc(businessId).get();
        if (!businessDoc.exists) {
          await markJobFailed("business_not_found", `Business ${businessId} not found`);
          res.status(404).json({ error: "business_not_found" });
          return;
        }

        const order = await orderRef.get();
        if (!order.exists) {
          await markJobFailed("order_not_found", `Order ${orderId} not found`);
          res.status(404).json({ error: "order_not_found" });
          return;
        }

        const orderData = order.data() as any;

        // ✅ NEW: Check if order is already fulfilled
        const fulfillmentStatus =
          orderData?.raw?.fulfillment_status || orderData?.fulfillmentStatus;
        if (fulfillmentStatus === "fulfilled" || fulfillmentStatus === "partial") {
          // Order already fulfilled - mark job as success with nothingToDo flag
          await Promise.all([
            jobRef.set(
              {
                status: "success",
                fulfillmentId: null,
                nothingToDo: true,
                skipReason: "already_fulfilled",
                errorCode: FieldValue.delete(),
                errorMessage: FieldValue.delete(),
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true },
            ),
            summaryRef.update({
              success: FieldValue.increment(1),
            }),
            orderRef.set(
              {
                customStatus: "Dispatched",
                lastStatusUpdate: FieldValue.serverTimestamp(),
                customStatusesLogs: FieldValue.arrayUnion({
                  status: "Dispatched",
                  createdAt: Timestamp.now(),
                  remarks: `The order's shipment was dispatched from the warehouse.`,
                }),
              },
              { merge: true },
            ),
          ]);

          await maybeCompleteSummary(summaryRef);

          res.json({
            ok: true,
            alreadyFulfilled: true,
            message: "Order already fulfilled on Shopify",
          });
          return;
        }

        // Check if the shop is exceptional one
        if (shop === SHARED_STORE_ID) {
          const businessData = businessDoc.data();
          const vendorName = businessData?.vendorName;
          const vendors = orderData?.vendors;
          const canProcess = BusinessIsAuthorisedToProcessThisOrder(
            businessId,
            vendorName,
            vendors,
          );
          if (!canProcess.authorised) {
            await markJobFailed("not_authorized", `Business not authorized to process this order`);
            res.status(403).json({ error: "not_authorized_to_process" });
            return;
          }
        }

        const accessToken = shopDoc.get("accessToken");
        if (!accessToken) {
          await markJobFailed("missing_access_token", `Access token missing for shop ${shop}`);
          res.status(500).json({ error: "missing_access_token" });
          return;
        }

        let awb = order.get("awb") || "";
        let courier = order.get("courierProvider") || "";

        const MAX_ATTEMPTS = Number(process.env.FULFILLMENT_QUEUE_MAX_ATTEMPTS || 3);

        // ✅ Mark processing + attempt++
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

        // ✅ Try fulfillment
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
                lastStatusUpdate: FieldValue.serverTimestamp(),
                customStatusesLogs: FieldValue.arrayUnion({
                  status: "Dispatched",
                  createdAt: Timestamp.now(),
                  remarks: `The order's shipment was dispatched from the warehouse.`,
                }),
              },
              { merge: true },
            ),
          ]);

          await maybeCompleteSummary(summaryRef);
          await sendDispatchedOrderWhatsAppMessage(shopData, orderData);

          res.json({ ok: true });
          return;
        } catch (err: any) {
          // ✅ Fulfillment failure handling
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
      } catch (validationError: any) {
        // ✅ Catch any unexpected validation errors
        console.error("Validation error:", validationError);
        await markJobFailed("validation_error", validationError.message || "Validation failed");
        res.status(500).json({ error: "validation_failed", details: validationError.message });
        return;
      }
    } catch (e: any) {
      console.error("processFulfillmentTask error:", e);
      res.status(500).json({ error: "worker_failed", details: String(e?.message ?? e) });
      return;
    }
  },
);

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

  // If no FOs are visible, it's almost always a scope issue
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

  // 4) Group fulfillment orders by assigned location
  const fosByLocation = new Map<string, any[]>();

  for (const fo of fulfillableFOs) {
    const locationId = fo.assigned_location_id?.toString() || "unknown";
    if (!fosByLocation.has(locationId)) {
      fosByLocation.set(locationId, []);
    }
    fosByLocation.get(locationId)!.push(fo);
  }

  // 5) Create separate fulfillments for each location
  const fulfillmentIds: string[] = [];

  for (const [locationId, locationFOs] of fosByLocation.entries()) {
    const lineItemsByFO = locationFOs.map((fo: any) => ({
      fulfillment_order_id: fo.id,
      fulfillment_order_line_items: fo.line_items
        .filter((li: any) => li.fulfillable_quantity > 0) // Only unfulfilled items
        .map((li: any) => ({
          id: li.id,
          quantity: li.fulfillable_quantity,
        })),
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
            url:
              String(courier) === "Delhivery"
                ? `https://www.delhivery.com/track-v2/package/${awb}`
                : String(courier) === "Shiprocket"
                  ? `https://shiprocket.co/tracking/${awb}`
                  : `https://www.xpressbees.com/shipment/tracking?awbNo=${awb}`,
          },
          notify_customer: false,
        },
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`Fulfillment create failed for location ${locationId}:`, text);
      // Continue with other locations instead of throwing
      continue;
    }

    const json: any = await resp.json();
    console.log(`Fulfillment response for location ${locationId}:`, JSON.stringify(json)); // 👈 ADD THIS

    if (json?.fulfillment?.id) {
      fulfillmentIds.push(json.fulfillment.id);
    } else {
      console.error(`No fulfillment ID in response for location ${locationId}`, json); // 👈 ADD THIS
    }
  }

  // Return the first fulfillment ID (or undefined if all failed)
  return {
    fulfillmentId: fulfillmentIds[0],
    // You could also return all IDs if needed: fulfillmentIds
  };
}
