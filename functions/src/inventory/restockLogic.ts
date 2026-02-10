// restock-logic.ts
// TypeScript functions for inventory restock prediction with Firestore

import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../firebaseAdmin';

// ============================================================================
// INTERFACES
// ============================================================================
interface Inventory {
    autoAddition: number;
    autoDeduction: number;
    blockedStock: number;
    deduction: number;
    inwardAddition: number;
    openingStock: number;
}

interface Product {
    category: string;
    sku: string;
    name: string;
    inventory: Inventory;
    inventoryTracking?: {
        lastRestockDate: Timestamp | null;
        lastRestockQuantity: number;
        lastStockoutDate: Timestamp | null;
        totalStockoutDays: number;
        averageDailySales?: number;
        leadTimeDays?: number;
        minimumOrderQuantity?: number;
        safetyStockLevel?: number;
    };
} // contains more fields, but only these are required

interface SalesMetrics {
    avgDailySales: number;
    last7DaysAvg: number;
    last14DaysAvg: number;
    last30DaysAvg: number;
    standardDeviation: number;
    trendMultiplier: number;
    inStockDays: number;
    stockoutDays: number;
    dataQuality: 'excellent' | 'good' | 'fair' | 'poor' | 'insufficient';
    usedCategoryBenchmark: boolean;
    categoryBlendPercentage?: number; // How much category data was used
}

interface CategoryBenchmark {
    category: string;
    avgDailySales: number;
    standardDeviation: number;
    productCount: number;
    confidence: number;
}

interface RestockRecommendation {
    productId: string;
    suggestedQuantity: number;
    confidence: number;
    reasoning: {
        predictedDailyDemand: number;
        forecastDays: number;
        safetyStock: number;
        currentStock: number;
        adjustments: {
            stockoutAdjustment: number;
            trendAdjustment: number;
        };
    };
    metrics: SalesMetrics;
    warnings?: string[]; // New: Warnings about data quality
}

// ============================================================================
// CATEGORY BENCHMARKING FUNCTIONS
// ============================================================================

/**
 * Calculate average sales metrics for a product category
 * This is used as a benchmark when individual products have insufficient data
 */
export async function calculateCategoryBenchmark(
    businessId: string,
    ordersSnapshot: any[],
    category: string,
    days: number = 30,
    excludeProductIds: string[] = [] // Exclude specific products (e.g., the one we're analyzing)
): Promise<CategoryBenchmark | null> {
    // Get all products in this category
    const productsSnapshot = await db
        .collection(`users/${businessId}/products`)
        .where('category', '==', category)
        .get();

    if (productsSnapshot.empty) {
        console.warn(`No products found in category: ${category}`);
        return null;
    }

    const productIds = productsSnapshot.docs
        .map(doc => doc.id)
        .filter(id => !excludeProductIds.includes(id));

    const productMappedVaraints = productsSnapshot.docs
        .filter(doc => !excludeProductIds.includes(doc.id))
        .map(doc => { return { productId: doc.id, mappedVariants: doc.data()?.mappedVariants || [] } });

    if (productIds.length === 0) {
        return null;
    }

    // Group sales by product
    const productSales: { [productId: string]: number[] } = {};

    ordersSnapshot.forEach(doc => {
        const order = doc.data();
        const items = Array(order.raw.line_items);
        for (const item of items) {
            const index = productMappedVaraints.findIndex(({ productId, mappedVariants }) =>
                mappedVariants.findIndex((mapping: any) => mapping.variantId === item.variant_id) > -1
            )
            if (index < -1) throw new Error('No mapping Found');
            if (!productSales[productMappedVaraints[index].productId]) {
                productSales[productMappedVaraints[index].productId] = [];
            }
            productSales[productMappedVaraints[index].productId].push(item.quantity);
        }
    });

    // Calculate average daily sales per product
    const productAvgs: number[] = [];

    for (const productId of Object.keys(productSales)) {
        const totalSales = productSales[productId].reduce((sum, qty) => sum + qty, 0);
        const avgDailySales = totalSales / days;
        productAvgs.push(avgDailySales);
    }

    if (productAvgs.length === 0) {
        return null;
    }

    // Calculate category-level metrics
    const categoryAvg = productAvgs.reduce((sum, val) => sum + val, 0) / productAvgs.length;
    const categoryStdDev = calculateStandardDeviation(productAvgs, categoryAvg);

    // Confidence based on number of products in sample
    const confidence = Math.min(1, productAvgs.length / 10); // Max confidence at 10+ products

    return {
        category,
        avgDailySales: categoryAvg,
        standardDeviation: categoryStdDev,
        productCount: productAvgs.length,
        confidence,
    };
}

/**
 * Find similar products based on sales patterns
 * Used when category benchmarking isn't available
 */
export async function findSimilarProducts(
    businessId: string,
    targetProductId: string,
    limit: number = 5
): Promise<string[]> {
    const targetProduct = await db.doc(`/users/${businessId}/products/${targetProductId}`).get();

    if (!targetProduct.exists) {
        return [];
    }

    const targetData = targetProduct.data() as Product;
    const category = targetData.category;

    if (!category) {
        // If no category, can't find similar products
        return [];
    }

    // Get products in same category
    const similarProductsSnapshot = await db
        .collection(`/users/${businessId}/products`)
        .where('category', '==', category)
        .limit(limit + 1) // +1 because we'll exclude target product
        .get();

    return similarProductsSnapshot.docs
        .map(doc => doc.id)
        .filter(id => id !== targetProductId)
        .slice(0, limit);
}

// ============================================================================
// CORE CALCULATION FUNCTIONS
// ============================================================================

/**
 * Calculate sales metrics for a product over a given period
 * Adjusts for stockout days where demand was censored
 */
export async function calculateSalesMetrics(
    businessId: string,
    linkedStores: string[],
    productId: string,
    days: number = 30
): Promise<SalesMetrics> {
    const now = new Date();
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    // Get product info
    const productDoc = await db.doc(`users/${businessId}/products/${productId}`).get();
    const product = productDoc.data() as Product;
    const category = product?.category;

    // Fetch orders for this product in the time period
    const DateStringforOrder = startDate.toISOString().slice(0, -1) + "+05:30";
    let combinedOrdersSnapshotArray: any[] = [];
    for (const store of linkedStores) {
        const ordersSnapshot = await db
            .collection(`accounts/${store}/orders`)
            .where('createdAt', '>=', DateStringforOrder)
            .orderBy('createAt', 'asc')
            .get();
        combinedOrdersSnapshotArray = [...combinedOrdersSnapshotArray, ...ordersSnapshot.docs];
    }

    // Get daily stock snapshots (if available)
    const snapshotsSnapshot = await db
        .collection(`users/${businessId}/inventory_snapshots`)
        .where('productId', '==', productId)
        .where('date', '>=', startDate.toISOString().split('T')[0])
        .orderBy('date', 'asc')
        .get();

    const lastSnapshotIndex = snapshotsSnapshot.docs.length - 1;

    // Calculate stockout days
    let stockoutDays = 0;
    const stockoutDates = new Set<string>();

    snapshotsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.isStockout) {
            stockoutDays++;
            stockoutDates.add(data.date);
        }
    });

    const inStockDays = days - stockoutDays;

    // Group orders by day and calculate daily sales
    const dailySales: { [date: string]: number } = {};
    let totalSales = 0;

    combinedOrdersSnapshotArray.forEach(doc => {
        const order = doc.data();
        const index = Array(order.raw.line_items).findIndex(item =>
            !!snapshotsSnapshot.docs[lastSnapshotIndex]
                .data()
                .exactDocState
                .mappedVariants
                .findIndex((el: any) => el.variantId === item.variant_id));

        if (index < 0) throw new Error('No mapping found');
        const dateKey = order.createdAt.split('T')[0];
        const qty = order.line_items[index].quantity;
        dailySales[dateKey] = (dailySales[dateKey] || 0) + qty;
        totalSales += qty;
    });

    // Calculate weighted averages for different periods
    const last7DaysAvg = calculatePeriodAverage(dailySales, 7, stockoutDates);
    const last14DaysAvg = calculatePeriodAverage(dailySales, 14, stockoutDates);
    const last30DaysAvg = calculatePeriodAverage(dailySales, 30, stockoutDates);

    // Adjusted average daily sales (accounting for stockout days)
    let avgDailySales = inStockDays > 0 ? totalSales / inStockDays : 0;

    // Calculate standard deviation
    const salesValues = Object.values(dailySales);
    let standardDeviation = calculateStandardDeviation(salesValues, avgDailySales);

    // ========================================================================
    // CATEGORY BENCHMARKING LOGIC
    // ========================================================================

    let usedCategoryBenchmark = false;
    let categoryBlendPercentage = 0;
    let dataQuality: SalesMetrics['dataQuality'] = 'excellent';

    // Determine if we need category benchmarking
    const needsBenchmarking =
        inStockDays < 7 ||           // Less than 1 week of in-stock data
        stockoutDays > days * 0.5 ||  // Out of stock more than 50% of time
        totalSales === 0 ||           // No sales at all
        (inStockDays < 14 && totalSales < 10); // Limited data and few sales

    if (needsBenchmarking && category) {
        console.log(`Product ${productId} has insufficient data, using category benchmark`);

        const categoryBenchmark = await calculateCategoryBenchmark(
            businessId,
            combinedOrdersSnapshotArray,
            category,
            days,
            [productId] // Exclude this product from category average
        );

        if (categoryBenchmark && categoryBenchmark.productCount >= 2) {
            usedCategoryBenchmark = true;

            // Determine blend ratio based on data quality
            let productWeight: number;

            if (totalSales === 0 || inStockDays === 0) {
                // No product data at all - use 100% category
                productWeight = 0;
                categoryBlendPercentage = 100;
                dataQuality = 'insufficient';
            } else if (inStockDays < 7) {
                // Very limited data - 20% product, 80% category
                productWeight = 0.2;
                categoryBlendPercentage = 80;
                dataQuality = 'poor';
            } else if (stockoutDays > days * 0.5) {
                // Frequent stockouts - 40% product, 60% category
                productWeight = 0.4;
                categoryBlendPercentage = 60;
                dataQuality = 'fair';
            } else {
                // Some data but not great - 70% product, 30% category
                productWeight = 0.7;
                categoryBlendPercentage = 30;
                dataQuality = 'fair';
            }

            // Blend product data with category benchmark
            const categoryWeight = 1 - productWeight;

            avgDailySales = (avgDailySales * productWeight) +
                (categoryBenchmark.avgDailySales * categoryWeight);

            // Also blend standard deviation
            standardDeviation = (standardDeviation * productWeight) +
                (categoryBenchmark.standardDeviation * categoryWeight);

            console.log(`Blended metrics: ${productWeight * 100}% product + ${categoryWeight * 100}% category`);
            console.log(`Product avg: ${totalSales / Math.max(1, inStockDays)}, Category avg: ${categoryBenchmark.avgDailySales}, Blended: ${avgDailySales}`);
        } else {
            // Category benchmark not available or insufficient
            dataQuality = 'poor';
            console.warn(`Category benchmark unavailable for ${category}`);
        }
    } else if (inStockDays >= 21 && stockoutDays <= 3) {
        dataQuality = 'excellent';
    } else if (inStockDays >= 14) {
        dataQuality = 'good';
    } else if (inStockDays >= 7) {
        dataQuality = 'fair';
    } else {
        dataQuality = 'poor';
    }

    // Calculate trend multiplier (is demand increasing or decreasing?)
    const trendMultiplier = calculateTrendMultiplier(last7DaysAvg, last14DaysAvg, last30DaysAvg);

    return {
        avgDailySales,
        last7DaysAvg,
        last14DaysAvg,
        last30DaysAvg,
        standardDeviation,
        trendMultiplier,
        inStockDays,
        stockoutDays,
        dataQuality,
        usedCategoryBenchmark,
        categoryBlendPercentage,
    };
}

/**
 * Calculate average sales for a specific period, excluding stockout days
 */
function calculatePeriodAverage(
    dailySales: { [date: string]: number },
    days: number,
    stockoutDates: Set<string>
): number {
    const now = new Date();
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    let total = 0;
    let validDays = 0;

    for (let i = 0; i < days; i++) {
        const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const dateKey = date.toISOString().split('T')[0];

        if (date >= startDate && !stockoutDates.has(dateKey)) {
            total += dailySales[dateKey] || 0;
            validDays++;
        }
    }

    return validDays > 0 ? total / validDays : 0;
}

/**
 * Calculate standard deviation of sales
 */
function calculateStandardDeviation(values: number[], mean: number): number {
    if (values.length === 0) return 0;

    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    const variance = squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length;
    return Math.sqrt(variance);
}

/**
 * Calculate trend multiplier based on recent vs older sales
 * > 1.0 = increasing demand
 * < 1.0 = decreasing demand
 */
function calculateTrendMultiplier(
    last7DaysAvg: number,
    last14DaysAvg: number,
    last30DaysAvg: number
): number {
    // Weight recent trends more heavily
    if (last30DaysAvg === 0) return 1.0;

    const recentTrend = last7DaysAvg / last14DaysAvg;
    const longerTrend = last14DaysAvg / last30DaysAvg;

    // Weighted average: 70% recent, 30% longer term
    const trendMultiplier = (recentTrend * 0.7) + (longerTrend * 0.3);

    // Cap extreme values
    return Math.max(0.5, Math.min(2.0, trendMultiplier));
}

/**
 * Calculate safety stock based on demand variability and lead time
 */
function calculateSafetyStock(
    standardDeviation: number,
    leadTimeDays: number,
    serviceLevel: number = 0.95 // 95% service level = Z-score of 1.65
): number {
    // Z-scores for different service levels:
    // 90% = 1.28, 95% = 1.65, 99% = 2.33
    const zScore = serviceLevel === 0.95 ? 1.65 :
        serviceLevel === 0.99 ? 2.33 : 1.28;

    return Math.ceil(zScore * standardDeviation * Math.sqrt(leadTimeDays));
}

function calculatePhysicalStock(inv: Inventory): number {
    return (
        inv.openingStock + inv.inwardAddition - inv.deduction + inv.autoAddition - inv.autoDeduction
    );
}

/**
 * Main function: Calculate restock recommendation for a product
 */
export async function calculateRestockRecommendation(
    businessId: string,
    productId: string,
    forecastDays: number = 14, // How many days ahead to stock for
    options: {
        serviceLevel?: number;
        forceMinimumOrder?: boolean;
    } = {}
): Promise<RestockRecommendation> {
    const businessDoc = await db.doc(`users/${businessId}`).get();
    if (!businessDoc.exists) {
        throw new Error(`Business ${businessId} not found`);
    }

    const productDoc = await db.doc(`users/${businessId}/products/${productId}`).get();
    if (!productDoc.exists) {
        throw new Error(`Product ${productId} not found`);
    }

    const product = productDoc.data() as Product;
    const currentStock = calculatePhysicalStock(product.inventory) || 0;
    const leadTimeDays = product.inventoryTracking?.leadTimeDays || 7;
    const minimumOrderQuantity = product.inventoryTracking?.minimumOrderQuantity || 0;
    const linkedStores = (businessDoc.data()?.stores as string[]) || []

    // Calculate sales metrics (with category benchmarking if needed)
    const metrics = await calculateSalesMetrics(businessId, linkedStores, productId, 30);

    // Generate warnings based on data quality
    const warnings: string[] = [];

    if (metrics.dataQuality === 'insufficient') {
        warnings.push('No sales history available. Prediction based entirely on category average.');
    } else if (metrics.dataQuality === 'poor') {
        warnings.push('Limited sales history. Prediction has low confidence.');
    } else if (metrics.dataQuality === 'fair' && metrics.usedCategoryBenchmark) {
        warnings.push(`Prediction blended with ${metrics.categoryBlendPercentage}% category data due to stockouts.`);
    }

    if (metrics.stockoutDays > 10) {
        warnings.push(`Product was out of stock for ${metrics.stockoutDays} days in the last month.`);
    }

    if (!product.category && metrics.dataQuality !== 'excellent') {
        warnings.push('Product has no category assigned. Consider categorizing for better predictions.');
    }

    // Calculate stockout adjustment factor
    let stockoutAdjustment = 1.0;

    if (metrics.stockoutDays > 10) {
        stockoutAdjustment = 1.4; // +40% for severe stockouts
    } else if (metrics.stockoutDays > 5) {
        stockoutAdjustment = 1.25; // +25% for frequent stockouts
    } else if (metrics.stockoutDays > 2) {
        stockoutAdjustment = 1.15; // +15% for occasional stockouts
    }

    // If we used category benchmarking heavily, reduce stockout adjustment
    // (it's already accounted for in the blended average)
    if (metrics.usedCategoryBenchmark && metrics.categoryBlendPercentage && metrics.categoryBlendPercentage > 50) {
        stockoutAdjustment = Math.min(stockoutAdjustment, 1.15);
    }

    // Calculate predicted daily demand
    // Weighted average: 50% last 7 days, 30% last 14, 20% last 30
    const weightedDailySales =
        (metrics.last7DaysAvg * 0.5) +
        (metrics.last14DaysAvg * 0.3) +
        (metrics.last30DaysAvg * 0.2);

    const predictedDailyDemand =
        weightedDailySales *
        metrics.trendMultiplier *
        stockoutAdjustment;

    // Calculate safety stock
    const safetyStock = calculateSafetyStock(
        metrics.standardDeviation,
        leadTimeDays,
        options.serviceLevel || 0.95
    );

    // Calculate total restock quantity
    let suggestedQuantity = Math.ceil(
        (predictedDailyDemand * forecastDays) + // Forecast demand
        safetyStock -                            // Safety buffer
        currentStock                             // Current stock
    );

    // Ensure non-negative
    suggestedQuantity = Math.max(0, suggestedQuantity);

    // Apply minimum order quantity if specified
    if (options.forceMinimumOrder && minimumOrderQuantity > 0) {
        suggestedQuantity = Math.max(suggestedQuantity, minimumOrderQuantity);
    }

    // Calculate confidence score
    const dataQualityScore = {
        'excellent': 1.0,
        'good': 0.85,
        'fair': 0.70,
        'poor': 0.50,
        'insufficient': 0.30,
    }[metrics.dataQuality];
    const volatilityPenalty = metrics.standardDeviation / (metrics.avgDailySales || 1);
    const categoryBonus = metrics.usedCategoryBenchmark ? 0.1 : 0; // Slight bonus if category data helped
    const confidence = Math.max(0, Math.min(1,
        dataQualityScore * (1 - Math.min(0.5, volatilityPenalty * 0.1)) + categoryBonus
    ));

    return {
        productId,
        suggestedQuantity,
        confidence,
        reasoning: {
            predictedDailyDemand,
            forecastDays,
            safetyStock,
            currentStock,
            adjustments: {
                stockoutAdjustment,
                trendAdjustment: metrics.trendMultiplier,
            },
        },
        metrics,
        warnings: warnings.length > 0 ? warnings : undefined,
    };
}

/**
 * Batch calculate restock recommendations for all products
 */
export async function calculateAllRestockRecommendations(
    businessId: string,
    options: {
        minStockThreshold?: number; // Only products below this threshold
        forecastDays?: number;
    } = {}
): Promise<RestockRecommendation[]> {
    const productsSnapshot = await db.collection(`users/${businessId}/products`).get()
    const recommendations: RestockRecommendation[] = [];

    for (const doc of productsSnapshot.docs) {
        const product = doc.data() as Product;

        // Skip if stock is above threshold
        if (options.minStockThreshold && calculatePhysicalStock(product.inventory) > options.minStockThreshold) {
            continue;
        }

        try {
            const recommendation = await calculateRestockRecommendation(
                businessId,
                doc.id,
                options.forecastDays
            );

            // Only include if suggested quantity > 0
            if (recommendation.suggestedQuantity > 0) {
                recommendations.push(recommendation);
            }
        } catch (error) {
            console.error(`Error calculating restock for product ${doc.id}:`, error);
        }
    }

    // Sort by urgency (products with less current stock relative to demand)
    recommendations.sort((a, b) => {
        const urgencyA = a.reasoning.predictedDailyDemand / (a.reasoning.currentStock || 1);
        const urgencyB = b.reasoning.predictedDailyDemand / (b.reasoning.currentStock || 1);
        return urgencyB - urgencyA;
    });

    return recommendations;
}

// ============================================================================
// HELPER FUNCTIONS FOR TRACKING
// ============================================================================

/**
 * Update product's inventory tracking metadata
 */
export async function updateProductTrackingMetadata(
    businessId: string,
    productId: string
): Promise<void> {
    const businessDoc = await db.doc(`users/${businessId}`).get();
    if (!businessDoc.exists) {
        throw new Error(`Business ${businessId} not found`);
    }

    const productDoc = await db.doc(`users/${businessId}/products/${productId}`).get();
    if (!productDoc.exists) {
        throw new Error(`Product ${productId} not found`);
    }

    const linkedStores = (businessDoc.data()?.stores as string[]) || []
    const metrics = await calculateSalesMetrics(businessId, linkedStores, productId, 30);

    await db.collection('products').doc(productId).update({
        'inventoryTracking.averageDailySales': metrics.avgDailySales,
        'inventoryTracking.totalStockoutDays': metrics.stockoutDays,
    });
}