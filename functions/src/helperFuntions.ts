import { DocumentReference, Timestamp } from "firebase-admin/firestore";
import { db, FieldValue } from "./firebaseAdmin";
import { Request, Response } from "express";
import { createTask } from "./cloudTasks";

export async function maybeCompleteBatch(batchRef: DocumentReference): Promise<void> {
  await db.runTransaction(async (tx) => {
    const b = await tx.get(batchRef);
    const d = b.data() || {};
    const total = Number(d.total || 0);
    const success = Number(d.success || 0);
    const failed = Number(d.failed || 0);
    const processing = Number(d.processing || 0);
    if (total && success + failed === total && processing === 0) {
      tx.update(batchRef, {
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}

export async function maybeCompleteSummary(summaryRef: DocumentReference) {
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

/** Small helper to require a shared secret header */
export function requireHeaderSecret(req: Request, header: string, expected: string) {
  const got = (req.get(header) || "").trim();
  if (!got || got !== (expected || "").trim()) throw new Error(`UNAUTH_${header}`);
}

/** Classify Delhivery create-shipment response */
export function evalDelhiveryResp(carrier: any): {
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

/** Classify Shiprocket create-order response */
export function evalShiprocketResp(sr: any): {
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

/** Decide if an HTTP failure status is retryable */
export function httpRetryable(status: number) {
  // transient: throttling / contention / timeouts / early hints
  if (status === 429 || status === 408 || status === 409 || status === 425) return true;
  if (status >= 500) return true;
  return false;
}

// Fulfill ONE Shopify order (handles on_hold/scheduled → open)
export async function fulfillOrderOnShopify(
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

export function determineNewStatus(status: any): string | null {
  const { Status, StatusType } = status;

  const statusMap: Record<string, Record<string, string>> = {
    "In Transit": { UD: "In Transit", RT: "RTO In Transit", PU: "DTO In Transit" },
    Pending: { UD: "In Transit", RT: "RTO In Transit", PU: "DTO In Transit" },
    Dispatched: { UD: "Out For Delivery" },
    Delivered: { DL: "Delivered" },
    RTO: { DL: "RTO Delivered" },
    DTO: { DL: "DTO Delivered" },
    Lost: { LT: "Lost" },
  };

  return statusMap[Status]?.[StatusType] || null;
}

export function getStatusRemarks(status: string): string {
  const remarks: Record<string, string> = {
    "In Transit": "This order was being moved from origin to the destination",
    "RTO In Transit": "This order was returned and being moved from pickup to origin",
    "Out For Delivery": "This order was about to reach its final destination",
    Delivered: "This order was successfully delivered to its destination",
    "RTO Delivered": "This order was successfully returned to its destination",
    "DTO In Transit": "This order was returned by the customer and was being moved to the origin",
    "DTO Delivered":
      "This order was returned by the customer and successfully returned to its origin",
    Lost: "This order was lost",
  };
  return remarks[status] || "";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 3. CHUNK PROCESSOR - Fetches and processes one page of orders
interface ChunkResult {
  processed: number;
  updated: number;
  hasMore: boolean;
  nextCursor?: string;
}

// 4. API PROCESSOR - Calls Delhivery and prepares updates
interface OrderUpdate {
  ref: DocumentReference;
  data: any;
}

const CHUNK_SIZE = 200; // Orders processed per scheduled task
const MANUAL_CHUNK_SIZE = 100; // Order IDs processed per manual task
const API_BATCH_SIZE = 50; // Orders per Delhivery API call

export async function processOrderChunk(
  accountId: string,
  apiKey: string,
  cursor: string | null,
): Promise<ChunkResult> {
  const excludedStatuses = new Set([
    "New",
    "Confirmed",
    "Ready To Dispatch",
    "DTO Requested",
    "Lost",
    "Closed",
    "RTO Closed",
    "RTO Delivered",
    "DTO Delivered",
  ]);

  // Build paginated query
  let query = db
    .collection("accounts")
    .doc(accountId)
    .collection("orders")
    .where("courier", "==", "Delhivery")
    .orderBy("__name__")
    .limit(CHUNK_SIZE);

  if (cursor) {
    query = query.startAfter(cursor);
  }

  const snapshot = await query.get();

  if (snapshot.empty) {
    return { processed: 0, updated: 0, hasMore: false };
  }

  const eligibleOrders = snapshot.docs
    .map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }))
    .filter(
      (order: any) => order.awb && order.customStatus && !excludedStatuses.has(order.customStatus),
    );

  if (eligibleOrders.length === 0) {
    const lastDoc = snapshot.docs[snapshot.docs.length - 1];
    return {
      processed: snapshot.size,
      updated: 0,
      hasMore: snapshot.size === CHUNK_SIZE,
      nextCursor: lastDoc.id,
    };
  }

  console.log(`Processing ${eligibleOrders.length} eligible orders for account ${accountId}`);

  // Process in API batches
  let totalUpdated = 0;

  for (let i = 0; i < eligibleOrders.length; i += API_BATCH_SIZE) {
    const batch = eligibleOrders.slice(i, Math.min(i + API_BATCH_SIZE, eligibleOrders.length));
    const updates = await fetchAndProcessBatch(batch, apiKey);

    // Apply updates using Firestore batch writes
    if (updates.length > 0) {
      const writeBatch = db.batch();
      updates.forEach((update) => {
        writeBatch.update(update.ref, update.data);
      });
      await writeBatch.commit();
      totalUpdated += updates.length;
      console.log(`Updated ${updates.length} orders in API batch ${i / API_BATCH_SIZE + 1}`);
    }

    // Rate limiting between API calls
    if (i + API_BATCH_SIZE < eligibleOrders.length) {
      await sleep(150);
    }
  }

  const lastDoc = snapshot.docs[snapshot.docs.length - 1];
  const hasMore = snapshot.size === CHUNK_SIZE;

  return {
    processed: eligibleOrders.length,
    updated: totalUpdated,
    hasMore,
    nextCursor: hasMore ? lastDoc.id : undefined,
  };
}

export async function fetchAndProcessBatch(orders: any[], apiKey: string): Promise<OrderUpdate[]> {
  const waybills = orders
    .map((order) => (order.customStatus?.includes("DTO") ? order.awb_reverse : order.awb))
    .filter(Boolean)
    .join(",");

  if (!waybills) return [];

  try {
    const trackingUrl = `https://track.delhivery.com/api/v1/packages/json/?waybill=${waybills}`;
    const response = await fetch(trackingUrl, {
      headers: {
        Authorization: `Token ${apiKey}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) {
        throw new Error(`HTTP_${response.status}`);
      }
      console.error(`Delhivery API error: ${response.status}`);
      return [];
    }

    const trackingData = (await response.json()) as any;
    const shipments = trackingData.ShipmentData || [];

    return prepareOrderUpdates(orders, shipments);
  } catch (error: any) {
    console.error("Batch processing error:", error);
    if (error.message.startsWith("HTTP_")) {
      throw error;
    }
    return [];
  }
}

// 5. UPDATE PREPARATION - Maps API responses to Firestore updates
export function prepareOrderUpdates(orders: any[], shipments: any[]): OrderUpdate[] {
  const updates: OrderUpdate[] = [];
  const ordersByName = new Map(orders.map((o) => [o.name, o]));

  for (const shipmentWrapper of shipments) {
    const shipment = shipmentWrapper.Shipment;
    if (!shipment?.ReferenceNo || !shipment.Status) continue;

    const order = ordersByName.get(shipment.ReferenceNo);
    if (!order) continue;

    const newStatus = determineNewStatus(shipment.Status);
    if (!newStatus || newStatus === order.customStatus) continue;

    updates.push({
      ref: order.ref,
      data: {
        customStatus: newStatus,
        lastStatusUpdate: FieldValue.serverTimestamp(),
        customStatusesLogs: FieldValue.arrayUnion({
          status: newStatus,
          createdAt: Timestamp.now(),
          remarks: getStatusRemarks(newStatus),
        }),
      },
    });
  }

  return updates;
}

// 6. HELPER FUNCTIONS
export async function validateUsers(accountId: string, userIds: string[]): Promise<string[]> {
  const results = await Promise.all(
    userIds.map(async (userId) => {
      try {
        const userDoc = await db.collection("users").doc(userId).get();
        if (!userDoc.exists) return null;
        if (userDoc.get("activeAccountId") !== accountId) return null;
        return userId;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((id): id is string => id !== null);
}

export async function queueNextChunk(
  tasksSecret: string,
  params: {
    accountId: string;
    userIds: string[];
    batchId: string;
    jobId: string;
    cursor: string;
    chunkIndex: number;
  },
): Promise<void> {
  const targetUrl = process.env.UPDATE_STATUS_TASK_JOB_TARGET_URL;

  await createTask(params, {
    tasksSecret,
    url: targetUrl,
    queue: process.env.STATUS_UPDATE_QUEUE_NAME || "statuses-update-queue",
    delaySeconds: 2,
  });
}

export async function handleJobError(error: any, body: any): Promise<void> {
  const { batchId, jobId, chunkIndex } = body;
  if (!batchId || !jobId) return;

  const msg = error.message || String(error);
  const code = msg.split(/\s/)[0];
  const NON_RETRYABLE = ["ACCOUNT_NOT_FOUND", "API_KEY_MISSING", "NO_VALID_USERS_FOR_ACCOUNT"];
  const isRetryable = !NON_RETRYABLE.includes(code);

  const batchRef = db.collection("status_update_batches").doc(batchId);
  const jobRef = batchRef.collection("jobs").doc(jobId);

  try {
    const jobSnap = await jobRef.get();
    const attempts = Number(jobSnap.data()?.attempts || 0);
    const maxAttempts = Number(process.env.STATUS_UPDATE_QUEUE_MAX_ATTEMPTS || 3);
    const attemptsExhausted = attempts >= maxAttempts;

    await Promise.all([
      jobRef.set(
        {
          status: isRetryable ? (attemptsExhausted ? "failed" : "retrying") : "failed",
          errorCode: isRetryable ? "EXCEPTION" : code,
          errorMessage: msg.slice(0, 400),
          failedAt: FieldValue.serverTimestamp(),
          failedAtChunk: chunkIndex || 0,
        },
        { merge: true },
      ),
      batchRef.update(
        isRetryable && !attemptsExhausted
          ? { processing: FieldValue.increment(-1) }
          : { processing: FieldValue.increment(-1), failed: FieldValue.increment(1) },
      ),
    ]);

    await maybeCompleteBatch(batchRef);
  } catch (e) {
    console.error("Failed to update job with error status:", e);
  }
}

// 3. ORDER PROCESSING - Fetches orders and calls Delhivery API
interface ProcessResult {
  processed: number;
  updated: number;
  skipped: number;
  updatedOrdersList: any[];
  errors: string[];
}

export async function processOrderIdsChunk(
  accountId: string,
  apiKey: string,
  orderIds: string[],
  requestedBy: string = "manual",
): Promise<ProcessResult> {
  const excludedStatuses = new Set([
    "New",
    "Confirmed",
    "Ready To Dispatch",
    "DTO Requested",
    "Lost",
    "Closed",
    "RTO Closed",
    "RTO Delivered",
    "DTO Delivered",
  ]);

  // Fetch orders in batches (Firestore getAll limit is 500)
  const orderRefs = orderIds.map((id) =>
    db.collection("accounts").doc(accountId).collection("orders").doc(id),
  );

  const orderDocs: any[] = [];
  const fetchBatchSize = 500;

  for (let i = 0; i < orderRefs.length; i += fetchBatchSize) {
    const batch = orderRefs.slice(i, Math.min(i + fetchBatchSize, orderRefs.length));
    const docs = await db.getAll(...batch);
    orderDocs.push(...docs);
  }

  // Filter to existing Delhivery orders
  const existingOrders = orderDocs
    .filter((doc) => doc.exists)
    .map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }));

  const eligibleOrders = existingOrders.filter(
    (order: any) =>
      order.courier === "Delhivery" &&
      order.awb &&
      order.customStatus &&
      !excludedStatuses.has(order.customStatus),
  );

  if (eligibleOrders.length === 0) {
    return {
      processed: orderIds.length,
      updated: 0,
      skipped: orderIds.length,
      updatedOrdersList: [],
      errors: [],
    };
  }

  console.log(`Processing ${eligibleOrders.length} eligible orders for account ${accountId}`);

  // Process in API batches
  const updatedOrdersList: any[] = [];
  const errors: string[] = [];
  let totalUpdated = 0;

  for (let i = 0; i < eligibleOrders.length; i += API_BATCH_SIZE) {
    const batch = eligibleOrders.slice(i, Math.min(i + API_BATCH_SIZE, eligibleOrders.length));
    const updates = await fetchAndProcessManualBatch(batch, apiKey, requestedBy, errors);

    // Apply updates using Firestore batch writes
    if (updates.length > 0) {
      const writeBatch = db.batch();
      updates.forEach((update) => {
        writeBatch.update(update.ref, update.data);
        updatedOrdersList.push(update.orderInfo);
      });
      await writeBatch.commit();
      totalUpdated += updates.length;
    }

    // Rate limiting
    if (i + API_BATCH_SIZE < eligibleOrders.length) {
      await sleep(150);
    }
  }

  return {
    processed: orderIds.length,
    updated: totalUpdated,
    skipped: orderIds.length - totalUpdated,
    updatedOrdersList,
    errors,
  };
}

// 4. API CALL AND UPDATE PREPARATION
interface ManualOrderUpdate {
  ref: DocumentReference;
  data: any;
  orderInfo: any;
}

export async function fetchAndProcessManualBatch(
  orders: any[],
  apiKey: string,
  requestedBy: string,
  errors: string[],
): Promise<ManualOrderUpdate[]> {
  const waybills = orders
    .map((order) => (order.customStatus?.includes("DTO") ? order.awb_reverse : order.awb))
    .filter(Boolean)
    .join(",");

  if (!waybills) return [];

  try {
    const trackingUrl = `https://track.delhivery.com/api/v1/packages/json/?waybill=${waybills}`;
    const response = await fetch(trackingUrl, {
      headers: {
        Authorization: `Token ${apiKey}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorMsg = `Delhivery API error: ${response.status}`;
      console.error(errorMsg);
      errors.push(errorMsg);
      return [];
    }

    const trackingData = (await response.json()) as any;
    const shipments = trackingData.ShipmentData || [];

    return prepareManualUpdates(orders, shipments, requestedBy);
  } catch (error: any) {
    console.error("Batch processing error:", error);
    errors.push(error.message);
    return [];
  }
}

export function prepareManualUpdates(
  orders: any[],
  shipments: any[],
  requestedBy: string,
): ManualOrderUpdate[] {
  const updates: ManualOrderUpdate[] = [];
  const ordersByName = new Map(orders.map((o) => [o.name, o]));

  for (const shipmentWrapper of shipments) {
    const shipment = shipmentWrapper.Shipment;
    if (!shipment?.ReferenceNo || !shipment.Status) continue;

    const order = ordersByName.get(shipment.ReferenceNo);
    if (!order) continue;

    const newStatus = determineNewStatus(shipment.Status);
    if (!newStatus || newStatus === order.customStatus) continue;

    updates.push({
      ref: order.ref,
      data: {
        customStatus: newStatus,
        lastStatusUpdate: FieldValue.serverTimestamp(),
        lastManualUpdate: FieldValue.serverTimestamp(),
        lastUpdateRequestedBy: requestedBy,
        customStatusesLogs: FieldValue.arrayUnion({
          status: newStatus,
          createdAt: Timestamp.now(),
          remarks: getStatusRemarks(newStatus),
        }),
      },
      orderInfo: {
        orderId: order.id,
        orderName: order.name,
        oldStatus: order.customStatus,
        newStatus,
        awb: order.awb,
      },
    });
  }

  return updates;
}

// 5. HELPER FUNCTIONS
export async function queueManualUpdateChunk(
  tasksSecret: string,
  params: {
    jobId: string;
    accountId: string;
    orderIds: string[];
    requestedBy?: string;
    chunkIndex: number;
    startIndex: number;
  },
): Promise<void> {
  const targetUrl = process.env.UPDATE_STATUS_TASK_MANUAL_TARGET_URL;

  await createTask(params, {
    tasksSecret,
    url: targetUrl,
    queue: process.env.STATUS_UPDATE_QUEUE_NAME || "statuses-update-queue",
    delaySeconds: 2,
  });
}
