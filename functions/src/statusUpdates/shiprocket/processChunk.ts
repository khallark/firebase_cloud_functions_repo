import { FieldValue, Filter, QueryDocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import {
  API_BATCH_SIZE,
  CHUNK_SIZE,
  ChunkResult,
  determineNewShiprocketStatus,
  getStatusRemarks,
  OrderUpdate,
  sendStatusChangeMessages,
} from "../helpers";
import { sleep } from "../../helpers";
import { db } from "../../firebaseAdmin";

export async function processShiprocketOrderChunk(
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
        Filter.where("courierProvider", "==", "Shiprocket"),
        Filter.where("courierReverseProvider", "==", "Shiprocket"),
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
      // Check courier conditions: (courierProvider is Shiprocket AND no courierReverseProvider) OR (courierReverseProvider is Shiprocket)
      const hasShiprocketCourier = order.courierProvider === "Shiprocket";
      const hasNoCourierReverse = !order.courierReverseProvider;
      const hasShiprocketCourierReverse = order.courierReverseProvider === "Shiprocket";

      const meetsCourierCondition =
        (hasShiprocketCourier && hasNoCourierReverse) || hasShiprocketCourierReverse;

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
    `Processing ${eligibleOrders.length} eligible Shiprocket orders for account ${accountId}`,
  );

  // Process in API batches
  let totalUpdated = 0;

  for (let i = 0; i < eligibleOrders.length; i += API_BATCH_SIZE) {
    const batch = eligibleOrders.slice(i, Math.min(i + API_BATCH_SIZE, eligibleOrders.length));
    const updates = await fetchAndProcessShiprocketBatch(batch, apiKey);

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

async function fetchAndProcessShiprocketBatch(
  orders: any[],
  apiKey: string,
): Promise<OrderUpdate[]> {
  // Select correct AWB based on whether it's a DTO (customer return) order
  const awbs = orders
    .map((order) => (order.customStatus?.includes("DTO") ? order.awb_reverse : order.awb))
    .filter(Boolean);

  if (awbs.length === 0) return [];

  try {
    const trackingUrl = "https://apiv2.shiprocket.in/v1/external/courier/track/awbs";
    const response = await fetch(trackingUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ awbs }),
    });

    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) {
        throw new Error(`HTTP_${response.status}`);
      }
      console.error(`Shiprocket API error: ${response.status}`);
      return [];
    }

    const trackingData = (await response.json()) as any;

    const fieldCount = Object.keys(trackingData).length;
    console.log(fieldCount);

    return prepareShiprocketOrderUpdates(orders, trackingData);
  } catch (error: any) {
    console.error("Batch processing error:", error);
    if (error.message.startsWith("HTTP_")) {
      throw error;
    }
    return [];
  }
}

// 5. UPDATE PREPARATION - Maps API responses to Firestore updates
function prepareShiprocketOrderUpdates(orders: any[], trackingData: any): OrderUpdate[] {
  const updates: OrderUpdate[] = [];

  // Create map with correct AWB (reverse for DTO orders, regular otherwise)
  const ordersByAwb = new Map(
    orders.map((o) => {
      const awb = o.customStatus?.includes("DTO") ? o.awb_reverse : o.awb;
      return [awb, o];
    }),
  );

  for (const [awb, shipmentData] of Object.entries(trackingData)) {
    const order = ordersByAwb.get(awb);
    if (!order) continue;

    const shipmentInfo = shipmentData as any;
    const trackingDataObj = shipmentInfo?.tracking_data;
    if (!trackingDataObj) continue;

    const shipmentTrack = trackingDataObj.shipment_track;
    if (!Array.isArray(shipmentTrack) || shipmentTrack.length === 0) continue;

    const currentStatus = shipmentTrack[0]?.current_status;
    if (!currentStatus) continue;

    const newStatus = determineNewShiprocketStatus(currentStatus);
    if (!newStatus) continue;
    if (newStatus === order.customStatus) continue;
    if (newStatus === "RTO Delivered" && order.customStatus === "RTO Processed") {
      updates.push({
        ref: order.ref,
        data: {
          customStatus: "RTO Closed",
          lastStatusUpdate: FieldValue.serverTimestamp(),
          customStatusesLogs: FieldValue.arrayUnion({
            status: "RTO Closed",
            createdAt: Timestamp.now(),
            remarks:
              "This order was finally updated by the courier to 'RTO Delivered', and was shifted from 'RTO Processed' to 'RTO Closed'.",
          }),
        },
      });
      continue;
    }

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
