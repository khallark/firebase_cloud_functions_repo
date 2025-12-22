import { FieldValue, Filter, QueryDocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import {
  API_BATCH_SIZE,
  CHUNK_SIZE,
  ChunkResult,
  determineNewXpressbeesStatus,
  getStatusRemarks,
  OrderUpdate,
  sendStatusChangeMessages,
} from "../helpers";
import { sleep } from "../../helpers";
import { db } from "../../firebaseAdmin";

export async function processXpressbeesOrderChunk(
  accountId: string,
  token: string,
  cursor: string | null,
): Promise<ChunkResult> {
  const excludedStatuses = new Set([
    "New",
    "Confirmed",
    "Ready To Dispatch",
    "DTO Requested",
    // "Lost",
    "Closed",
    "RTO Closed",
    "DTO Delivered",
    "Cancellation Requested",
    "Pending Refunds",
    "DTO Refunded",
    "Cancelled",
  ]);

  const shopRef = db.collection("accounts").doc(accountId);

  const shopDoc = await shopRef.get();
  const shopData = (shopDoc.data() as any) || null;

  // Build paginated query with OR condition for both courierProvider and courierReverseProvider
  let query = db
    .collection("accounts")
    .doc(accountId)
    .collection("orders")
    .where(
      Filter.or(
        Filter.where("courierProvider", "==", "Xpressbees"),
        Filter.where("courierReverseProvider", "==", "Xpressbees"),
      ),
    )
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
    .map((doc: QueryDocumentSnapshot) => ({ id: doc.id, ref: doc.ref, ...doc.data() }))
    .filter((order: any) => {
      // Check courier conditions: (courierProvider is Xpressbees AND no courierReverseProvider) OR (courierReverseProvider is Xpressbees)
      const hasXpressbeesCourier = order.courierProvider === "Xpressbees";
      const hasNoCourierReverse = !order.courierReverseProvider;
      const hasXpressbeesCourierReverse = order.courierReverseProvider === "Xpressbees";

      const meetsCourierCondition =
        (hasXpressbeesCourier && hasNoCourierReverse) || hasXpressbeesCourierReverse;

      // Check status condition
      const meetsStatusCondition =
        order.awb && order.customStatus && !excludedStatuses.has(order.customStatus);

      return meetsCourierCondition && meetsStatusCondition;
    });

  if (eligibleOrders.length === 0) {
    const lastDoc = snapshot.docs[snapshot.docs.length - 1];
    return {
      processed: snapshot.size,
      updated: 0,
      hasMore: snapshot.size === CHUNK_SIZE,
      nextCursor: lastDoc.id,
    };
  }

  console.log(
    `Processing ${eligibleOrders.length} eligible Xpressbees orders for account ${accountId}`,
  );

  // Process in API batches (individual calls for each AWB)
  let totalUpdated = 0;

  for (let i = 0; i < eligibleOrders.length; i += API_BATCH_SIZE) {
    const batch = eligibleOrders.slice(i, Math.min(i + API_BATCH_SIZE, eligibleOrders.length));
    const updates = await fetchAndProcessXpressbeesBatch(batch, token);

    // Apply updates using Firestore batch writes
    if (updates.length > 0) {
      const writeBatch = db.batch();
      updates.forEach((update) => {
        writeBatch.update(update.ref, update.data);
      });
      await writeBatch.commit();
      totalUpdated += updates.length;
      console.log(`Updated ${updates.length} orders in API batch ${i / API_BATCH_SIZE + 1}`);

      // ✅ ADD MESSAGE SENDING HERE - After successful commit
      await sendStatusChangeMessages(updates, shopData);
    }

    // Rate limiting between API batches
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

// 5. API BATCH PROCESSOR (collecting all responses first)
async function fetchAndProcessXpressbeesBatch(
  orders: any[],
  token: string,
): Promise<OrderUpdate[]> {
  const trackingResults: any[] = [];

  // Fetch tracking data for all orders
  for (const order of orders) {
    // Select correct AWB based on whether it's a DTO order
    const awb = order.customStatus?.includes("DTO") ? order.awb_reverse : order.awb;

    if (!awb) {
      trackingResults.push(null);
      continue;
    }

    try {
      const trackingUrl = `https://shipment.xpressbees.com/api/shipments2/track/${awb}`;
      const response = await fetch(trackingUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        if (response.status >= 500 || response.status === 429) {
          throw new Error(`HTTP_${response.status}`);
        }
        console.error(`Xpressbees API error for AWB ${awb}: ${response.status}`);
        trackingResults.push(null);
        continue;
      }

      const trackingData = (await response.json()) as any;
      trackingResults.push(trackingData);

      // Small delay between individual calls
      await sleep(50);
    } catch (error: any) {
      console.error(`Error tracking AWB ${awb}:`, error);
      if (error.message.startsWith("HTTP_")) {
        throw error;
      }
      trackingResults.push(null);
      continue;
    }
  }

  // Process all collected tracking data at once
  return prepareXpressbeesOrderUpdates(orders, trackingResults);
}

// 6. UPDATE PREPARATION (batch version)
function prepareXpressbeesOrderUpdates(orders: any[], trackingDataArray: any[]): OrderUpdate[] {
  const updates: OrderUpdate[] = [];

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const trackingData = trackingDataArray[i];

    if (!trackingData || !trackingData.status || !trackingData.data) continue;

    const currentStatus =
      trackingData.data.status !== "rto"
        ? trackingData.data.status
        : trackingData.data.history[0].status_code;
    if (!currentStatus) continue;

    const newStatus = determineNewXpressbeesStatus(currentStatus);
    if (!newStatus) continue;
    if (newStatus === order.customStatus) continue;

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
