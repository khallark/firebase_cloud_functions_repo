import { DocumentReference, FieldValue } from "firebase-admin/firestore";
import {
  createTask,
  sendDeliveredOrderWhatsAppMessage,
  sendDTODeliveredOrderWhatsAppMessage,
  sendDTOInTransitOrderWhatsAppMessage,
  sendInTransitOrderWhatsAppMessage,
  sendLostOrderWhatsAppMessage,
  sendOutForDeliveryOrderWhatsAppMessage,
  sendRTODeliveredOrderWhatsAppMessage,
  sendRTOInTransitOrderWhatsAppMessage,
} from "../services";
import { maybeCompleteBatch } from "../helpers";
import { db } from "../firebaseAdmin";

// ─── Status-determination helpers (one per courier) ─────────────────────────

export function determineNewDelhiveryStatus(status: any): string | null {
  const { Status, StatusType } = status;

  const statusMap: Record<string, Record<string, string>> = {
    "In Transit": { UD: "In Transit", RT: "RTO In Transit", PU: "DTO In Transit" },
    Pending: { UD: "In Transit", RT: "RTO In Transit", PU: "DTO In Transit" },
    Dispatched: { UD: "Out For Delivery" },
    Delivered: { DL: "Delivered" },
    RTO: { DL: "RTO Delivered" },
    DTO: { DL: "DTO Delivered" },
    Lost: { LT: "Lost" },
    LOST: { LT: "Lost" },
    Closed: { CN: "Closed/Cancelled Conditional" },
    Cancelled: { CN: "Closed/Cancelled Conditional" },
    Canceled: { CN: "Closed/Cancelled Conditional" },
  };

  return statusMap[Status]?.[StatusType] || null;
}

export function determineNewShiprocketStatus(currentStatus: string): string | null {
  const statusMap: Record<string, string> = {
    "In Transit": "In Transit",
    "In Transit-EN-ROUTE": "In Transit",
    "Out for Delivery": "Out For Delivery",
    Delivered: "Delivered",
    "RTO IN INTRANSIT": "RTO In Transit",
    "RTO Delivered": "RTO Delivered",
  };
  return statusMap[currentStatus] || null;
}

export function determineNewXpressbeesStatus(currentStatus: string): string | null {
  const statusMap: Record<string, string> = {
    "in transit": "In Transit",
    "out for delivery": "Out For Delivery",
    delivered: "Delivered",
    "RT-IT": "RTO In Transit",
    "RT-DL": "RTO Delivered",
    lost: "Lost",
  };
  return statusMap[currentStatus] || null;
}

// TODO: Mapping to be populated once Blue Dart's StatusType values are
// validated against live shipment data.
//
// Candidate mapping (StatusType → app status):
//   PU  → "Ready To Dispatch"
//   IT  → "In Transit"
//   OD  → "Out For Delivery"
//   DL  → "Delivered"
//   RTO → "RTO In Transit" | "RTO Delivered"  (sub-type TBD)
//   LS  → "Lost"
//
// @param statusType  Short code from Blue Dart, e.g. "PU", "IT", "DL"
// @param rawStatus   Human-readable status string (kept for logging / fallback)
export function determineNewBlueDartStatus(
  // statusType: string,
  // rawStatus: string
): string | null {
  // Placeholder — will be filled once the mapping is confirmed.
  return null;
}

// ─── Token helpers (one per courier that needs one) ─────────────────────────

export async function getXpressbeesToken(email: string, password: string): Promise<string | null> {
  try {
    const response = await fetch("https://shipment.xpressbees.com/api/users/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      console.error(`Xpressbees login failed: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as any;
    if (data.status && data.data) {
      return data.data; // The JWT token
    }

    return null;
  } catch (error) {
    console.error("Xpressbees login error:", error);
    return null;
  }
}

// Fetches a fresh JWT from Blue Dart's auth endpoint.
// Throws structured errors whose code (first space-delimited token) is
// consumed by the NON_RETRYABLE list in process.ts + handleJobError:
//   BLUEDART_AUTH_FAILED          — 4xx from the auth endpoint (bad creds)
//   BLUEDART_AUTH_TOKEN_MISSING   — 2xx but no JWTToken in the body
//   BLUEDART_AUTH_NETWORK_ERROR   — fetch threw (DNS, timeout, etc.) — retryable
export async function getBlueDartToken(appApiKey: string, appApiSecret: string): Promise<string> {
  try {
    const response = await fetch(
      "https://apigateway.bluedart.com/in/transportation/token/v1/login",
      {
        method: "GET",
        headers: {
          ClientID: appApiKey,
          clientSecret: appApiSecret,
          Accept: "application/json",
        },
      },
    );

    const data = (await response.json()) as any;

    if (!response.ok) {
      // Extract messages from Blue Dart's error-response array
      const errorMsgs = Array.isArray(data?.["error-response"])
        ? data["error-response"].map((e: any) => e.msg).join(", ")
        : data?.title || "Authentication failed";
      throw new Error(`BLUEDART_AUTH_FAILED ${errorMsgs}`);
    }

    if (!data.JWTToken) {
      throw new Error("BLUEDART_AUTH_TOKEN_MISSING");
    }

    return data.JWTToken;
  } catch (error: any) {
    // Re-throw errors we already structured
    if (error.message?.startsWith("BLUEDART_AUTH")) {
      throw error;
    }
    // Anything else is a network / parse failure — retryable
    throw new Error(`BLUEDART_AUTH_NETWORK_ERROR ${error.message}`);
  }
}

// ─── Shared utilities ───────────────────────────────────────────────────────

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

export async function queueNextChunk(
  tasksSecret: string,
  targetUrl: string,
  params: any,
): Promise<void> {
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

  // Covers all couriers — codes that are permanent regardless of who threw them
  const NON_RETRYABLE = [
    // generic
    "ACCOUNT_NOT_FOUND",
    "NO_VALID_USERS_FOR_ACCOUNT",
    // Delhivery
    "API_KEY_MISSING",
    // Blue Dart
    "BLUEDART_CREDENTIALS_MISSING",
    "BLUEDART_AUTH_FAILED",
    "BLUEDART_AUTH_TOKEN_MISSING",
  ];
  const isRetryable = !NON_RETRYABLE.includes(code);

  const batchRef = db.collection("status_update_batches").doc(batchId);
  const jobRef = batchRef.collection("jobs").doc(jobId);

  try {
    const jobSnap = await jobRef.get();
    const attempts = Number(jobSnap.data()?.attempts || 0);
    const maxAttempts = Number(process.env.STATUS_UPDATE_QUEUE_MAX_ATTEMPTS || 4);
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

export const CHUNK_SIZE = 200; // Orders processed per scheduled task
export const MANUAL_CHUNK_SIZE = 100; // Order IDs processed per manual task
export const API_BATCH_SIZE = 50; // Orders per API-batch (Firestore write boundary)

export interface ChunkResult {
  processed: number;
  updated: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface OrderUpdate {
  ref: DocumentReference;
  data: any;
}

export const messageActionFor = new Map<string, any>([
  ["In Transit", sendInTransitOrderWhatsAppMessage],
  ["Out For Delivery", sendOutForDeliveryOrderWhatsAppMessage],
  ["Delivered", sendDeliveredOrderWhatsAppMessage],
  ["RTO In Transit", sendRTOInTransitOrderWhatsAppMessage],
  ["RTO Delivered", sendRTODeliveredOrderWhatsAppMessage],
  ["DTO In Transit", sendDTOInTransitOrderWhatsAppMessage],
  ["DTO Delivered", sendDTODeliveredOrderWhatsAppMessage],
  ["Lost", sendLostOrderWhatsAppMessage],
]);

export async function sendStatusChangeMessages(updates: OrderUpdate[], shop: any): Promise<void> {
  const messagePromises = updates.map(async (update) => {
    try {
      const newStatus = update.data.customStatus;

      if (!shop) {
        console.warn(`Shop data not found for order ${update.ref.id}, skipping message.`);
        return;
      }

      // Check if this status has a message function
      const messageFn = messageActionFor.get(newStatus);
      if (!messageFn) {
        return; // No message configured for this status
      }

      // Get the full order data (we need this for the message)
      const orderDoc = await update.ref.get();
      if (!orderDoc.exists) return;

      const order = orderDoc.data() as any;

      // Send the message
      await messageFn(shop, order);

      console.log(`Sent ${newStatus} message for order ${orderDoc.id}`);
    } catch (error) {
      // Log but don't fail the whole process if message sending fails
      console.error(`Failed to send message for order ${update.ref.id}:`, error);
    }
  });

  // Send all messages in parallel, but don't block on failures
  await Promise.allSettled(messagePromises);
}

export async function hasActiveShipments(stores: string[]): Promise<boolean> {
  for (const store of stores) {
    const snapshot = await db
      .collection("accounts")
      .doc(store)
      .collection("orders")
      .where("customStatus", "in", [
        "Dispatched",
        "In Transit",
        "Out For Delivery",
        "RTO In Transit",
      ])
      .limit(1)
      .get();

    if (!snapshot.empty) return true;
  }
  return false;
}

export interface BusinessData {
  stores: string[];
}
