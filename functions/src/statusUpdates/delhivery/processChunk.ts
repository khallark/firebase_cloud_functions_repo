import { FieldValue, Filter, QueryDocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import {
  API_BATCH_SIZE,
  CHUNK_SIZE,
  ChunkResult,
  determineNewDelhiveryStatus,
  getStatusRemarks,
  OrderUpdate,
  sendStatusChangeMessages,
} from "../helpers";
import { sleep } from "../../helpers";
import { db } from "../../firebaseAdmin";

export async function processDelhiveryOrderChunk(
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
  ]);

  const shopRef = db.collection("accounts").doc(accountId);

  const shopDoc = await shopRef.get();
  const shopData = (shopDoc.data() as any) || null;

  // Build paginated query with OR condition for both courier and courier_reverse
  let query = db
    .collection("accounts")
    .doc(accountId)
    .collection("orders")
    .where(
      Filter.or(
        Filter.where("courier", "==", "Delhivery"),
        Filter.where("courier_reverse", "==", "Delhivery"),
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
      // Check courier conditions: (courier == Delhivery AND no courier_reverse) OR (courier_reverse == Delhivery)
      const hasDelhiveryCourier = order.courier === "Delhivery";
      const hasNoCourierReverse = !order.courier_reverse;
      const hasDelhiveryCourierReverse = order.courier_reverse === "Delhivery";

      const meetsCourierCondition =
        (hasDelhiveryCourier && hasNoCourierReverse) || hasDelhiveryCourierReverse;

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

  console.log(`Processing ${eligibleOrders.length} eligible orders for account ${accountId}`);

  // Process in API batches
  let totalUpdated = 0;

  for (let i = 0; i < eligibleOrders.length; i += API_BATCH_SIZE) {
    const batch = eligibleOrders.slice(i, Math.min(i + API_BATCH_SIZE, eligibleOrders.length));
    const updates = await fetchAndProcessDelhiveryBatch(batch, apiKey);

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

async function fetchAndProcessDelhiveryBatch(
  orders: any[],
  apiKey: string,
): Promise<OrderUpdate[]> {
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

    return prepareDelhiveryOrderUpdates(orders, shipments);
  } catch (error: any) {
    console.error("Batch processing error:", error);
    if (error.message.startsWith("HTTP_")) {
      throw error;
    }
    return [];
  }
}

// 5. UPDATE PREPARATION - Maps API responses to Firestore updates
function prepareDelhiveryOrderUpdates(orders: any[], shipments: any[]): OrderUpdate[] {
  const updates: OrderUpdate[] = [];
  const ordersByName = new Map(orders.map((o) => [o.name, o]));

  for (const shipmentWrapper of shipments) {
    const shipment = shipmentWrapper.Shipment;
    if (!shipment?.ReferenceNo || !shipment.Status) continue;

    const order = ordersByName.get(shipment.ReferenceNo);
    if (!order) continue;

    const newStatus = determineNewDelhiveryStatus(shipment.Status);
    if (!newStatus) continue;
    if (newStatus === order.customStatus) continue;
    if (newStatus === "Closed/Cancelled Conditional") {
      if (order.customStatus === "DTO Booked") {
        updates.push({
          ref: order.ref,
          data: {
            customStatus: "Delivered",
            awb_reverse: FieldValue.delete(),
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Delivered",
              createdAt: Timestamp.now(),
              remarks: "This order was Cancelled on DTO, and was changed to 'Delivered' again.",
            }),
          },
        });
      }
      if (order.customStatus === "Ready To Dispatch") {
        updates.push({
          ref: order.ref,
          data: {
            customStatus: "Confirmed",
            courier: FieldValue.delete(),
            awb: FieldValue.delete(),
            lastStatusUpdate: FieldValue.serverTimestamp(),
            customStatusesLogs: FieldValue.arrayUnion({
              status: "Confirmed",
              createdAt: Timestamp.now(),
              remarks:
                "This order was Cancelled on by Delhivery, and was changed to 'Confirmed' again.",
            }),
          },
        });
      }
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
