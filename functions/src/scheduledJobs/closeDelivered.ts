import { onSchedule } from "firebase-functions/v2/scheduler";
import { TASKS_SECRET } from "../config";
import { createTask } from "../services";
import { onRequest } from "firebase-functions/v2/https";
import { chunkArray, requireHeaderSecret } from "../helpers";
import { FieldValue, Timestamp, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { db } from "../firebaseAdmin";

// Cutoff constants
const STORE_CREDIT_CLOSE_AFTER_HOURS = 48;
const REGULAR_CLOSE_AFTER_HOURS = 120;

// Pagination constants
const QUERY_BATCH_SIZE = 500;
const WRITE_BATCH_SIZE = 500;
const MAX_ITERATIONS = 50; // Safety limit: 50 * 500 = 25,000 orders max per account

interface CloseDeliveredOrdersPayload {
  accountId: string;
  storeCreditCutoffTime: string;
  regularCutoffTime: string;
}

// ============================================================================
// CRON JOB - Enqueue tasks to close delivered orders
// ============================================================================
export const closeDeliveredOrdersJob = onSchedule(
  {
    schedule: "0 3 * * *",
    timeZone: "Asia/Kolkata",
    memory: "256MiB",
    timeoutSeconds: 540,
    secrets: [TASKS_SECRET],
  },
  async () => {
    console.log("🚀 Starting closeDeliveredOrdersJob - Enqueueing tasks");

    const now = Date.now();

    const storeCreditCutoffTime = new Date(now - STORE_CREDIT_CLOSE_AFTER_HOURS * 60 * 60 * 1000);
    const regularCutoffTime = new Date(now - REGULAR_CLOSE_AFTER_HOURS * 60 * 60 * 1000);

    console.log(`📅 Store Credit Cutoff (48hrs): ${storeCreditCutoffTime.toISOString()}`);
    console.log(`📅 Regular Cutoff (120hrs): ${regularCutoffTime.toISOString()}`);

    const accountsSnapshot = await db.collection("accounts").get();
    console.log(`📊 Found ${accountsSnapshot.size} accounts to check`);

    let tasksEnqueued = 0;
    let tasksFailed = 0;

    const taskPromises: Promise<void>[] = [];

    for (const accountDoc of accountsSnapshot.docs) {
      const payload: CloseDeliveredOrdersPayload = {
        accountId: accountDoc.id,
        storeCreditCutoffTime: storeCreditCutoffTime.toISOString(),
        regularCutoffTime: regularCutoffTime.toISOString(),
      };

      const taskPromise = createTask(payload, {
        tasksSecret: TASKS_SECRET.value() || "",
        queue: process.env.CLOSE_DELIVERED_QUEUE_NAME || "close-delivered-orders-queue",
        url: process.env.CLOSE_DELIVERED_TARGET_URL!,
      })
        .then(() => {
          tasksEnqueued++;
        })
        .catch((error) => {
          tasksFailed++;
          console.error(`❌ Failed to enqueue task for account ${accountDoc.id}:`, error);
        });

      taskPromises.push(taskPromise);
    }

    await Promise.allSettled(taskPromises);
    console.log(`✅ Job complete - Tasks enqueued: ${tasksEnqueued}, Failed: ${tasksFailed}`);
  },
);

// ============================================================================
// HELPER: Close orders in batches with proper Firestore batch writes
// ============================================================================
async function closeOrdersBatch(
  orders: QueryDocumentSnapshot[],
  getRemarks: (doc: QueryDocumentSnapshot) => string,
): Promise<number> {
  if (orders.length === 0) return 0;

  const chunks = chunkArray(orders, WRITE_BATCH_SIZE);
  let totalClosed = 0;

  for (const chunk of chunks) {
    const batch = db.batch();

    chunk.forEach((doc) => {
      batch.update(doc.ref, {
        customStatus: "Closed",
        lastStatusUpdate: FieldValue.serverTimestamp(),
        customStatusesLogs: FieldValue.arrayUnion({
          status: "Closed",
          createdAt: Timestamp.now(),
          remarks: getRemarks(doc),
        }),
      });
    });

    await batch.commit();
    totalClosed += chunk.length;
  }

  return totalClosed;
}

// ============================================================================
// HELPER: Check if order has store credit payment
// ============================================================================
function hasStoreCredit(doc: QueryDocumentSnapshot): boolean {
  const paymentGatewayNames: string[] = doc.data()?.raw?.payment_gateway_names || [];
  return paymentGatewayNames.includes("shopify_store_credit");
}

// ============================================================================
// HTTP ENDPOINT - Close delivered orders for one account (with pagination)
// ============================================================================
export const closeDeliveredOrdersTask = onRequest(
  {
    cors: true,
    timeoutSeconds: 540, // Increased for large volumes
    secrets: [TASKS_SECRET],
    memory: "512MiB",
  },
  async (req, res) => {
    // ✅ AUTHENTICATION
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");
    } catch (error: any) {
      console.error("❌ Authentication failed:", error);
      res.status(401).json({ error: "Unauthorized", message: error.message });
      return;
    }

    // ✅ METHOD CHECK
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    // ✅ PARSE PAYLOAD
    const payload = req.body as CloseDeliveredOrdersPayload;

    if (
      !payload ||
      !payload.accountId ||
      !payload.storeCreditCutoffTime ||
      !payload.regularCutoffTime
    ) {
      res.status(400).json({
        error: "invalid_payload",
        message: "Missing required fields: accountId, storeCreditCutoffTime, regularCutoffTime",
      });
      return;
    }

    const { accountId, storeCreditCutoffTime, regularCutoffTime } = payload;

    console.log(`🔄 Processing account ${accountId} - closing delivered orders`);
    console.log(`📅 Store Credit Cutoff (48hrs): ${storeCreditCutoffTime}`);
    console.log(`📅 Regular Cutoff (120hrs): ${regularCutoffTime}`);

    try {
      const accountDoc = await db.collection("accounts").doc(accountId).get();

      if (!accountDoc.exists) {
        console.warn(`⚠️ Account ${accountId} not found - skipping`);
        res.status(404).json({ error: "account_not_found", accountId });
        return;
      }

      const storeCreditCutoffDate = new Date(storeCreditCutoffTime);
      const regularCutoffDate = new Date(regularCutoffTime);

      let totalStoreCreditClosed = 0;
      let totalRegularClosed = 0;

      // =========================================================================
      // PROCESS STORE CREDIT ORDERS (48 hour cutoff) - with pagination
      // =========================================================================
      console.log("💳 Processing store credit orders (48hr cutoff)...");

      let storeCreditLastDoc: QueryDocumentSnapshot | null = null;
      let storeCreditIterations = 0;

      while (storeCreditIterations < MAX_ITERATIONS) {
        let query = accountDoc.ref
          .collection("orders")
          .where("customStatus", "==", "Delivered")
          .where("raw.payment_gateway_names", "array-contains", "shopify_store_credit")
          .where("lastStatusUpdate", "<=", storeCreditCutoffDate)
          .orderBy("lastStatusUpdate", "asc")
          .limit(QUERY_BATCH_SIZE);

        if (storeCreditLastDoc) {
          query = query.startAfter(storeCreditLastDoc);
        }

        const snapshot = await query.get();

        if (snapshot.empty) {
          console.log(`💳 No more store credit orders to process`);
          break;
        }

        console.log(
          `💳 Found ${snapshot.size} store credit orders in batch ${storeCreditIterations + 1}`,
        );

        const closed = await closeOrdersBatch(
          snapshot.docs,
          () => "Order closed after 48 hours of being Delivered (Store Credit order).",
        );

        totalStoreCreditClosed += closed;
        storeCreditLastDoc = snapshot.docs[snapshot.docs.length - 1];
        storeCreditIterations++;

        // If we got less than batch size, we're done
        if (snapshot.size < QUERY_BATCH_SIZE) {
          break;
        }
      }

      if (storeCreditIterations >= MAX_ITERATIONS) {
        console.warn(
          `⚠️ Hit max iterations (${MAX_ITERATIONS}) for store credit orders - some may remain`,
        );
      }

      // =========================================================================
      // PROCESS REGULAR ORDERS (120 hour cutoff) - with pagination
      // =========================================================================
      console.log("📦 Processing regular orders (120hr cutoff)...");

      let regularLastDoc: QueryDocumentSnapshot | null = null;
      let regularIterations = 0;

      while (regularIterations < MAX_ITERATIONS) {
        let query = accountDoc.ref
          .collection("orders")
          .where("customStatus", "==", "Delivered")
          .where("lastStatusUpdate", "<=", regularCutoffDate)
          .orderBy("lastStatusUpdate", "asc")
          .limit(QUERY_BATCH_SIZE);

        if (regularLastDoc) {
          query = query.startAfter(regularLastDoc);
        }

        const snapshot = await query.get();

        if (snapshot.empty) {
          console.log(`📦 No more regular orders to process`);
          break;
        }

        // Filter out store credit orders (can't use "array-does-not-contain" in Firestore)
        const regularOrders = snapshot.docs.filter((doc) => !hasStoreCredit(doc));

        console.log(
          `📦 Found ${snapshot.size} orders in batch ${regularIterations + 1}, ` +
            `${regularOrders.length} are regular (non-store-credit)`,
        );

        if (regularOrders.length > 0) {
          const closed = await closeOrdersBatch(
            regularOrders,
            () => "Order closed after 120 hours of being Delivered.",
          );
          totalRegularClosed += closed;
        }

        regularLastDoc = snapshot.docs[snapshot.docs.length - 1];
        regularIterations++;

        // If we got less than batch size, we're done
        if (snapshot.size < QUERY_BATCH_SIZE) {
          break;
        }
      }

      if (regularIterations >= MAX_ITERATIONS) {
        console.warn(
          `⚠️ Hit max iterations (${MAX_ITERATIONS}) for regular orders - some may remain`,
        );
      }

      // =========================================================================
      // SUMMARY
      // =========================================================================
      const totalClosed = totalStoreCreditClosed + totalRegularClosed;

      console.log(`✅ Account ${accountId} processing complete:`);
      console.log(`   💳 Store Credit Orders Closed: ${totalStoreCreditClosed}`);
      console.log(`   📦 Regular Orders Closed: ${totalRegularClosed}`);
      console.log(`   📊 Total Orders Closed: ${totalClosed}`);

      res.status(200).json({
        success: true,
        accountId,
        storeCreditOrdersClosed: totalStoreCreditClosed,
        regularOrdersClosed: totalRegularClosed,
        totalOrdersClosed: totalClosed,
        storeCreditIterations,
        regularIterations,
        hitMaxIterations:
          storeCreditIterations >= MAX_ITERATIONS || regularIterations >= MAX_ITERATIONS,
      });
    } catch (error: any) {
      console.error(`❌ Error closing orders for account ${accountId}:`, error);
      res.status(500).json({
        error: "processing_failed",
        accountId,
        message: error.message,
      });
    }
  },
);
