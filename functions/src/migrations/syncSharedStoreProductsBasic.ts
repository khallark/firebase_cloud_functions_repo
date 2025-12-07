import { onRequest } from "firebase-functions/v2/https";
import { ENQUEUE_FUNCTION_SECRET, SHARED_STORE_ID } from "../config";
import { chunkArray, requireHeaderSecret, sleep } from "../helpers";
import { db } from "../firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Fetches all products with basic info and metafields only
 */
export const syncSharedStoreProductsBasic = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req, res) => {
    try {
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      console.log("🚀 Starting basic product sync for shared store...");

      const shopDoc = await db.collection("accounts").doc(SHARED_STORE_ID).get();
      if (!shopDoc.exists) {
        res.status(404).json({ error: "shared_store_not_found" });
        return;
      }

      const accessToken = shopDoc.data()?.accessToken;
      if (!accessToken) {
        res.status(500).json({ error: "access_token_missing" });
        return;
      }

      const products = await fetchBasicProducts(SHARED_STORE_ID, accessToken);

      console.log(`📦 Fetched ${products.length} products from Shopify`);

      // Store in Firestore
      const productsCollection = db
        .collection("accounts")
        .doc(SHARED_STORE_ID)
        .collection("products");

      // Clear existing products
      console.log("🗑️ Clearing existing products...");
      const existingProducts = await productsCollection.listDocuments();
      const deleteChunks = chunkArray(existingProducts, 500);

      for (const chunk of deleteChunks) {
        const batch = db.batch();
        chunk.forEach((doc) => batch.delete(doc));
        await batch.commit();
      }

      // Store new products
      console.log("💾 Storing products in Firestore...");
      const productChunks = chunkArray(products, 500);

      for (const chunk of productChunks) {
        const batch = db.batch();

        chunk.forEach((product) => {
          const productRef = productsCollection.doc(String(product.id));
          batch.set(productRef, {
            ...product,
            syncedAt: FieldValue.serverTimestamp(),
          });
        });

        await batch.commit();
        console.log(`  ✓ Stored batch of ${chunk.length} products`);
      }

      console.log("✅ Product sync completed successfully");

      res.json({
        success: true,
        message: "Products synced successfully",
        stats: {
          totalProducts: products.length,
          storeId: SHARED_STORE_ID,
        },
      });
    } catch (error) {
      console.error("❌ Error syncing products:", error);
      res.status(500).json({
        error: "product_sync_failed",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

/**
 * Extract numeric ID from Shopify GID format
 * @param gid - Shopify GID (e.g., "gid://shopify/Product/123456789")
 * @returns Numeric ID as string (e.g., "123456789")
 */
function extractNumericId(gid: string): string {
  if (!gid) return "";

  // If it's already numeric, return as-is
  if (/^\d+$/.test(gid)) {
    return gid;
  }

  // Extract from GID format: gid://shopify/Product/123456789
  const parts = gid.split("/");
  return parts[parts.length - 1];
}

/**
 * Fetches basic product info with metafields using minimal GraphQL query
 */
async function fetchBasicProducts(shop: string, accessToken: string): Promise<any[]> {
  const allProducts: any[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let pageCount = 0;

  const PRODUCTS_PER_PAGE = 250;

  while (hasNextPage) {
    pageCount++;
    console.log(`📄 Fetching page ${pageCount}...`);

    // MINIMAL QUERY - Basic info + Metafields only
    const query = `
      query GetProducts($cursor: String, $first: Int!) {
        products(first: $first, after: $cursor) {
          edges {
            cursor
            node {
              # Basic Product Info
              id
              legacyResourceId
              title
              handle
              description(truncateAt: 500)
              descriptionHtml
              vendor
              productType
              tags
              status
              
              # Dates
              createdAt
              updatedAt
              publishedAt
              
              # Simple flags
              totalInventory
              tracksInventory
              
              # Metafields - THIS IS WHAT YOU WANT
              metafields(first: 250) {
                edges {
                  node {
                    id
                    namespace
                    key
                    value
                    type
                    description
                    createdAt
                    updatedAt
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const variables = {
      first: PRODUCTS_PER_PAGE,
      cursor,
    };

    const response = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as any;

    if (result.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    const products = result.data?.products?.edges || [];
    const pageInfo = result.data?.products?.pageInfo;

    // Extract and clean product data
    products.forEach((edge: any) => {
      const product = edge.node;

      allProducts.push({
        id: extractNumericId(product.id),
        shopifyId: product.id,
        legacyResourceId: product.legacyResourceId,
        title: product.title,
        handle: product.handle,
        description: product.description,
        descriptionHtml: product.descriptionHtml,
        vendor: product.vendor,
        productType: product.productType,
        tags: product.tags,
        status: product.status,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        publishedAt: product.publishedAt,
        totalInventory: product.totalInventory,
        tracksInventory: product.tracksInventory,

        // Clean metafields
        metafields: product.metafields.edges.map((edge: any) => ({
          id: extractNumericId(edge.node.id),
          shopifyId: edge.node.id,
          namespace: edge.node.namespace,
          key: edge.node.key,
          value: edge.node.value,
          type: edge.node.type,
          description: edge.node.description,
          createdAt: edge.node.createdAt,
          updatedAt: edge.node.updatedAt,
        })),
      });
    });

    console.log(`  ✓ Fetched ${products.length} products (Total: ${allProducts.length})`);

    hasNextPage = pageInfo?.hasNextPage || false;
    cursor = pageInfo?.endCursor || null;

    if (hasNextPage) {
      await sleep(500);
    }
  }

  return allProducts;
}
