import { onRequest } from "firebase-functions/https";
import { TASKS_SECRET } from "../../config";
import { requireHeaderSecret } from "../../helpers";
import { FieldValue, Transaction } from "firebase-admin/firestore";
import { sendSplitOrdersWhatsAppMessage } from "../../services";
import { handleSplitJobFailure, maybeCompleteSplitBatch } from "./helpers";
import { db } from "../../firebaseAdmin";

/**
 * WORKER: Process individual split job
 *
 * NOTE: Original order cancellation is handled in enqueue function.
 * This worker only creates the split order and handles payment.
 */
export const processOrderSplitJob = onRequest(
  { timeoutSeconds: 300, secrets: [TASKS_SECRET] },
  async (req, res) => {
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");

      const { shop, batchId, jobId } = (req.body || {}) as {
        shop?: string;
        batchId?: string;
        jobId?: string;
      };

      if (!shop || !batchId || !jobId) {
        console.log("missing_params");
        res.status(400).json({ error: "missing_params" });
        return;
      }

      console.log(`\n========== SPLIT JOB START ==========`);
      console.log(`Shop: ${shop} | Batch: ${batchId} | Job: ${jobId}`);

      const batchRef = db
        .collection("accounts")
        .doc(shop)
        .collection("order_split_batches")
        .doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(jobId);

      // Get batch and job data
      const [batchSnap, jobSnap] = await Promise.all([batchRef.get(), jobRef.get()]);

      if (!batchSnap.exists) {
        console.error(`Batch not found: ${batchId}`);
        res.status(404).json({ error: "batch_not_found" });
        return;
      }

      if (!jobSnap.exists) {
        console.error(`Job not found: ${jobId}`);
        res.status(404).json({ error: "job_not_found" });
        return;
      }

      const batchData = batchSnap.data()!;
      const jobData = jobSnap.data()!;

      // Check if already processed
      if (jobData.status === "success") {
        console.log(`Job already processed successfully`);
        res.status(200).json({ message: "already_processed" });
        return;
      }

      // Increment attempts and mark as processing
      await db.runTransaction(async (tx: Transaction) => {
        const j = await tx.get(jobRef);
        const jd = j.data() || {};
        if (jd.status === "success" || jd.status === "failed") return;

        tx.update(jobRef, {
          status: "processing",
          attempts: FieldValue.increment(1),
          lastAttemptAt: FieldValue.serverTimestamp(),
        });
        tx.update(batchRef, { processingJobs: FieldValue.increment(1) });
      });

      console.log(
        `Processing job ${jobData.splitIndex}/${jobData.totalSplits} for vendor: ${jobData.vendorName}`,
      );

      // Get original order
      const shopRef = db.collection("accounts").doc(shop);
      const originalOrderRef = shopRef.collection("orders").doc(batchData.originalOrderId);
      const originalOrderSnap = await originalOrderRef.get();

      if (!originalOrderSnap.exists) {
        console.error(`Original order not found: ${batchData.originalOrderId}`);
        await handleSplitJobFailure({
          batchRef,
          jobRef,
          jobId,
          errorCode: "ORIGINAL_ORDER_NOT_FOUND",
          errorMessage: "Original order not found in Firestore",
          isRetryable: false,
        });
        res.status(200).json({ error: "original_order_not_found" });
        return;
      }

      const originalOrderData = originalOrderSnap.data()!;
      const originalOrder = originalOrderData.raw;

      // Get account for API access
      const accountSnap = await db.collection("accounts").doc(shop).get();
      if (!accountSnap.exists) {
        console.error(`Account not found: ${shop}`);
        await handleSplitJobFailure({
          batchRef,
          jobRef,
          jobId,
          errorCode: "ACCOUNT_NOT_FOUND",
          errorMessage: "Account not found",
          isRetryable: false,
        });
        res.status(500).json({ error: "account_not_found" });
        return;
      }

      const accessToken = accountSnap.data()?.accessToken;
      if (!accessToken) {
        console.error(`Access token missing for: ${shop}`);
        await handleSplitJobFailure({
          batchRef,
          jobRef,
          jobId,
          errorCode: "ACCESS_TOKEN_MISSING",
          errorMessage: "Access token not found",
          isRetryable: false,
        });
        res.status(500).json({ error: "access_token_missing" });
        return;
      }

      // ============================================
      // NOTE: Original order already cancelled in enqueue function
      // No need to cancel here - just create split order
      // ============================================

      // Step 1: Create DRAFT order payload (instead of direct order)
      const includeShipping = jobData.splitIndex === 1;

      const lineItems = jobData.lineItems.map((item: any) => ({
        variant_id: item.variant_id,
        quantity: item.quantity,
        // Note: Draft orders use 'original_unit_price' instead of 'price'
        original_unit_price: item.price,
        properties: item.properties || [],
        taxable: item.taxable !== false,
        requires_shipping: item.requires_shipping !== false,
      }));

      const originalGateway = batchData.originalGateway;

      // Draft order payload structure
      const draftPayload: any = {
        draft_order: {
          line_items: lineItems,
          email: originalOrder.email,
          phone: originalOrder.phone,
          currency: originalOrder.currency,
          note: `Split ${jobData.splitIndex}/${jobData.totalSplits} from order ${batchData.originalOrderName} | Vendor: ${jobData.vendorName}`,
          note_attributes: [
            { name: "_original_order_id", value: String(batchData.originalOrderId) },
            { name: "_original_order_name", value: batchData.originalOrderName },
            { name: "_split_vendor", value: jobData.vendorName },
            { name: "_split_index", value: String(jobData.splitIndex) },
            { name: "_total_splits", value: String(jobData.totalSplits) },
            { name: "_original_financial_status", value: batchData.originalFinancialStatus },
            { name: "_original_payment_gateway", value: originalGateway },
            { name: "_proportional_discount", value: jobData.proportionalDiscount.toFixed(2) },
            { name: "_discount_applied", value: "true" },
          ],
          tags: `split-order,original-${batchData.originalOrderName},vendor-${jobData.vendorName}`,
          tax_exempt: originalOrder.tax_exempt || false,
          taxes_included: originalOrder.taxes_included || false,
          use_customer_default_address: false,
        },
      };

      // Add customer
      if (originalOrder.customer?.id) {
        draftPayload.draft_order.customer = { id: originalOrder.customer.id };
      }

      // Add addresses
      if (originalOrder.billing_address) {
        draftPayload.draft_order.billing_address = originalOrder.billing_address;
      }
      if (originalOrder.shipping_address) {
        draftPayload.draft_order.shipping_address = originalOrder.shipping_address;
      }

      // Add shipping lines (only first split)
      if (includeShipping && originalOrder.shipping_lines?.length > 0) {
        draftPayload.draft_order.shipping_line = {
          title: originalOrder.shipping_lines[0].title,
          price: originalOrder.shipping_lines[0].price,
          custom: true,
        };
      }

      // ✅ CRITICAL: Apply discount using Draft Order's applied_discount field
      if (jobData.proportionalDiscount > 0) {
        const discountTitle = originalOrder.discount_codes?.[0]?.code
          ? `Split discount (${originalOrder.discount_codes[0].code})`
          : `Split from ${batchData.originalOrderName}`;

        // Draft orders support applied_discount properly!
        draftPayload.draft_order.applied_discount = {
          description: `Proportional discount from split order`,
          value_type: "fixed_amount",
          value: jobData.proportionalDiscount.toFixed(2),
          title: discountTitle,
        };

        console.log(
          `💰 Applying proportional discount: ${discountTitle} - ₹${jobData.proportionalDiscount.toFixed(2)}`,
        );
      }

      // Step 2: Create DRAFT order
      console.log(`\n--- Creating DRAFT order for vendor: ${jobData.vendorName} ---`);
      const draftUrl = `https://${shop}/admin/api/2025-01/draft_orders.json`;

      let draftOrder: any;
      try {
        const draftResp = await fetch(draftUrl, {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(draftPayload),
        });

        if (!draftResp.ok) {
          const errorText = await draftResp.text();

          // Check for rate limit
          if (draftResp.status === 429) {
            console.error(`⚠ Shopify rate limit hit`);
            await handleSplitJobFailure({
              batchRef,
              jobRef,
              jobId,
              errorCode: "SHOPIFY_RATE_LIMIT",
              errorMessage: "Shopify API rate limit exceeded",
              isRetryable: true,
            });
            res.status(503).json({ error: "rate_limited" });
            return;
          }

          throw new Error(`Draft creation failed: ${draftResp.status} - ${errorText}`);
        }

        const result = (await draftResp.json()) as any;
        draftOrder = result.draft_order;
        console.log(`✓ Created draft order (ID: ${draftOrder.id})`);
        console.log(`  Subtotal: ₹${draftOrder.subtotal_price}`);
        console.log(`  Total Tax: ₹${draftOrder.total_tax}`);
        console.log(`  Total Price: ₹${draftOrder.total_price}`);

        // Verify discount was applied
        if (jobData.proportionalDiscount > 0) {
          const appliedDiscount = parseFloat(draftOrder.total_discounts || "0");
          console.log(`  Applied Discount: ₹${appliedDiscount.toFixed(2)}`);

          if (Math.abs(appliedDiscount - jobData.proportionalDiscount) > 0.01) {
            console.warn(
              `⚠ Discount mismatch! Expected: ₹${jobData.proportionalDiscount.toFixed(2)}, Got: ₹${appliedDiscount.toFixed(2)}`,
            );
          }
        }
      } catch (createError) {
        const errorMsg =
          createError instanceof Error ? createError.message : "Draft creation failed";
        console.error(`❌ Draft creation failed:`, createError);
        await handleSplitJobFailure({
          batchRef,
          jobRef,
          jobId,
          errorCode: "DRAFT_CREATE_FAILED",
          errorMessage: errorMsg,
          isRetryable: true,
        });
        res.status(500).json({ error: "draft_create_failed", details: errorMsg });
        return;
      }

      // Step 3: Complete the draft order to convert it to a regular order
      console.log(`\n--- Completing draft order ---`);
      const completeUrl = `https://${shop}/admin/api/2025-01/draft_orders/${draftOrder.id}/complete.json`;

      let newOrder: any;
      try {
        // Determine payment_pending based on original order's financial status
        const paymentPending = batchData.originalFinancialStatus !== "paid";

        const completeResp = await fetch(completeUrl, {
          method: "PUT",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            payment_pending: paymentPending, // false = mark as paid, true = mark as pending
          }),
        });

        if (!completeResp.ok) {
          const errorText = await completeResp.text();

          // Check for rate limit
          if (completeResp.status === 429) {
            console.error(`⚠ Shopify rate limit hit`);
            await handleSplitJobFailure({
              batchRef,
              jobRef,
              jobId,
              errorCode: "SHOPIFY_RATE_LIMIT",
              errorMessage: "Shopify API rate limit exceeded",
              isRetryable: true,
            });
            res.status(503).json({ error: "rate_limited" });
            return;
          }

          throw new Error(`Draft completion failed: ${completeResp.status} - ${errorText}`);
        }

        const result = (await completeResp.json()) as any;
        newOrder = result.draft_order;
        console.log(`✓ Completed draft order → Order ${newOrder.name} (ID: ${newOrder.order_id})`);
        console.log(`  Financial Status: ${newOrder.status}`);
        console.log(`  Total: ₹${newOrder.total_price}`);
        console.log(`  Discount: ₹${newOrder.total_discounts || "0.00"}`);

        const actualTotal = parseFloat(newOrder.total_price);
        const actualDiscount = parseFloat(newOrder.total_discounts || "0");

        console.log(`\n🔍 VERIFICATION:`);
        console.log(`  Expected total: ₹${jobData.total.toFixed(2)}`);
        console.log(`  Expected discount: ₹${jobData.proportionalDiscount.toFixed(2)}`);
        console.log(`  Shopify actual total: ₹${actualTotal.toFixed(2)}`);
        console.log(`  Shopify actual discount: ₹${actualDiscount.toFixed(2)}`);
        console.log(
          `  Difference: ₹${Math.abs(jobData.total - jobData.proportionalDiscount - actualTotal).toFixed(2)}`,
        );
      } catch (completeError) {
        const errorMsg =
          completeError instanceof Error ? completeError.message : "Draft completion failed";
        console.error(`❌ Draft completion failed:`, completeError);
        await handleSplitJobFailure({
          batchRef,
          jobRef,
          jobId,
          errorCode: "DRAFT_COMPLETE_FAILED",
          errorMessage: errorMsg,
          isRetryable: true,
        });
        res.status(500).json({ error: "draft_complete_failed", details: errorMsg });
        return;
      }

      // Get the actual order ID (draft_order.order_id is the real order ID after completion)
      const actualOrderId = newOrder.order_id;

      // Step 4: Handle payment based on original order status
      console.log(`\n--- Handling payment ---`);
      let splitPaidAmount = 0;
      let splitOutstanding = parseFloat(newOrder.total_price);
      const orderTotal = parseFloat(newOrder.total_price);

      if (batchData.originalFinancialStatus === "paid") {
        // ✅ FULLY PAID - Draft was completed with payment_pending: false
        // Shopify automatically creates a transaction, so we DON'T create another one
        console.log(`💰 Original fully paid - draft auto-marked as paid by Shopify`);
        splitPaidAmount = orderTotal;
        splitOutstanding = 0;
        console.log(`✓ Split marked as paid (₹${orderTotal.toFixed(2)})`);
      } else if (batchData.originalFinancialStatus === "partially_paid") {
        // PARTIALLY PAID - Distribute proportionally
        console.log(`⚖️ Original partially paid - distributing proportionally`);

        const originalPaid = batchData.originalTotal - batchData.originalOutstanding;
        const splitProportion = orderTotal / batchData.originalTotal;
        splitPaidAmount = originalPaid * splitProportion;
        splitOutstanding = orderTotal - splitPaidAmount;

        // Round to 2 decimals
        splitPaidAmount = Math.ceil(splitPaidAmount * 100) / 100;
        splitOutstanding = Math.ceil(splitOutstanding * 100) / 100;

        console.log(`📊 Proportion: ${(splitProportion * 100).toFixed(2)}%`);
        console.log(`💵 Paid: ₹${splitPaidAmount.toFixed(2)}`);
        console.log(`💰 Outstanding (COD): ₹${splitOutstanding.toFixed(2)}`);

        // Create partial transaction (draft was completed with payment_pending: true)
        if (splitPaidAmount > 0) {
          try {
            const txUrl = `https://${shop}/admin/api/2025-01/orders/${actualOrderId}/transactions.json`;
            const txResp = await fetch(txUrl, {
              method: "POST",
              headers: {
                "X-Shopify-Access-Token": accessToken,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                transaction: {
                  kind: "sale",
                  status: "success",
                  amount: splitPaidAmount.toFixed(2),
                  gateway: originalGateway,
                  source: "external",
                },
              }),
            });

            if (!txResp.ok) {
              const errorText = await txResp.text();
              console.error(`⚠ Failed to create partial transaction: ${errorText}`);
            } else {
              console.log(`✓ Partial payment recorded`);
            }
          } catch (txError) {
            console.error(`⚠ Partial transaction error:`, txError);
          }
        }
      } else {
        // PENDING/COD - Leave as pending (draft completed with payment_pending: true)
        console.log(`💵 Original unpaid/COD - split left as pending (₹${orderTotal.toFixed(2)})`);
        splitPaidAmount = 0;
        splitOutstanding = orderTotal;
      }

      // Step 5: Mark job as success
      const finalFinancialStatus =
        splitPaidAmount >= parseFloat(newOrder.total_price)
          ? "paid"
          : splitPaidAmount > 0
            ? "partially_paid"
            : "pending";

      await db.runTransaction(async (tx: Transaction) => {
        tx.update(jobRef, {
          status: "success",
          newOrderName: newOrder.name,
          product_name: newOrder?.line_items?.[0]?.name ?? "---",
          product_quantity: newOrder?.line_items?.[0]?.quantity ?? "---",
          draftOrderId: String(draftOrder.id),
          splitOrderId: String(actualOrderId),
          splitOrderName: newOrder.name,
          paidAmount: splitPaidAmount,
          outstandingAmount: splitOutstanding,
          financialStatus: finalFinancialStatus,
          actualTotal: parseFloat(newOrder.total_price),
          actualDiscount: parseFloat(newOrder.total_discounts || "0"),
          completedAt: FieldValue.serverTimestamp(),
        });

        tx.update(batchRef, {
          processingJobs: FieldValue.increment(-1),
          successJobs: FieldValue.increment(1),
        });
      });

      console.log(`✓ Job marked as success`);
      console.log(`  Order ID: ${actualOrderId}`);
      console.log(`  Order Name: ${newOrder.name}`);
      console.log(`  Financial Status: ${finalFinancialStatus}`);

      // Check if batch complete
      await maybeCompleteSplitBatch(batchRef);

      // If last job, update original order
      const allJobsSnap = await batchRef.collection("jobs").get();
      const allJobsSuccess = allJobsSnap.docs.every((doc) => doc.data().status === "success");

      if (allJobsSuccess) {
        console.log(`\n--- All jobs complete, updating original order ---`);

        const splitOrders = allJobsSnap.docs.map((doc) => ({
          orderId: doc.data().splitOrderId,
          orderName: doc.data().splitOrderName,
          vendor: doc.data().vendorName,
          total: doc.data().actualTotal,
          paidAmount: doc.data().paidAmount,
          outstandingAmount: doc.data().outstandingAmount,
          financialStatus: doc.data().financialStatus,
        }));

        // After all splits complete, verify total
        const totalOfAllSplits = splitOrders.reduce((sum, o) => sum + o.total, 0);
        console.log(`Original: ₹${batchData.originalTotal}, Splits: ₹${totalOfAllSplits}`);

        await originalOrderRef.update({
          "splitProcessing.status": "completed",
          "splitProcessing.completedAt": FieldValue.serverTimestamp(),
          "splitProcessing.splitOrders": splitOrders,
        });
        const shopDoc = (await shopRef.get()).data() as any;
        const oldOrder = originalOrderSnap.data() as any;
        const newOrders = allJobsSnap.docs.map((doc) => {
          const jobData = doc.data();
          return {
            name: jobData.newOrderName,
            product_name: jobData.product_name,
            quantity: jobData.product_quantity,
          };
        });
        await sendSplitOrdersWhatsAppMessage(shopDoc, oldOrder, newOrders);

        console.log(`✓ Original order updated with split results`);
      }

      console.log(`========== SPLIT JOB COMPLETE ==========\n`);

      res.status(200).json({
        success: true,
        splitOrderId: newOrder.id,
        splitOrderName: newOrder.name,
        vendor: jobData.vendorName,
        paidAmount: splitPaidAmount,
        outstandingAmount: splitOutstanding,
        total: parseFloat(newOrder.total_price),
      });
    } catch (error) {
      console.error("\n========== SPLIT JOB ERROR ==========");
      console.error(error);
      const errorMsg = error instanceof Error ? error.message : "unknown_error";
      res.status(500).json({ error: "job_failed", details: errorMsg });
    }
  },
);
