import { onRequest } from "firebase-functions/https";
import { db } from "../firebaseAdmin";

interface MigrationRequest {
  sourceShopDomain: string;
  targetShopDomain: string;
  targetAccessToken: string;
  batchSize?: number;
  offset?: number; // For pagination
}

interface ShopifyProductPayload {
  product: {
    title: string;
    body_html?: string;
    vendor?: string;
    product_type?: string;
    tags?: string;
    status?: string;
    variants?: Array<{
      option1?: string;
      option2?: string;
      option3?: string;
      price?: string;
      sku?: string;
      inventory_quantity?: number;
      compare_at_price?: string;
      barcode?: string;
      weight?: number;
      weight_unit?: string;
      requires_shipping?: boolean;
      taxable?: boolean;
      inventory_management?: string | null;
      inventory_policy?: string;
      fulfillment_service?: string;
    }>;
    options?: Array<{
      name: string;
      values: string[];
    }>;
    images?: Array<{
      src: string;
      alt?: string;
      width?: number;
      height?: number;
      position?: number;
    }>;
  };
}

/**
 * Maps Firestore product data to Shopify API format
 */
function mapProductToShopifyFormat(productData: any): ShopifyProductPayload {
  const payload: ShopifyProductPayload = {
    product: {
      title: productData.title || "Untitled Product",
      body_html: productData.bodyHtml || "",
      vendor: productData.vendor || "",
      product_type: productData.productType || "",
      tags: Array.isArray(productData.tags) ? productData.tags.join(", ") : productData.tags || "",
      status: productData.status || "draft",
    },
  };

  // Map variants
  if (productData.variants && Array.isArray(productData.variants)) {
    payload.product.variants = productData.variants.map((v: any) => ({
      option1: v.option1,
      option2: v.option2,
      option3: v.option3,
      price: v.price?.toString() || "0.00",
      sku: v.sku || "",
      inventory_quantity: v.inventoryQuantity || 0,
      compare_at_price: v.compareAtPrice?.toString() || undefined,
      barcode: v.barcode || undefined,
      weight: v.weight || undefined,
      weight_unit: v.weightUnit || "kg",
      requires_shipping: v.requiresShipping ?? true,
      taxable: v.taxable ?? true,
      inventory_management: v.inventoryManagement || null,
      inventory_policy: v.inventoryPolicy || "deny",
      fulfillment_service: v.fulfillmentService || "manual",
    }));
  }

  // Map options
  if (productData.options && Array.isArray(productData.options)) {
    payload.product.options = productData.options
      .filter((opt: any) => opt.name && opt.name !== "Title")
      .map((opt: any) => ({
        name: opt.name,
        values: opt.values || [],
      }));
  }

  // Map images
  if (productData.images && Array.isArray(productData.images)) {
    payload.product.images = productData.images.map((img: any) => ({
      src: img.src,
      alt: img.alt || undefined,
      width: img.width || undefined,
      height: img.height || undefined,
      position: img.position || undefined,
    }));
  } else if (productData.featuredImage && productData.featuredImage.src) {
    // Fallback to featured image if images array is empty
    payload.product.images = [
      {
        src: productData.featuredImage.src,
        alt: productData.featuredImage.alt || undefined,
        width: productData.featuredImage.width || undefined,
        height: productData.featuredImage.height || undefined,
      },
    ];
  }

  return payload;
}

/**
 * Creates a product on Shopify using Admin API
 */
async function createProductOnShopify(
  shopDomain: string,
  accessToken: string,
  productPayload: ShopifyProductPayload,
): Promise<{ success: boolean; shopifyProductId?: string; error?: string }> {
  const url = `https://${shopDomain}/admin/api/2025-01/products.json`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(productPayload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Failed to create product. Status: ${response.status}. Body: ${errorBody}`);
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorBody}`,
      };
    }

    const result = (await response.json()) as any;
    return {
      success: true,
      shopifyProductId: result.product?.id?.toString(),
    };
  } catch (error) {
    console.error("Error creating product on Shopify:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Main migration HTTP endpoint
 */
export const migrateProductsOnShopify = onRequest(
  {
    cors: true,
    timeoutSeconds: 3600,
    memory: "1GiB",
  },
  async (req, res) => {
    // Only allow POST requests
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed. Use POST." });
      return;
    }

    const {
      sourceShopDomain,
      targetShopDomain,
      targetAccessToken,
      batchSize = 50,
      offset = 0,
    }: MigrationRequest = req.body;

    // Validate required parameters
    if (!sourceShopDomain || !targetShopDomain || !targetAccessToken) {
      res.status(400).json({
        error: "Missing required parameters",
        required: ["sourceShopDomain", "targetShopDomain", "targetAccessToken"],
      });
      return;
    }

    console.log(`Starting migration from ${sourceShopDomain} to ${targetShopDomain}`);
    console.log(`Batch size: ${batchSize}, Offset: ${offset}`);

    const results = {
      total: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      offset,
      hasMore: false,
      errors: [] as Array<{ productId: string; title: string; error: string }>,
    };

    try {
      // Get products from source store (excluding deleted ones)
      let query = db
        .collection("accounts")
        .doc(sourceShopDomain)
        .collection("products")
        .where("isDeleted", "==", false)
        .orderBy("firestoreCreatedAt")
        .limit(batchSize);

      // Apply offset if provided
      if (offset > 0) {
        const skipSnapshot = await db
          .collection("accounts")
          .doc(sourceShopDomain)
          .collection("products")
          .where("isDeleted", "==", false)
          .orderBy("firestoreCreatedAt")
          .limit(offset)
          .get();

        if (!skipSnapshot.empty) {
          const lastDoc = skipSnapshot.docs[skipSnapshot.docs.length - 1];
          query = query.startAfter(lastDoc);
        }
      }

      const productsSnapshot = await query.get();
      results.total = productsSnapshot.size;

      // Check if there are more products
      const nextBatch = await db
        .collection("accounts")
        .doc(sourceShopDomain)
        .collection("products")
        .where("isDeleted", "==", false)
        .orderBy("firestoreCreatedAt")
        .limit(1)
        .startAfter(productsSnapshot.docs[productsSnapshot.docs.length - 1])
        .get();

      results.hasMore = !nextBatch.empty;

      console.log(`Found ${results.total} products to migrate in this batch`);

      // Process products with rate limiting
      for (const doc of productsSnapshot.docs) {
        const productData = doc.data();
        const productId = doc.id;
        const productTitle = productData.title || "Untitled";

        console.log(`Processing product: ${productId} - ${productTitle}`);

        try {
          // Map product to Shopify format
          const shopifyPayload = mapProductToShopifyFormat(productData);

          // Create product on target store
          const result = await createProductOnShopify(
            targetShopDomain,
            targetAccessToken,
            shopifyPayload,
          );

          if (result.success) {
            results.successful++;
            console.log(
              `✅ Successfully created product ${productId} as Shopify product ${result.shopifyProductId}`,
            );
          } else {
            results.failed++;
            results.errors.push({
              productId,
              title: productTitle,
              error: result.error || "Unknown error",
            });
            console.error(`❌ Failed to create product ${productId}: ${result.error}`);
          }

          // Rate limiting: 500ms between requests (2 req/sec)
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (error) {
          results.failed++;
          const errorMsg = error instanceof Error ? error.message : "Unknown error";
          results.errors.push({
            productId,
            title: productTitle,
            error: errorMsg,
          });
          console.error(`Error processing product ${productId}:`, error);
        }
      }

      console.log("Migration batch complete:", results);

      // Return results
      res.status(200).json({
        success: true,
        message: "Migration batch completed",
        results,
        nextOffset: results.hasMore ? offset + batchSize : null,
      });
    } catch (error) {
      console.error("Fatal error during migration:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        results,
      });
    }
  },
);
