import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";

/**
 * One-time migration function to recalculate blockedStock for all business products
 *
 * Usage: Call this endpoint with POST request
 * Body (optional): { "dryRun": true, "batchSize": 50 }
 */
export const migrateBlockedStock = onRequest(
  {
    cors: true,
    timeoutSeconds: 3600,
    memory: "2GiB",
    maxInstances: 1, // Ensure only one instance runs at a time
  },
  async (req, res) => {
    const startTime = Date.now();
    const businessId = "2yEGCC8AffNxDoTZEqhAkCRgxNl2";

    // Configuration from request body
    const dryRun = req.body?.dryRun === true;
    const batchSize = req.body?.batchSize || 50; // Process 50 products at a time

    console.log(`🚀 Starting blocked stock migration for business ${businessId}`);
    console.log(`   Mode: ${dryRun ? "DRY RUN" : "LIVE UPDATE"}`);
    console.log(`   Batch size: ${batchSize}`);

    try {
      const businessDoc = await db.doc(`users/${businessId}`).get();

      if (!businessDoc.exists) {
        res.status(404).json({ error: "Business not found" });
        return;
      }

      // Get all products for this business
      const productsSnapshot = await db.collection(`users/${businessId}/products`).get();

      const totalProducts = productsSnapshot.size;
      console.log(`📦 Found ${totalProducts} products to process`);

      const stats = {
        total: totalProducts,
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        totalBlockedStockCalculated: 0,
      };

      const errors: Array<{ productId: string; error: string }> = [];
      const updates: Array<{
        productId: string;
        description: string;
        oldBlockedStock: number;
        newBlockedStock: number;
      }> = [];

      // Process products in batches
      const productDocs = productsSnapshot.docs;

      for (let i = 0; i < productDocs.length; i += batchSize) {
        const batchDocs = productDocs.slice(i, i + batchSize);
        const batchNumber = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(totalProducts / batchSize);

        console.log(
          `\n🔄 Processing batch ${batchNumber}/${totalBatches} (${batchDocs.length} products)`,
        );

        // Process batch concurrently
        await Promise.all(
          batchDocs.map(async (productDoc) => {
            const productId = productDoc.id;
            const productData = productDoc.data();

            try {
              const mappedVariants = productData?.mappedVariants || [];

              if (mappedVariants.length === 0) {
                console.log(`  ⏭️  ${productId}: No mapped variants, skipping`);
                stats.skipped++;
                stats.processed++;
                return;
              }

              console.log(
                `  🔍 ${productId}: Processing ${mappedVariants.length} mapped variants...`,
              );

              let totalBlockedStock = 0;

              // Calculate blocked stock for each mapped variant
              for (const variant of mappedVariants) {
                const { storeId, variantId } = variant;

                if (!storeId || !variantId) {
                  console.warn(`    ⚠️  Invalid variant data in ${productId}`);
                  continue;
                }

                // Build query for orders
                let ordersQuery = db
                  .collection("accounts")
                  .doc(storeId)
                  .collection("orders")
                  .where("customStatus", "in", ["New", "Confirmed", "Ready To Dispatch"]);

                const ordersSnapshot = await ordersQuery.get();

                // Calculate blocked quantity for this variant
                let variantBlockedStock = 0;

                for (const orderDoc of ordersSnapshot.docs) {
                  if (!orderDoc.exists) continue;

                  const orderData = orderDoc.data();

                  const line_items: any[] = orderData?.raw?.line_items || [];

                  const quantity = line_items
                    .filter((item) => item.variant_id === variantId)
                    .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

                  variantBlockedStock += quantity;
                }

                totalBlockedStock += variantBlockedStock;

                if (variantBlockedStock > 0) {
                  console.log(
                    `    ✓ Variant ${variantId} (${storeId}): ${variantBlockedStock} units blocked`,
                  );
                }
              }

              const currentBlockedStock = productData?.inventory?.blockedStock || 0;

              console.log(
                `  📊 ${productId}: Current=${currentBlockedStock}, Calculated=${totalBlockedStock}`,
              );

              // Update the product
              if (!dryRun) {
                const productRef = db.doc(`users/${businessId}/products/${productId}`);

                await db.runTransaction(async (tx) => {
                  const currentDoc = await tx.get(productRef);

                  if (!currentDoc.exists) {
                    console.warn(`    ⚠️  Product ${productId} no longer exists`);
                    return;
                  }

                  const currentInventory = currentDoc.data()?.inventory;

                  tx.update(productRef, {
                    inventory: {
                      ...(currentInventory || {
                        autoAddition: 0,
                        autoDeduction: 0,
                        blockedStock: 0,
                        deduction: 0,
                        inwardAddition: 0,
                        openingStock: 0,
                      }),
                      blockedStock: totalBlockedStock,
                    },
                  });
                });

                stats.updated++;
              }

              stats.processed++;
              stats.totalBlockedStockCalculated += totalBlockedStock;

              updates.push({
                productId,
                description: productData?.description || "N/A",
                oldBlockedStock: currentBlockedStock,
                newBlockedStock: totalBlockedStock,
              });

              console.log(
                `  ✅ ${productId}: ${dryRun ? "Would update" : "Updated"} to ${totalBlockedStock}`,
              );
            } catch (error: any) {
              console.error(`  ❌ ${productId}: ${error.message}`);
              stats.errors++;
              stats.processed++;
              errors.push({
                productId,
                error: error.message,
              });
            }
          }),
        );

        // Progress update
        const progressPercent = Math.round((stats.processed / totalProducts) * 100);
        console.log(`\n📈 Progress: ${stats.processed}/${totalProducts} (${progressPercent}%)`);
        console.log(
          `   Updated: ${stats.updated}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`,
        );

        // Add a small delay between batches to avoid overwhelming Firestore
        if (i + batchSize < productDocs.length) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      const duration = Math.round((Date.now() - startTime) / 1000);

      console.log("\n" + "=".repeat(60));
      console.log("✅ MIGRATION COMPLETE");
      console.log("=".repeat(60));
      console.log(`Duration: ${duration}s`);
      console.log(`Mode: ${dryRun ? "DRY RUN (no changes made)" : "LIVE UPDATE"}`);
      console.log(`Total products: ${stats.total}`);
      console.log(`Processed: ${stats.processed}`);
      console.log(`Updated: ${stats.updated}`);
      console.log(`Skipped: ${stats.skipped}`);
      console.log(`Errors: ${stats.errors}`);
      console.log(`Total blocked stock calculated: ${stats.totalBlockedStockCalculated}`);

      res.status(200).json({
        success: true,
        dryRun,
        duration: `${duration}s`,
        stats,
        errors: errors.length > 0 ? errors : undefined,
        updates:
          updates.length <= 100 ? updates : `${updates.length} updates (too many to display)`,
      });
    } catch (error: any) {
      console.error("💥 FATAL ERROR:", error);
      res.status(500).json({
        success: false,
        error: error.message,
        stack: error.stack,
      });
    }
  },
);
