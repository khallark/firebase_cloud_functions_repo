import { onRequest } from 'firebase-functions/https';
import { db } from '../firebaseAdmin';

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
            weight?: number;
            weight_unit?: string;
            requires_shipping?: boolean;
            taxable?: boolean;
        }>;
        options?: Array<{
            name: string;
            values: string[];
        }>;
        images?: Array<{
            src: string;
            alt?: string;
        }>;
    };
}

/**
 * Maps Firestore product data to Shopify API format
 */
function mapProductToShopifyFormat(productData: any): ShopifyProductPayload {
    const raw = productData.raw || {};

    const payload: ShopifyProductPayload = {
        product: {
            title: raw.title || productData.title || 'Untitled Product',
            body_html: raw.body_html || '',
            vendor: raw.vendor || productData.vendor || '',
            product_type: raw.product_type || productData.productType || '',
            tags: raw.tags || productData.tags || '',
            status: raw.status || productData.status || 'draft',
        }
    };

    // Map variants
    if (raw.variants && Array.isArray(raw.variants)) {
        payload.product.variants = raw.variants.map((v: any) => ({
            option1: v.option1,
            option2: v.option2,
            option3: v.option3,
            price: v.price?.toString() || '0.00',
            sku: v.sku || '',
            inventory_quantity: v.inventory_quantity || 0,
            weight: v.weight,
            weight_unit: v.weight_unit || 'kg',
            requires_shipping: v.requires_shipping ?? true,
            taxable: v.taxable ?? true,
        }));
    }

    // Map options
    if (raw.options && Array.isArray(raw.options)) {
        payload.product.options = raw.options
            .filter((opt: any) => opt.name && opt.name !== 'Title')
            .map((opt: any) => ({
                name: opt.name,
                values: opt.values || [],
            }));
    }

    // Map images
    if (raw.images && Array.isArray(raw.images)) {
        payload.product.images = raw.images.map((img: any) => ({
            src: img.src,
            alt: img.alt || '',
        }));
    } else if (raw.image && raw.image.src) {
        payload.product.images = [{
            src: raw.image.src,
            alt: raw.image.alt || '',
        }];
    }

    return payload;
}

/**
 * Creates a product on Shopify using Admin API
 */
async function createProductOnShopify(
    shopDomain: string,
    accessToken: string,
    productPayload: ShopifyProductPayload
): Promise<{ success: boolean; shopifyProductId?: string; error?: string }> {
    const url = `https://${shopDomain}/admin/api/2025-01/products.json`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'X-Shopify-Access-Token': accessToken,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(productPayload),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`Failed to create product. Status: ${response.status}. Body: ${errorBody}`);
            return {
                success: false,
                error: `HTTP ${response.status}: ${errorBody}`
            };
        }

        const result = await response.json() as any;
        return {
            success: true,
            shopifyProductId: result.product?.id?.toString()
        };
    } catch (error) {
        console.error('Error creating product on Shopify:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Main migration HTTP endpoint
 */
export const migrateProducts = onRequest(
    {
        cors: true,
        timeoutSeconds: 3600,
        memory: "1GiB",
    },
    async (req, res) => {

        // Only allow POST requests
        if (req.method !== 'POST') {
            res.status(405).json({ error: 'Method not allowed. Use POST.' });
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
                error: 'Missing required parameters',
                required: ['sourceShopDomain', 'targetShopDomain', 'targetAccessToken']
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
                .collection('accounts')
                .doc(sourceShopDomain)
                .collection('products')
                .where('isDeleted', '==', false)
                .orderBy('firestoreCreatedAt')
                .limit(batchSize);

            // Apply offset if provided
            if (offset > 0) {
                const skipSnapshot = await db
                    .collection('accounts')
                    .doc(sourceShopDomain)
                    .collection('products')
                    .where('isDeleted', '==', false)
                    .orderBy('firestoreCreatedAt')
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
                .collection('accounts')
                .doc(sourceShopDomain)
                .collection('products')
                .where('isDeleted', '==', false)
                .orderBy('firestoreCreatedAt')
                .limit(1)
                .startAfter(productsSnapshot.docs[productsSnapshot.docs.length - 1])
                .get();

            results.hasMore = !nextBatch.empty;

            console.log(`Found ${results.total} products to migrate in this batch`);

            // Process products with rate limiting
            for (const doc of productsSnapshot.docs) {
                const productData = doc.data();
                const productId = doc.id;
                const productTitle = productData.title || 'Untitled';

                console.log(`Processing product: ${productId} - ${productTitle}`);

                try {
                    // Map product to Shopify format
                    const shopifyPayload = mapProductToShopifyFormat(productData);

                    // Create product on target store
                    const result = await createProductOnShopify(
                        targetShopDomain,
                        targetAccessToken,
                        shopifyPayload
                    );

                    if (result.success) {
                        results.successful++;
                        console.log(`✅ Successfully created product ${productId} as Shopify product ${result.shopifyProductId}`);
                    } else {
                        results.failed++;
                        results.errors.push({
                            productId,
                            title: productTitle,
                            error: result.error || 'Unknown error',
                        });
                        console.error(`❌ Failed to create product ${productId}: ${result.error}`);
                    }

                    // Rate limiting: 500ms between requests (2 req/sec)
                    await new Promise(resolve => setTimeout(resolve, 500));

                } catch (error) {
                    results.failed++;
                    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                    results.errors.push({
                        productId,
                        title: productTitle,
                        error: errorMsg
                    });
                    console.error(`Error processing product ${productId}:`, error);
                }
            }

            console.log('Migration batch complete:', results);

            // Return results
            res.status(200).json({
                success: true,
                message: 'Migration batch completed',
                results,
                nextOffset: results.hasMore ? offset + batchSize : null,
            });

        } catch (error) {
            console.error('Fatal error during migration:', error);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                results,
            });
        }
    }
);