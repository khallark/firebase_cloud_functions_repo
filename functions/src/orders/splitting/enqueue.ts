import { onRequest } from "firebase-functions/v2/https";
import { requireHeaderSecret } from "../../helpers";
import { ENQUEUE_FUNCTION_SECRET, SHARED_STORE_ID, TASKS_SECRET } from "../../config";
import { createTask } from "../../services";
import { db } from "../../firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import {
  calculateProportionalDiscount,
  groupLineItemsByVendor,
  hasMultipleVendors,
} from "./helpers";

/**
 * ENQUEUE: Called from webhook to create batch + jobs for order splitting
 *
 * CRITICAL: Cancels the original order BEFORE creating any jobs to prevent
 * race conditions where split orders are created but original isn't cancelled.
 */
export const enqueueOrderSplitBatch = onRequest(
  { cors: true, timeoutSeconds: 60, secrets: [ENQUEUE_FUNCTION_SECRET, TASKS_SECRET] },
  async (req, res) => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const { shop, orderId, requestedBy } = (req.body || {}) as {
        shop?: string;
        orderId?: string;
        requestedBy?: string;
      };

      console.log(shop, orderId, requestedBy);

      if (!shop || !orderId || !requestedBy) {
        console.error("missing_shop_or_orderId");
        res.status(400).json({ error: "missing_shop_or_orderId" });
        return;
      }

      if (shop !== SHARED_STORE_ID) {
        console.error("invalid_shop_order_for_splitting");
        res.status(403).json({ error: "invalid_shop_order_for_splitting" });
        return;
      }

      console.log(`\n========== ORDER SPLIT ENQUEUE START ==========`);
      console.log(`Shop: ${shop} | Order: ${orderId}`);

      // Get order from Firestore
      const orderRef = db.collection("accounts").doc(shop).collection("orders").doc(orderId);
      const orderSnap = await orderRef.get();

      if (!orderSnap.exists) {
        console.error(`Order not found: ${orderId}`);
        res.status(404).json({ error: "order_not_found" });
        return;
      }

      const orderData = orderSnap.data()!;
      const originalOrder = orderData.raw;

      if (orderData.customStatus !== "New") {
        console.log("cannot_perform_splitting_on_any_status_but_new");
        res.status(403).json({ error: "cannot_perform_splitting_on_any_status_but_new" });
        return;
      }

      if (!originalOrder || !originalOrder.line_items) {
        console.error(`Invalid order data for: ${orderId}`);
        res.status(400).json({ error: "invalid_order_data" });
        return;
      }

      // Check if order needs splitting
      if (!hasMultipleVendors(originalOrder.line_items)) {
        console.log(`Order ${orderId} is single vendor - no split needed`);
        res.status(400).json({ error: "order_is_single_vendor" });
        return;
      }

      // Check if already being processed
      if (
        orderData.splitProcessing?.status === "processing" ||
        orderData.splitProcessing?.status === "completed"
      ) {
        console.log(`Order ${orderId} already processing or completed`);
        res.status(200).json({ message: "already_processing_or_completed" });
        return;
      }

      // Get account for API access
      const accountSnap = await db.collection("accounts").doc(shop).get();
      if (!accountSnap.exists) {
        console.error(`Account not found: ${shop}`);
        res.status(500).json({ error: "account_not_found" });
        return;
      }

      const accessToken = accountSnap.data()?.accessToken;
      if (!accessToken) {
        console.error(`Access token not found for: ${shop}`);
        res.status(500).json({ error: "access_token_missing" });
        return;
      }

      // ============================================
      // ✅ STEP 1: CANCEL ORDER FIRST (CRITICAL!)
      // ============================================
      console.log(`\n--- Cancelling original order ${orderId} ---`);
      const cancelUrl = `https://${shop}/admin/api/2025-01/orders/${orderId}/cancel.json`;

      try {
        const cancelResp = await fetch(cancelUrl, {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            reason: "other",
            email: false,
            restock: true,
          }),
        });

        if (!cancelResp.ok) {
          const errorText = await cancelResp.text();
          console.error(`❌ Cancel failed: ${cancelResp.status} - ${errorText}`);

          // Mark order as failed to split
          await orderRef.update({
            "splitProcessing.status": "failed",
            "splitProcessing.error": `Cancel failed: ${cancelResp.status} - ${errorText}`,
            "splitProcessing.failedAt": FieldValue.serverTimestamp(),
            "splitProcessing.cancelAttempted": true,
            "splitProcessing.cancelFailed": true,
          });

          res.status(500).json({
            error: "cancel_failed",
            details: errorText,
            statusCode: cancelResp.status,
            message: "Original order could not be cancelled. No split orders were created.",
          });
          return; // ← STOP HERE - Don't create batch or jobs
        }

        console.log(`✅ Original order cancelled successfully`);
      } catch (cancelError) {
        const errorMsg = cancelError instanceof Error ? cancelError.message : "Cancel failed";
        console.error(`❌ Cancel error:`, cancelError);

        await orderRef.update({
          "splitProcessing.status": "failed",
          "splitProcessing.error": errorMsg,
          "splitProcessing.failedAt": FieldValue.serverTimestamp(),
          "splitProcessing.cancelAttempted": true,
          "splitProcessing.cancelFailed": true,
        });

        res.status(500).json({
          error: "cancel_failed",
          details: errorMsg,
          message: "Original order could not be cancelled. No split orders were created.",
        });
        return; // ← STOP HERE
      }

      // ============================================
      // ✅ STEP 2: Cancel succeeded, create batch
      // ============================================
      console.log(`\n--- Creating batch and jobs ---`);

      const vendorGroups = groupLineItemsByVendor(originalOrder.line_items);
      console.log(`Found ${vendorGroups.length} vendor groups`);

      // Calculate total discount if any
      const originalTotalDiscount = parseFloat(originalOrder.total_discounts || "0");
      const originalSubtotal = parseFloat(originalOrder.subtotal_price || "0");
      const hasDiscount = originalTotalDiscount > 0;

      if (hasDiscount) {
        console.log(`\n💰 Original order has discount: ₹${originalTotalDiscount.toFixed(2)}`);
      }

      // Create batch
      const batchRef = db.collection("accounts").doc(shop).collection("order_split_batches").doc();

      const batchData = {
        requestedBy,
        originalOrderId: orderId,
        originalOrderName: originalOrder.name,
        originalFinancialStatus: originalOrder.financial_status,
        originalTotal: parseFloat(originalOrder.total_price || "0"),
        originalOutstanding: parseFloat(originalOrder.total_outstanding || "0"),
        originalGateway:
          originalOrder.gateway || originalOrder.payment_gateway_names?.[0] || "manual",
        status: "pending",
        totalJobs: vendorGroups.length,
        processingJobs: 0,
        successJobs: 0,
        failedJobs: 0,
        createdAt: FieldValue.serverTimestamp(),
        vendorCount: vendorGroups.length,
        originalCancelled: true, // ← Flag that original was cancelled
        cancelledAt: FieldValue.serverTimestamp(),
      };

      await batchRef.set(batchData);
      console.log(`✓ Created batch: ${batchRef.id}`);

      // Create jobs for each vendor
      const jobPromises = vendorGroups.map(async (group, index) => {
        const jobRef = batchRef.collection("jobs").doc();

        let proportionalDiscount = 0;

        if (hasDiscount) {
          if (index === vendorGroups.length - 1) {
            // LAST SPLIT: Gets remainder to ensure exact sum
            const sumOfPreviousDiscounts = vendorGroups.slice(0, index).reduce((sum, g) => {
              const d = calculateProportionalDiscount(
                originalSubtotal,
                originalTotalDiscount,
                g.subtotal,
              );
              return sum + d;
            }, 0);

            proportionalDiscount = originalTotalDiscount - sumOfPreviousDiscounts;
            console.log(
              `  💰 Last split gets remainder discount: ₹${proportionalDiscount.toFixed(2)}`,
            );
          } else {
            // FIRST/MIDDLE SPLITS: Calculate and round normally
            proportionalDiscount = calculateProportionalDiscount(
              originalSubtotal,
              originalTotalDiscount,
              group.subtotal,
            );
          }
        }

        const jobData = {
          vendorName: group.vendor,
          status: "pending",
          splitIndex: index + 1,
          totalSplits: vendorGroups.length,
          lineItems: group.lineItems,
          subtotal: group.subtotal,
          tax: group.tax,
          total: group.total,
          totalWeight: group.totalWeight,
          proportionalDiscount, // ← Now guaranteed to sum exactly
          attempts: 0,
          createdAt: FieldValue.serverTimestamp(),
        };
        await jobRef.set(jobData);
        console.log(
          `  ✓ Job ${index + 1}/${vendorGroups.length}: ${group.vendor} (₹${group.total.toFixed(2)}, discount: ₹${proportionalDiscount.toFixed(2)})`,
        );
        return jobRef.id;
      });

      const jobIds = await Promise.all(jobPromises);

      // Update order with batch reference
      await orderRef.update({
        "splitProcessing.status": "pending",
        "splitProcessing.batchId": batchRef.id,
        "splitProcessing.detectedAt": FieldValue.serverTimestamp(),
        "splitProcessing.vendorCount": vendorGroups.length,
        "splitProcessing.originalCancelled": true, // ← Confirm original was cancelled
        "splitProcessing.cancelledAt": FieldValue.serverTimestamp(),
      });

      // Enqueue tasks for each job
      console.log(`\n--- Queueing ${jobIds.length} tasks ---`);
      const workerUrl = process.env.ORDER_SPLIT_TARGET_URL || "";
      const queueName = process.env.ORDER_SPLIT_QUEUE_NAME || "order-splits-queue";

      if (!workerUrl) {
        throw new Error("ORDER_SPLIT_WORKER_URL not configured");
      }

      const taskPromises = jobIds.map((jobId) =>
        createTask(
          { shop, batchId: batchRef.id, jobId },
          {
            tasksSecret: TASKS_SECRET.value() || "",
            url: workerUrl,
            queue: queueName,
            delaySeconds: 0,
          },
        ),
      );

      await Promise.all(taskPromises);

      console.log(`✅ Enqueued ${jobIds.length} split jobs for order ${orderId}`);
      console.log(`========== ORDER SPLIT ENQUEUE COMPLETE ==========\n`);

      res.status(200).json({
        success: true,
        batchId: batchRef.id,
        jobCount: jobIds.length,
        jobIds,
        originalCancelled: true, // ← Confirm to caller
        message: `Original order cancelled and ${jobIds.length} split jobs queued`,
      });
    } catch (error) {
      console.error("\n========== ORDER SPLIT ENQUEUE ERROR ==========");
      console.error(error);
      const errorMsg = error instanceof Error ? error.message : "unknown_error";
      res.status(500).json({ error: "enqueue_failed", details: errorMsg });
    }
  },
);
