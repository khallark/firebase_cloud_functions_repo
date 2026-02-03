import { Filter, QueryDocumentSnapshot } from "firebase-admin/firestore";
import {
  API_BATCH_SIZE,
  CHUNK_SIZE,
  ChunkResult,
  OrderUpdate,
  sendStatusChangeMessages,
} from "../helpers";
// When the TODO status-logic blocks in prepareBlueDartOrderUpdates are
// uncommented, restore these imports:
//   import { FieldValue, Timestamp } from "firebase-admin/firestore";
//   import { getStatusRemarks } from "../helpers";
import { sleep } from "../../helpers";
import { db } from "../../firebaseAdmin";

export async function processBlueDartOrderChunk(
  accountId: string,
  jwtToken: string,
  loginId: string,
  trackingLicenceKey: string,
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

  // Build paginated query with OR condition for both courier and courier_reverse
  let query = db
    .collection("accounts")
    .doc(accountId)
    .collection("orders")
    .where(
      Filter.or(
        Filter.where("courier", "==", "Blue Dart"),
        Filter.where("courier_reverse", "==", "Blue Dart"),
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
      // (courier == "Blue Dart" AND no courier_reverse) OR (courier_reverse == "Blue Dart")
      const hasBlueDartCourier        = order.courier === "Blue Dart";
      const hasNoCourierReverse       = !order.courier_reverse;
      const hasBlueDartCourierReverse = order.courier_reverse === "Blue Dart";

      const meetsCourierCondition =
        (hasBlueDartCourier && hasNoCourierReverse) || hasBlueDartCourierReverse;

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
    `[Blue Dart] Processing ${eligibleOrders.length} eligible orders for account ${accountId}`,
  );

  // Process in API batches (controls Firestore write frequency)
  let totalUpdated = 0;

  for (let i = 0; i < eligibleOrders.length; i += API_BATCH_SIZE) {
    const batch = eligibleOrders.slice(i, Math.min(i + API_BATCH_SIZE, eligibleOrders.length));
    const updates = await fetchAndProcessBlueDartBatch(
      batch,
      jwtToken,
      loginId,
      trackingLicenceKey,
    );

    // Apply updates using Firestore batch writes
    if (updates.length > 0) {
      const writeBatch = db.batch();
      updates.forEach((update) => {
        writeBatch.update(update.ref, update.data);
      });
      await writeBatch.commit();
      totalUpdated += updates.length;
      console.log(
        `[Blue Dart] Updated ${updates.length} orders in API batch ${Math.floor(i / API_BATCH_SIZE) + 1}`,
      );

      // Send WhatsApp status-change messages after the write is confirmed
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

// ─── Tracking-API layer ──────────────────────────────────────────────────────
// Blue Dart's tracking endpoint accepts up to 50 comma-separated AWBs in the
// `numbers` parameter.  API_BATCH_SIZE is already 50, so each slice passed here
// maps to exactly one HTTP call.  Any AWB that Blue Dart doesn't recognise is
// simply omitted from the ShipmentData.Shipment array — no error is raised.
async function fetchAndProcessBlueDartBatch(
  orders: any[],
  jwtToken: string,
  loginId: string,
  trackingLicenceKey: string,
): Promise<OrderUpdate[]> {
  // Pick the correct AWB per order (reverse AWB for DTO states, same as Delhivery)
  const waybills = orders
    .map((order) => (order.customStatus?.includes("DTO") ? order.awb_reverse : order.awb))
    .filter(Boolean)
    .join(",");

  if (!waybills) return [];

  try {
    const trackingUrl =
      `https://apigateway.bluedart.com/in/transportation/tracking/v1/shipment` +
      `?handler=tnt` +
      `&numbers=${encodeURIComponent(waybills)}` +
      `&format=json` +
      `&scan=1` +
      `&verno=1` +
      `&awb=awb` +
      `&loginid=${encodeURIComponent(loginId)}` +
      `&lickey=${encodeURIComponent(trackingLicenceKey)}`;

    const response = await fetch(trackingUrl, {
      method: "GET",
      headers: {
        JWTToken: jwtToken,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      // 5xx / 429 → propagate so the whole job is retried by Cloud Tasks
      if (response.status >= 500 || response.status === 429) {
        throw new Error(`HTTP_${response.status}`);
      }
      console.error(`[Blue Dart] Tracking API error: ${response.status}`);
      return [];
    }

    const trackingData = (await response.json()) as any;
    // Response shape: { ShipmentData: { Shipment: [...] } }
    const shipments = trackingData?.ShipmentData?.Shipment || [];

    return prepareBlueDartOrderUpdates(orders, shipments);
  } catch (error: any) {
    if (error.message?.startsWith("HTTP_")) {
      throw error; // bubble up — Cloud Tasks will retry the whole chunk
    }
    console.error("[Blue Dart] Batch tracking error:", error);
    return [];
  }
}

// ─── Update preparation ─────────────────────────────────────────────────────
// Maps Blue Dart tracking responses back to Firestore order updates.
//
// STATUS LOGIC IS INTENTIONALLY COMMENTED OUT.
// Blue Dart's StatusType → app-status mapping has not yet been validated against
// live shipment data.  The commented blocks below show exactly where the logic
// will slot in once it is confirmed.  Nothing else in this function needs to
// change at that point.
function prepareBlueDartOrderUpdates(orders: any[], shipments: any[]): OrderUpdate[] {
  const updates: OrderUpdate[] = [];

  // Index every order by its AWB (forward & reverse) so we can match
  // Blue Dart's WaybillNo back to the right order in O(1).
  const ordersByAwb = new Map<string, any>();
  for (const order of orders) {
    if (order.awb)         ordersByAwb.set(order.awb,         order);
    if (order.awb_reverse) ordersByAwb.set(order.awb_reverse, order);
  }

  for (const shipment of shipments) {
    // Blue Dart identifies a shipment by WaybillNo (== the AWB we sent)
    const waybillNo = shipment.WaybillNo;
    if (!waybillNo) continue;

    const order = ordersByAwb.get(waybillNo);
    if (!order) continue;

    // ---------------------------------------------------------------------
    // TODO: Raw status extraction
    // Will be uncommented once Blue Dart's live status values are mapped.
    //
    // Blue Dart returns the following fields on each Shipment object:
    //   shipment.Status         — human-readable, e.g. "PICKUP HAS BEEN REGISTERED"
    //   shipment.StatusType     — short code used for logic, e.g. "PU", "IT", "OD", "DL"
    //   shipment.StatusDate     — e.g. "02 February 2026"
    //   shipment.StatusTime     — e.g. "15:33"
    //   shipment.Scans[]        — full scan history; each entry contains:
    //                                ScanType, ScannedLocation, ScanCode,
    //                                ScanDate, Scan (description), ScanTime,
    //                                ScanGroupType
    //
    // const rawStatus     = shipment.Status;        // e.g. "PICKUP HAS BEEN REGISTERED"
    // const rawStatusType = shipment.StatusType;    // e.g. "PU"
    // ---------------------------------------------------------------------

    // ---------------------------------------------------------------------
    // TODO: Status determination via determineNewBlueDartStatus()
    // Will be uncommented once the StatusType mapping below is confirmed
    // against real shipments and added to helpers.ts.
    //
    // Candidate StatusType → app-status mapping (needs live-data validation):
    //   PU  → "Ready To Dispatch"          (pickup registered)
    //   IT  → "In Transit"                 (in transit toward destination)
    //   OD  → "Out For Delivery"           (last-mile out for delivery)
    //   DL  → "Delivered"                  (delivered to consignee)
    //   RTO → "RTO In Transit"             (return to origin — in transit)
    //         or "RTO Delivered"           (returned to origin — delivered)
    //   LS  → "Lost"                       (shipment marked lost)
    //
    // const newStatus = determineNewBlueDartStatus(rawStatusType, rawStatus);
    // if (!newStatus) continue;                      // unrecognised code → skip
    // if (newStatus === order.customStatus) continue; // no change → skip
    //
    // updates.push({
    //   ref: order.ref,
    //   data: {
    //     customStatus: newStatus,
    //     lastStatusUpdate: FieldValue.serverTimestamp(),
    //     customStatusesLogs: FieldValue.arrayUnion({
    //       status: newStatus,
    //       createdAt: Timestamp.now(),
    //       remarks: getStatusRemarks(newStatus),
    //     }),
    //   },
    // });
    // ---------------------------------------------------------------------
  }

  return updates;
}