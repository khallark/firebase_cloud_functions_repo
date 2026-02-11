// restock-logic.ts
// ROBUST VERSION - TypeScript functions for inventory restock prediction with Firestore
// Enhanced with comprehensive error handling, validation, and logging

import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firebaseAdmin";

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
  mappedVariants?: Array<{ variantId: string; [key: string]: any }>;
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
}

interface SalesMetrics {
  avgDailySales: number;
  last7DaysAvg: number;
  last14DaysAvg: number;
  last30DaysAvg: number;
  standardDeviation: number;
  trendMultiplier: number;
  inStockDays: number;
  stockoutDays: number;
  dataQuality: "excellent" | "good" | "fair" | "poor" | "insufficient";
  usedCategoryBenchmark: boolean;
  categoryBlendPercentage?: number;
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
  warnings?: string[];
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Safe nested property access
 */
// function safeGet<T>(obj: any, path: string, defaultValue: T): T {
//   try {
//     const keys = path.split(".");
//     let result = obj;
//     for (const key of keys) {
//       if (result === null || result === undefined) {
//         return defaultValue;
//       }
//       result = result[key];
//     }
//     return result ?? defaultValue;
//   } catch (error) {
//     console.warn(`SafeGet failed for path: ${path}`, error);
//     return defaultValue;
//   }
// }

/**
 * Validate and parse inventory object
 */
function validateInventory(inventory: any): Inventory {
  if (!inventory || typeof inventory !== "object") {
    console.warn("Invalid inventory object, using defaults");
    return {
      autoAddition: 0,
      autoDeduction: 0,
      blockedStock: 0,
      deduction: 0,
      inwardAddition: 0,
      openingStock: 0,
    };
  }

  return {
    autoAddition: Number(inventory.autoAddition) || 0,
    autoDeduction: Number(inventory.autoDeduction) || 0,
    blockedStock: Number(inventory.blockedStock) || 0,
    deduction: Number(inventory.deduction) || 0,
    inwardAddition: Number(inventory.inwardAddition) || 0,
    openingStock: Number(inventory.openingStock) || 0,
  };
}

/**
 * Calculate physical stock with validation
 */
function calculatePhysicalStock(inv: any): number {
  try {
    const validated = validateInventory(inv);
    const stock =
      validated.openingStock +
      validated.inwardAddition -
      validated.deduction +
      validated.autoAddition -
      validated.autoDeduction;
    return Math.max(0, stock); // Ensure non-negative
  } catch (error) {
    console.error("Error calculating physical stock:", error);
    return 0;
  }
}

/**
 * Find product by variant ID in mapped variants
 */
function findProductByVariant(
  productMappedVariants: Array<{ productId: string; mappedVariants: any[] }>,
  variantId: string,
): string | null {
  try {
    if (!variantId || !productMappedVariants || productMappedVariants.length === 0) {
      return null;
    }

    for (const product of productMappedVariants) {
      if (!product.mappedVariants || !Array.isArray(product.mappedVariants)) {
        continue;
      }

      const variantExists = product.mappedVariants.some(
        (mapping: any) => mapping?.variantId === variantId,
      );

      if (variantExists) {
        return product.productId;
      }
    }

    return null;
  } catch (error) {
    console.error(`Error finding product for variant ${variantId}:`, error);
    return null;
  }
}

/**
 * Extract line items safely from order
 */
function extractLineItems(order: any): any[] {
  try {
    // Try multiple possible locations for line items
    const items = order?.raw?.line_items || order?.line_items || order?.items || [];

    if (!Array.isArray(items)) {
      console.warn("Line items is not an array:", typeof items);
      return [];
    }

    return items;
  } catch (error) {
    console.error("Error extracting line items:", error);
    return [];
  }
}

/**
 * Format date for Firestore query (ISO with timezone)
 */
function formatDateForQuery(date: Date): string {
  try {
    // Format: YYYY-MM-DDTHH:mm:ss.sss+05:30
    const isoString = date.toISOString();
    return isoString.slice(0, -1) + "+05:30";
  } catch (error) {
    console.error("Error formatting date:", error);
    return new Date().toISOString();
  }
}

// ============================================================================
// CATEGORY BENCHMARKING FUNCTIONS
// ============================================================================

/**
 * Calculate average sales metrics for a product category
 * ROBUST VERSION with comprehensive error handling
 */
export async function calculateCategoryBenchmark(
  businessId: string,
  ordersSnapshot: any[],
  category: string,
  days: number = 30,
  excludeProductIds: string[] = [],
): Promise<CategoryBenchmark | null> {
  try {
    // Validate inputs
    if (!businessId || typeof businessId !== "string") {
      throw new Error("Invalid businessId");
    }
    if (!category || typeof category !== "string") {
      throw new Error("Invalid category");
    }
    if (!Array.isArray(ordersSnapshot)) {
      console.warn("ordersSnapshot is not an array, returning null");
      return null;
    }

    // Get all products in this category
    const productsSnapshot = await db
      .collection(`users/${businessId}/products`)
      .where("category", "==", category)
      .get();

    if (productsSnapshot.empty) {
      console.warn(`No products found in category: ${category}`);
      return null;
    }

    // Extract product IDs and mapped variants
    const productIds: string[] = [];
    const productMappedVariants: Array<{ productId: string; mappedVariants: any[] }> = [];

    productsSnapshot.docs.forEach((doc) => {
      const docId = doc.id;
      if (!excludeProductIds.includes(docId)) {
        productIds.push(docId);
        const data = doc.data();
        productMappedVariants.push({
          productId: docId,
          mappedVariants: Array.isArray(data?.mappedVariants) ? data.mappedVariants : [],
        });
      }
    });

    if (productIds.length === 0) {
      console.warn(`No products remaining after exclusions in category: ${category}`);
      return null;
    }

    // Group sales by product
    const productSales: { [productId: string]: number[] } = {};

    // Process each order
    for (const docSnapshot of ordersSnapshot) {
      try {
        const order = docSnapshot.data();
        if (!order) continue;

        const lineItems = extractLineItems(order);

        for (const item of lineItems) {
          if (!item || !item.variant_id) {
            continue; // Skip invalid items
          }

          const quantity = Number(item.quantity);
          if (isNaN(quantity) || quantity <= 0) {
            continue; // Skip invalid quantities
          }

          // Find which product this variant belongs to
          const productId = findProductByVariant(productMappedVariants, item.variant_id);

          if (productId) {
            if (!productSales[productId]) {
              productSales[productId] = [];
            }
            productSales[productId].push(quantity);
          }
        }
      } catch (orderError) {
        console.error("Error processing order in category benchmark:", orderError);
        // Continue with next order
      }
    }

    // Calculate average daily sales per product
    const productAvgs: number[] = [];

    for (const productId of Object.keys(productSales)) {
      try {
        const totalSales = productSales[productId].reduce((sum, qty) => sum + qty, 0);
        const avgDailySales = totalSales / days;

        if (!isNaN(avgDailySales) && avgDailySales >= 0) {
          productAvgs.push(avgDailySales);
        }
      } catch (error) {
        console.error(`Error calculating average for product ${productId}:`, error);
      }
    }

    if (productAvgs.length === 0) {
      console.warn(`No valid sales data for category: ${category}`);
      return null;
    }

    // Calculate category-level metrics
    const categoryAvg = productAvgs.reduce((sum, val) => sum + val, 0) / productAvgs.length;
    const categoryStdDev = calculateStandardDeviation(productAvgs, categoryAvg);

    // Confidence based on number of products in sample
    const confidence = Math.min(1, productAvgs.length / 10);

    return {
      category,
      avgDailySales: categoryAvg,
      standardDeviation: categoryStdDev,
      productCount: productAvgs.length,
      confidence,
    };
  } catch (error) {
    console.error(`Error in calculateCategoryBenchmark for category ${category}:`, error);
    return null;
  }
}

/**
 * Find similar products based on category
 * ROBUST VERSION with error handling
 */
export async function findSimilarProducts(
  businessId: string,
  targetProductId: string,
  limit: number = 5,
): Promise<string[]> {
  try {
    // Validate inputs
    if (!businessId || !targetProductId) {
      return [];
    }

    const targetProduct = await db.doc(`users/${businessId}/products/${targetProductId}`).get();

    if (!targetProduct.exists) {
      console.warn(`Product ${targetProductId} not found`);
      return [];
    }

    const targetData = targetProduct.data() as Product;
    const category = targetData?.category;

    if (!category) {
      console.warn(`Product ${targetProductId} has no category`);
      return [];
    }

    // Get products in same category
    const similarProductsSnapshot = await db
      .collection(`users/${businessId}/products`)
      .where("category", "==", category)
      .limit(Math.max(1, limit + 1))
      .get();

    return similarProductsSnapshot.docs
      .map((doc) => doc.id)
      .filter((id) => id !== targetProductId)
      .slice(0, limit);
  } catch (error) {
    console.error(`Error finding similar products for ${targetProductId}:`, error);
    return [];
  }
}

// ============================================================================
// CORE CALCULATION FUNCTIONS
// ============================================================================

/**
 * Calculate sales metrics for a product over a given period
 * ROBUST VERSION with comprehensive error handling
 */
export async function calculateSalesMetrics(
  businessId: string,
  linkedStores: string[],
  productId: string,
  days: number = 30,
): Promise<SalesMetrics> {
  try {
    // Validate inputs
    if (!businessId || !productId) {
      throw new Error("Invalid businessId or productId");
    }

    if (!Array.isArray(linkedStores)) {
      console.warn("linkedStores is not an array, using empty array");
      linkedStores = [];
    }

    const now = new Date();
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    // Get product info
    const productDoc = await db.doc(`users/${businessId}/products/${productId}`).get();

    if (!productDoc.exists) {
      throw new Error(`Product ${productId} not found`);
    }

    const product = productDoc.data() as Product;
    const category = product?.category;
    const mappedVariants = Array.isArray(product?.mappedVariants) ? product.mappedVariants : [];

    // Fetch orders from all linked stores
    const dateStringForOrder = formatDateForQuery(startDate);
    let combinedOrdersSnapshotArray: any[] = [];

    for (const store of linkedStores) {
      try {
        if (!store) continue;

        const ordersSnapshot = await db
          .collection(`accounts/${store}/orders`)
          .where("createdAt", ">=", dateStringForOrder)
          .orderBy("createdAt", "asc")
          .get();

        if (!ordersSnapshot.empty) {
          combinedOrdersSnapshotArray = [...combinedOrdersSnapshotArray, ...ordersSnapshot.docs];
        }
      } catch (storeError) {
        console.error(`Error fetching orders from store ${store}:`, storeError);
        // Continue with other stores
      }
    }

    // Get daily stock snapshots
    let snapshotsSnapshot;
    try {
      snapshotsSnapshot = await db
        .collection(`users/${businessId}/inventory_snapshots`)
        .where("productId", "==", productId)
        .where("date", ">=", startDate.toISOString().split("T")[0])
        .orderBy("date", "asc")
        .get();
    } catch (snapshotError) {
      console.warn("Error fetching inventory snapshots:", snapshotError);
      snapshotsSnapshot = { empty: true, docs: [] };
    }

    // Calculate stockout days
    let stockoutDays = 0;
    const stockoutDates = new Set<string>();

    if (!snapshotsSnapshot.empty) {
      snapshotsSnapshot.docs.forEach((doc) => {
        try {
          const data = doc.data();
          if (data?.isStockout === true) {
            stockoutDays++;
            if (data.date) {
              stockoutDates.add(data.date);
            }
          }
        } catch (error) {
          console.error("Error processing snapshot:", error);
        }
      });
    }

    const inStockDays = Math.max(0, days - stockoutDays);

    // Group orders by day and calculate daily sales
    const dailySales: { [date: string]: number } = {};
    let totalSales = 0;

    for (const docSnapshot of combinedOrdersSnapshotArray) {
      try {
        const order = docSnapshot.data();
        if (!order) continue;

        const lineItems = extractLineItems(order);

        for (const item of lineItems) {
          if (!item || !item.variant_id) continue;

          // Check if this variant belongs to our product
          const variantBelongsToProduct = mappedVariants.some(
            (mapping: any) => mapping?.variantId === item.variant_id,
          );

          if (!variantBelongsToProduct) continue;

          const quantity = Number(item.quantity);
          if (isNaN(quantity) || quantity <= 0) continue;

          // Extract date key
          let dateKey: string;
          if (order.createdAt) {
            dateKey = String(order.createdAt).split("T")[0];
          } else {
            console.warn("Order missing createdAt, skipping");
            continue;
          }

          dailySales[dateKey] = (dailySales[dateKey] || 0) + quantity;
          totalSales += quantity;
        }
      } catch (orderError) {
        console.error("Error processing order:", orderError);
        // Continue with next order
      }
    }

    // Calculate period averages
    const last7DaysAvg = calculatePeriodAverage(dailySales, 7, stockoutDates);
    const last14DaysAvg = calculatePeriodAverage(dailySales, 14, stockoutDates);
    const last30DaysAvg = calculatePeriodAverage(dailySales, 30, stockoutDates);

    // Base average daily sales
    let avgDailySales = inStockDays > 0 ? totalSales / inStockDays : 0;

    // Calculate standard deviation
    const salesValues = Object.values(dailySales);
    let standardDeviation = calculateStandardDeviation(salesValues, avgDailySales);

    // ====================================================================
    // CATEGORY BENCHMARKING LOGIC
    // ====================================================================

    let usedCategoryBenchmark = false;
    let categoryBlendPercentage = 0;
    let dataQuality: SalesMetrics["dataQuality"] = "excellent";

    // Determine if we need category benchmarking
    const needsBenchmarking =
      inStockDays < 7 ||
      stockoutDays > days * 0.5 ||
      totalSales === 0 ||
      (inStockDays < 14 && totalSales < 10);

    if (needsBenchmarking && category) {
      console.log(
        `Product ${productId} needs benchmarking: inStock=${inStockDays}, stockout=${stockoutDays}, sales=${totalSales}`,
      );

      try {
        const categoryBenchmark = await calculateCategoryBenchmark(
          businessId,
          combinedOrdersSnapshotArray,
          category,
          days,
          [productId],
        );

        if (categoryBenchmark && categoryBenchmark.productCount >= 2) {
          usedCategoryBenchmark = true;

          // Determine blend ratio
          let productWeight: number;

          if (totalSales === 0 || inStockDays === 0) {
            productWeight = 0;
            categoryBlendPercentage = 100;
            dataQuality = "insufficient";
          } else if (inStockDays < 7) {
            productWeight = 0.2;
            categoryBlendPercentage = 80;
            dataQuality = "poor";
          } else if (stockoutDays > days * 0.5) {
            productWeight = 0.4;
            categoryBlendPercentage = 60;
            dataQuality = "fair";
          } else {
            productWeight = 0.7;
            categoryBlendPercentage = 30;
            dataQuality = "fair";
          }

          const categoryWeight = 1 - productWeight;

          avgDailySales =
            avgDailySales * productWeight + categoryBenchmark.avgDailySales * categoryWeight;

          standardDeviation =
            standardDeviation * productWeight +
            categoryBenchmark.standardDeviation * categoryWeight;

          console.log(
            `Blended: ${productWeight * 100}% product + ${categoryWeight * 100}% category`,
          );
        } else {
          dataQuality = "poor";
          console.warn(`Category benchmark unavailable for ${category}`);
        }
      } catch (benchmarkError) {
        console.error("Error calculating category benchmark:", benchmarkError);
        dataQuality = "poor";
      }
    } else if (inStockDays >= 21 && stockoutDays <= 3) {
      dataQuality = "excellent";
    } else if (inStockDays >= 14) {
      dataQuality = "good";
    } else if (inStockDays >= 7) {
      dataQuality = "fair";
    } else {
      dataQuality = "poor";
    }

    // Calculate trend multiplier
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
  } catch (error) {
    console.error(`Critical error in calculateSalesMetrics for product ${productId}:`, error);

    // Return safe defaults
    return {
      avgDailySales: 0,
      last7DaysAvg: 0,
      last14DaysAvg: 0,
      last30DaysAvg: 0,
      standardDeviation: 0,
      trendMultiplier: 1.0,
      inStockDays: 0,
      stockoutDays: days,
      dataQuality: "insufficient",
      usedCategoryBenchmark: false,
    };
  }
}

/**
 * Calculate average sales for a specific period, excluding stockout days
 */
function calculatePeriodAverage(
  dailySales: { [date: string]: number },
  days: number,
  stockoutDates: Set<string>,
): number {
  try {
    const now = new Date();
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    let total = 0;
    let validDays = 0;

    for (let i = 0; i < days; i++) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateKey = date.toISOString().split("T")[0];

      if (date >= startDate && !stockoutDates.has(dateKey)) {
        total += dailySales[dateKey] || 0;
        validDays++;
      }
    }

    return validDays > 0 ? total / validDays : 0;
  } catch (error) {
    console.error("Error in calculatePeriodAverage:", error);
    return 0;
  }
}

/**
 * Calculate standard deviation of sales
 */
function calculateStandardDeviation(values: number[], mean: number): number {
  try {
    if (!Array.isArray(values) || values.length === 0) return 0;

    const validValues = values.filter((v) => typeof v === "number" && !isNaN(v));
    if (validValues.length === 0) return 0;

    const squaredDiffs = validValues.map((val) => Math.pow(val - mean, 2));
    const variance = squaredDiffs.reduce((sum, val) => sum + val, 0) / validValues.length;

    return Math.sqrt(variance);
  } catch (error) {
    console.error("Error calculating standard deviation:", error);
    return 0;
  }
}

/**
 * Calculate trend multiplier based on recent vs older sales
 */
function calculateTrendMultiplier(
  last7DaysAvg: number,
  last14DaysAvg: number,
  last30DaysAvg: number,
): number {
  try {
    if (last30DaysAvg === 0) return 1.0;

    const recentTrend = last14DaysAvg > 0 ? last7DaysAvg / last14DaysAvg : 1.0;
    const longerTrend = last30DaysAvg > 0 ? last14DaysAvg / last30DaysAvg : 1.0;

    const trendMultiplier = recentTrend * 0.7 + longerTrend * 0.3;

    // Cap extreme values
    return Math.max(0.5, Math.min(2.0, trendMultiplier));
  } catch (error) {
    console.error("Error calculating trend multiplier:", error);
    return 1.0;
  }
}

/**
 * Calculate safety stock based on demand variability and lead time
 */
function calculateSafetyStock(
  standardDeviation: number,
  leadTimeDays: number,
  serviceLevel: number = 0.95,
): number {
  try {
    const zScore = serviceLevel === 0.95 ? 1.65 : serviceLevel === 0.99 ? 2.33 : 1.28;

    const safetyStock = zScore * standardDeviation * Math.sqrt(Math.max(1, leadTimeDays));

    return Math.ceil(Math.max(0, safetyStock));
  } catch (error) {
    console.error("Error calculating safety stock:", error);
    return 0;
  }
}

// ============================================================================
// MAIN RESTOCK RECOMMENDATION
// ============================================================================

/**
 * Calculate restock recommendation for a product
 * ROBUST VERSION with comprehensive error handling
 */
export async function calculateRestockRecommendation(
  businessId: string,
  productId: string,
  forecastDays: number = 14,
  options: {
    serviceLevel?: number;
    forceMinimumOrder?: boolean;
  } = {},
): Promise<RestockRecommendation> {
  try {
    // Validate inputs
    if (!businessId || typeof businessId !== "string") {
      throw new Error("Invalid businessId");
    }
    if (!productId || typeof productId !== "string") {
      throw new Error("Invalid productId");
    }

    forecastDays = Math.max(1, Math.min(90, forecastDays || 14));

    // Get business document
    const businessDoc = await db.doc(`users/${businessId}`).get();
    if (!businessDoc.exists) {
      throw new Error(`Business ${businessId} not found`);
    }

    // Get product document
    const productDoc = await db.doc(`users/${businessId}/products/${productId}`).get();
    if (!productDoc.exists) {
      throw new Error(`Product ${productId} not found`);
    }

    const product = productDoc.data() as Product;
    const currentStock = calculatePhysicalStock(product?.inventory);
    const leadTimeDays = Math.max(1, product?.inventoryTracking?.leadTimeDays || 7);
    const minimumOrderQuantity = Math.max(0, product?.inventoryTracking?.minimumOrderQuantity || 0);
    const linkedStores = Array.isArray(businessDoc.data()?.stores)
      ? (businessDoc.data()!.stores as string[])
      : [];

    // Calculate sales metrics
    const metrics = await calculateSalesMetrics(businessId, linkedStores, productId, 30);

    // Generate warnings
    const warnings: string[] = [];

    if (metrics.dataQuality === "insufficient") {
      warnings.push("No sales history available. Prediction based entirely on category average.");
    } else if (metrics.dataQuality === "poor") {
      warnings.push("Limited sales history. Prediction has low confidence.");
    } else if (metrics.dataQuality === "fair" && metrics.usedCategoryBenchmark) {
      warnings.push(
        `Prediction blended with ${metrics.categoryBlendPercentage}% category data due to stockouts.`,
      );
    }

    if (metrics.stockoutDays > 10) {
      warnings.push(`Product was out of stock for ${metrics.stockoutDays} days in the last month.`);
    }

    if (!product.category && metrics.dataQuality !== "excellent") {
      warnings.push(
        "Product has no category assigned. Consider categorizing for better predictions.",
      );
    }

    if (linkedStores.length === 0) {
      warnings.push("No linked stores found. Sales data may be incomplete.");
    }

    // Calculate stockout adjustment
    let stockoutAdjustment = 1.0;

    if (metrics.stockoutDays > 10) {
      stockoutAdjustment = 1.4;
    } else if (metrics.stockoutDays > 5) {
      stockoutAdjustment = 1.25;
    } else if (metrics.stockoutDays > 2) {
      stockoutAdjustment = 1.15;
    }

    if (
      metrics.usedCategoryBenchmark &&
      metrics.categoryBlendPercentage &&
      metrics.categoryBlendPercentage > 50
    ) {
      stockoutAdjustment = Math.min(stockoutAdjustment, 1.15);
    }

    // Calculate predicted demand
    const weightedDailySales =
      metrics.last7DaysAvg * 0.5 + metrics.last14DaysAvg * 0.3 + metrics.last30DaysAvg * 0.2;

    const predictedDailyDemand = weightedDailySales * metrics.trendMultiplier * stockoutAdjustment;

    // Calculate safety stock
    const safetyStock = calculateSafetyStock(
      metrics.standardDeviation,
      leadTimeDays,
      options.serviceLevel || 0.95,
    );

    // Calculate restock quantity
    let suggestedQuantity = Math.ceil(
      predictedDailyDemand * forecastDays + safetyStock - currentStock,
    );

    suggestedQuantity = Math.max(0, suggestedQuantity);

    // Apply minimum order quantity
    if (options.forceMinimumOrder && minimumOrderQuantity > 0) {
      suggestedQuantity = Math.max(suggestedQuantity, minimumOrderQuantity);
    }

    // Calculate confidence
    const dataQualityScore = {
      excellent: 1.0,
      good: 0.85,
      fair: 0.7,
      poor: 0.5,
      insufficient: 0.3,
    }[metrics.dataQuality];

    const volatilityPenalty = metrics.standardDeviation / (metrics.avgDailySales || 1);
    const categoryBonus = metrics.usedCategoryBenchmark ? 0.1 : 0;

    const confidence = Math.max(
      0,
      Math.min(1, dataQualityScore * (1 - Math.min(0.5, volatilityPenalty * 0.1)) + categoryBonus),
    );

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
  } catch (error) {
    console.error(`Error in calculateRestockRecommendation for product ${productId}:`, error);
    throw error; // Re-throw to let caller handle
  }
}

/**
 * Batch calculate restock recommendations for all products
 * ROBUST VERSION with error handling
 */
export async function calculateAllRestockRecommendations(
  businessId: string,
  options: {
    minStockThreshold?: number;
    forecastDays?: number;
  } = {},
): Promise<RestockRecommendation[]> {
  try {
    if (!businessId) {
      throw new Error("Invalid businessId");
    }

    const productsSnapshot = await db.collection(`users/${businessId}/products`).get();
    const recommendations: RestockRecommendation[] = [];
    const errors: Array<{ productId: string; error: any }> = [];

    for (const doc of productsSnapshot.docs) {
      try {
        const product = doc.data() as Product;
        const currentStock = calculatePhysicalStock(product?.inventory);

        if (options.minStockThreshold && currentStock > options.minStockThreshold) {
          continue;
        }

        const recommendation = await calculateRestockRecommendation(
          businessId,
          doc.id,
          options.forecastDays,
        );

        if (recommendation.suggestedQuantity > 0) {
          recommendations.push(recommendation);
        }
      } catch (error) {
        console.error(`Error calculating restock for product ${doc.id}:`, error);
        errors.push({ productId: doc.id, error });
      }
    }

    if (errors.length > 0) {
      console.warn(
        `Failed to calculate ${errors.length} products:`,
        errors.map((e) => e.productId),
      );
    }

    // Sort by urgency
    recommendations.sort((a, b) => {
      const urgencyA = a.reasoning.predictedDailyDemand / Math.max(1, a.reasoning.currentStock);
      const urgencyB = b.reasoning.predictedDailyDemand / Math.max(1, b.reasoning.currentStock);
      return urgencyB - urgencyA;
    });

    return recommendations;
  } catch (error) {
    console.error("Error in calculateAllRestockRecommendations:", error);
    throw error;
  }
}

/**
 * Update product's inventory tracking metadata
 * ROBUST VERSION with error handling
 */
export async function updateProductTrackingMetadata(
  businessId: string,
  productId: string,
): Promise<void> {
  try {
    if (!businessId || !productId) {
      throw new Error("Invalid businessId or productId");
    }

    const businessDoc = await db.doc(`users/${businessId}`).get();
    if (!businessDoc.exists) {
      throw new Error(`Business ${businessId} not found`);
    }

    const productDoc = await db.doc(`users/${businessId}/products/${productId}`).get();
    if (!productDoc.exists) {
      throw new Error(`Product ${productId} not found`);
    }

    const linkedStores = Array.isArray(businessDoc.data()?.stores)
      ? (businessDoc.data()!.stores as string[])
      : [];

    const metrics = await calculateSalesMetrics(businessId, linkedStores, productId, 30);

    await db.doc(`users/${businessId}/products/${productId}`).update({
      "inventoryTracking.averageDailySales": metrics.avgDailySales,
      "inventoryTracking.totalStockoutDays": metrics.stockoutDays,
    });

    console.log(`Updated tracking metadata for product ${productId}`);
  } catch (error) {
    console.error(`Error updating tracking metadata for product ${productId}:`, error);
    throw error;
  }
}
