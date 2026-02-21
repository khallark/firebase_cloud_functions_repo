// restock-logic.ts
// ROBUST VERSION v4 - Additional fixes:
//
// FIX 1:  Removed .orderBy() from snapshot query (silent failure from missing composite index)
// FIX 2:  inStockDays uses ACTUAL snapshot count (days - stockoutDays was wrong)
// FIX 3:  Added snapshot coverage tracking (daysWithSnapshots, daysWithoutData, snapshotCoverage)
// FIX 4:  needsBenchmarking triggers on low snapshot coverage too
// FIX 5:  calculateCategoryBenchmark checks each peer's reliability before including it
// FIX 6:  Cascading failure handled: falls back to pre-stockout → full window → conservative
// FIX 7:  dataQuality considers snapshot coverage, not just inStockDays
// FIX 8:  dataSource field added for transparency on where avgDailySales came from
// FIX 9:  Warnings surface cascading failures, low coverage, fallback usage
// FIX 10: Stockout logic: stockLevel===0 && dailySales===0 (sold-out mid-day ≠ full stockout)
// FIX 11: Warning reason reflects actual cause (stockouts vs low coverage)
// FIX 12: avgDailySales = totalSales / days (full window, consistent numerator + denominator)
// FIX 13: businessDoc fetched once in batch, passed down via linkedStores param
// FIX 14: productDoc fetched once in batch, passed down via productData param
// FIX 15: Peer reliability checks run in parallel (Promise.all)
// FIX 16: dataSource name corrected: "product_full_window" (was misleading "product_instock_history")

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
  daysWithSnapshots: number;
  daysWithoutData: number;
  snapshotCoverage: number;
  dataQuality: "excellent" | "good" | "fair" | "poor" | "insufficient";
  usedCategoryBenchmark: boolean;
  categoryBlendPercentage?: number;
  dataSource: string;
}

interface CategoryBenchmark {
  category: string;
  avgDailySales: number;
  standardDeviation: number;
  productCount: number;
  confidence: number;
  benchmarkQuality: "reliable" | "weak" | "failed";
  excludedCount: number;
  reason?: string;
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

function calculatePhysicalStock(inv: any): number {
  try {
    const validated = validateInventory(inv);
    const stock =
      validated.openingStock +
      validated.inwardAddition -
      validated.deduction +
      validated.autoAddition -
      validated.autoDeduction;
    return Math.max(0, stock);
  } catch (error) {
    console.error("Error calculating physical stock:", error);
    return 0;
  }
}

function findProductByVariant(
  productMappedVariants: Array<{ productId: string; mappedVariants: any[] }>,
  variantId: string,
): string | null {
  try {
    if (!variantId || !productMappedVariants || productMappedVariants.length === 0) return null;
    for (const product of productMappedVariants) {
      if (!product.mappedVariants || !Array.isArray(product.mappedVariants)) continue;
      const variantExists = product.mappedVariants.some(
        (mapping: any) => mapping?.variantId === variantId,
      );
      if (variantExists) return product.productId;
    }
    return null;
  } catch (error) {
    console.error(`Error finding product for variant ${variantId}:`, error);
    return null;
  }
}

function extractLineItems(order: any): any[] {
  try {
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

function formatDateForQuery(date: Date): string {
  try {
    const isoString = date.toISOString();
    return isoString.slice(0, -1) + "+05:30";
  } catch (error) {
    console.error("Error formatting date:", error);
    return new Date().toISOString();
  }
}

function calculatePreStockoutAverage(
  dailySales: { [date: string]: number },
  stockoutDates: Set<string>,
  analysisStartDate: Date,
): number | null {
  try {
    if (stockoutDates.size === 0) return null;

    const sortedStockoutDates = Array.from(stockoutDates).sort();
    const firstStockoutDate = sortedStockoutDates[0];
    const startDateStr = analysisStartDate.toISOString().split("T")[0];

    const start = new Date(startDateStr);
    const firstStockout = new Date(firstStockoutDate);
    const preStockoutDays = Math.floor(
      (firstStockout.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (preStockoutDays <= 0) {
      console.warn("First stockout was on first day of analysis period — no pre-stockout data");
      return null;
    }

    const preStockoutTotal = Object.entries(dailySales)
      .filter(([date]) => date >= startDateStr && date < firstStockoutDate)
      .reduce((sum, [, sales]) => sum + sales, 0);

    const avg = preStockoutTotal / preStockoutDays;
    console.log(
      `📊 Pre-stockout avg: ${avg.toFixed(3)} units/day ` +
        `(${preStockoutTotal} total over ${preStockoutDays} days before ${firstStockoutDate})`,
    );

    return avg > 0 ? avg : null;
  } catch (error) {
    console.error("Error calculating pre-stockout average:", error);
    return null;
  }
}

// ============================================================================
// CATEGORY BENCHMARKING HELPERS
// ============================================================================

async function getProductReliability(
  businessId: string,
  productId: string,
  days: number,
  startDateStr: string,
  minSnapshotsRequired: number,
): Promise<{ isReliable: boolean; stockoutFrequency: number; daysWithSnapshots: number }> {
  try {
    const snapshots = await db
      .collection(`users/${businessId}/inventory_snapshots`)
      .where("productId", "==", productId)
      .where("date", ">=", startDateStr)
      .get();

    const daysWithSnapshots = snapshots.docs.length;
    const stockoutDays = snapshots.docs.filter((d) => d.data().isStockout === true).length;
    const stockoutFrequency = daysWithSnapshots > 0 ? stockoutDays / days : 1.0;
    const hasEnoughCoverage = daysWithSnapshots >= minSnapshotsRequired;
    const hasAcceptableStockouts = stockoutFrequency <= 0.3;

    return {
      isReliable: hasEnoughCoverage && hasAcceptableStockouts,
      stockoutFrequency,
      daysWithSnapshots,
    };
  } catch (error) {
    console.error(`Error checking reliability for ${productId}:`, error);
    return { isReliable: false, stockoutFrequency: 1.0, daysWithSnapshots: 0 };
  }
}

// ============================================================================
// CATEGORY BENCHMARKING
// ============================================================================

export async function calculateCategoryBenchmark(
  businessId: string,
  ordersSnapshot: any[],
  category: string,
  days: number = 30,
  excludeProductIds: string[] = [],
  minSnapshotsRequired?: number,
): Promise<CategoryBenchmark | null> {
  try {
    if (!businessId || typeof businessId !== "string") throw new Error("Invalid businessId");
    if (!category || typeof category !== "string") throw new Error("Invalid category");
    if (!Array.isArray(ordersSnapshot)) {
      console.warn("ordersSnapshot is not an array");
      return null;
    }

    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const startDateStr = startDate.toISOString().split("T")[0];
    const snapshotThreshold = minSnapshotsRequired ?? days * 0.3;

    const productsSnapshot = await db
      .collection(`users/${businessId}/products`)
      .where("name", "==", category)
      .get();

    if (productsSnapshot.empty) {
      console.warn(`No products found in category: ${category}`);
      return null;
    }

    const candidateIds: string[] = [];
    const productMappedVariants: Array<{ productId: string; mappedVariants: any[] }> = [];

    productsSnapshot.docs.forEach((doc) => {
      if (!excludeProductIds.includes(doc.id)) {
        candidateIds.push(doc.id);
        const data = doc.data();
        productMappedVariants.push({
          productId: doc.id,
          mappedVariants: Array.isArray(data?.mappedVariants) ? data.mappedVariants : [],
        });
      }
    });

    if (candidateIds.length === 0) {
      console.warn(`No candidate products after exclusions in category: ${category}`);
      return null;
    }

    // ─── FIX 15: Reliability checks in parallel ───────────────────────────
    const reliabilityResults = await Promise.all(
      candidateIds.map((productId) =>
        getProductReliability(businessId, productId, days, startDateStr, snapshotThreshold),
      ),
    );

    const reliableIds: string[] = [];
    let unreliableCount = 0;

    reliabilityResults.forEach((reliability, index) => {
      if (reliability.isReliable) {
        reliableIds.push(candidateIds[index]);
      } else {
        unreliableCount++;
        console.warn(
          `⚠️ Excluding peer ${candidateIds[index]} from benchmark — ` +
            `stockoutFreq=${reliability.stockoutFrequency.toFixed(2)}, ` +
            `snapshots=${reliability.daysWithSnapshots}/${days}`,
        );
      }
    });

    if (reliableIds.length === 0) {
      console.error(
        `🚨 Category benchmark FAILED for "${category}": ` +
          `all ${unreliableCount} peers have unreliable data`,
      );
      return {
        category,
        avgDailySales: 0,
        standardDeviation: 0,
        productCount: 0,
        confidence: 0,
        benchmarkQuality: "failed",
        excludedCount: unreliableCount,
        reason: "ALL_PEERS_UNRELIABLE",
      };
    }

    const reliableMappedVariants = productMappedVariants.filter((p) =>
      reliableIds.includes(p.productId),
    );

    const productSales: { [productId: string]: number } = {};

    for (const docSnapshot of ordersSnapshot) {
      try {
        const order = docSnapshot.data();
        if (!order) continue;
        const lineItems = extractLineItems(order);
        for (const item of lineItems) {
          if (!item?.variant_id) continue;
          const quantity = Number(item.quantity);
          if (isNaN(quantity) || quantity <= 0) continue;
          const productId = findProductByVariant(reliableMappedVariants, item.variant_id);
          if (productId) {
            productSales[productId] = (productSales[productId] || 0) + quantity;
          }
        }
      } catch (orderError) {
        console.error("Error processing order in category benchmark:", orderError);
      }
    }

    const productAvgs: number[] = reliableIds.map((id) => (productSales[id] || 0) / days);
    const categoryAvg = productAvgs.reduce((sum, v) => sum + v, 0) / productAvgs.length;
    const categoryStdDev = calculateStandardDeviation(productAvgs, categoryAvg);
    const confidence = Math.min(1, productAvgs.length / 10);
    const benchmarkQuality = reliableIds.length >= 2 ? "reliable" : "weak";

    console.log(
      `📊 Category benchmark "${category}": ` +
        `${reliableIds.length} reliable, ${unreliableCount} excluded, ` +
        `quality=${benchmarkQuality}, avg=${categoryAvg.toFixed(3)}`,
    );

    return {
      category,
      avgDailySales: categoryAvg,
      standardDeviation: categoryStdDev,
      productCount: reliableIds.length,
      confidence,
      benchmarkQuality,
      excludedCount: unreliableCount,
    };
  } catch (error) {
    console.error(`Error in calculateCategoryBenchmark for "${category}":`, error);
    return null;
  }
}

export async function findSimilarProducts(
  businessId: string,
  targetProductId: string,
  limit: number = 5,
): Promise<string[]> {
  try {
    if (!businessId || !targetProductId) return [];

    const targetProduct = await db.doc(`users/${businessId}/products/${targetProductId}`).get();
    if (!targetProduct.exists) {
      console.warn(`Product ${targetProductId} not found`);
      return [];
    }

    const targetData = targetProduct.data() as Product;
    if (!targetData?.category) {
      console.warn(`Product ${targetProductId} has no category`);
      return [];
    }

    const similarProductsSnapshot = await db
      .collection(`users/${businessId}/products`)
      .where("category", "==", targetData.category)
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

export async function calculateSalesMetrics(
  businessId: string,
  linkedStores: string[],
  productId: string,
  days: number = 30,
  sharedOrdersSnapshot?: any[], // ← pre-fetched from batch, skips Firestore query
  productData?: Product, // ← pre-fetched from batch, skips productDoc fetch
): Promise<SalesMetrics> {
  try {
    if (!businessId || !productId) throw new Error("Invalid businessId or productId");
    if (!Array.isArray(linkedStores)) {
      console.warn("linkedStores is not an array, using empty array");
      linkedStores = [];
    }

    const now = new Date();
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const startDateStr = startDate.toISOString().split("T")[0];

    // ─── FIX 14: Only fetch product if not passed in ───────────────────────
    let product: Product;
    if (productData) {
      product = productData;
    } else {
      const productDoc = await db.doc(`users/${businessId}/products/${productId}`).get();
      if (!productDoc.exists) throw new Error(`Product ${productId} not found`);
      product = productDoc.data() as Product;
    }

    const category = product?.name;
    const mappedVariants = Array.isArray(product?.mappedVariants) ? product.mappedVariants : [];

    // ─── FIX 13: Only fetch orders if not passed in ────────────────────────
    const dateStringForOrder = formatDateForQuery(startDate);
    let combinedOrdersSnapshotArray: any[];

    if (sharedOrdersSnapshot) {
      combinedOrdersSnapshotArray = sharedOrdersSnapshot;
    } else {
      combinedOrdersSnapshotArray = [];
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
        }
      }
    }

    // ─── FIX 1: No .orderBy() on snapshot query ───────────────────────────
    let snapshotsSnapshot: { empty: boolean; docs: any[] };
    try {
      const raw = await db
        .collection(`users/${businessId}/inventory_snapshots`)
        .where("productId", "==", productId)
        .where("date", ">=", startDateStr)
        .get();
      snapshotsSnapshot = { empty: raw.empty, docs: raw.docs };
    } catch (snapshotError: any) {
      console.error("Error fetching inventory snapshots:", snapshotError.message);
      snapshotsSnapshot = { empty: true, docs: [] };
    }

    // ─── FIX 2 & 3: Track actual snapshot count ───────────────────────────
    const daysWithSnapshots = snapshotsSnapshot.empty ? 0 : snapshotsSnapshot.docs.length;
    const daysWithoutData = days - daysWithSnapshots;
    const snapshotCoverage = daysWithSnapshots / days;

    if (snapshotCoverage < 0.5) {
      console.warn(
        `⚠️ Low snapshot coverage for ${productId}: ` +
          `${daysWithSnapshots}/${days} days (${(snapshotCoverage * 100).toFixed(0)}%). ` +
          `Results may be unreliable until daily snapshots are collected.`,
      );
    }

    // ─── FIX 10: stockLevel===0 && dailySales===0 = genuine stockout ──────
    // stockLevel===0 but dailySales>0 = sold out mid-day (real demand, don't exclude)
    let stockoutDays = 0;
    const stockoutDates = new Set<string>();

    if (!snapshotsSnapshot.empty) {
      snapshotsSnapshot.docs.forEach((doc: any) => {
        try {
          const data = doc.data();
          const shouldExclude = data?.stockLevel === 0 && (data?.dailySales || 0) === 0;
          if (shouldExclude) {
            stockoutDays++;
            stockoutDates.add(data.date);
          }
        } catch (error) {
          console.error("Error processing snapshot:", error);
        }
      });
    }

    // ─── FIX 2: inStockDays from actual snapshots only ────────────────────
    const inStockDays = Math.max(0, daysWithSnapshots - stockoutDays);

    // Build daily sales map
    const dailySales: { [date: string]: number } = {};
    let totalSales = 0;

    for (const docSnapshot of combinedOrdersSnapshotArray) {
      try {
        const order = docSnapshot.data();
        if (!order) continue;

        const lineItems = extractLineItems(order);
        for (const item of lineItems) {
          if (!item?.variant_id) continue;

          const variantBelongsToProduct = mappedVariants.some(
            (mapping: any) => mapping?.variantId === item.variant_id,
          );
          if (!variantBelongsToProduct) continue;

          const quantity = Number(item.quantity);
          if (isNaN(quantity) || quantity <= 0) continue;

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
      }
    }

    const last7DaysAvg = calculatePeriodAverage(dailySales, 7, stockoutDates);
    const last14DaysAvg = calculatePeriodAverage(dailySales, 14, stockoutDates);
    const last30DaysAvg = calculatePeriodAverage(dailySales, 30, stockoutDates);

    // ─── FIX 12: Full window — numerator and denominator from same pool ────
    let avgDailySales = totalSales / days;
    const salesValues = Object.values(dailySales);
    let standardDeviation = calculateStandardDeviation(salesValues, avgDailySales);

    let usedCategoryBenchmark = false;
    let categoryBlendPercentage = 0;
    let dataQuality: SalesMetrics["dataQuality"] = "excellent";
    let dataSource = "product_history";

    // ─── FIX 4: needsBenchmarking triggers on low snapshot coverage ───────
    const needsBenchmarking =
      inStockDays < 7 ||
      daysWithSnapshots < days * 0.3 ||
      stockoutDays > days * 0.5 ||
      totalSales === 0 ||
      (inStockDays < 14 && totalSales < 10);

    if (needsBenchmarking && category) {
      console.log(
        `Product ${productId} needs benchmarking — ` +
          `inStock=${inStockDays}, stockout=${stockoutDays}, ` +
          `coverage=${(snapshotCoverage * 100).toFixed(0)}%, sales=${totalSales}`,
      );

      try {
        const categoryBenchmark = await calculateCategoryBenchmark(
          businessId,
          combinedOrdersSnapshotArray,
          category,
          days,
          [productId],
          daysWithSnapshots, // peers must have at least as many snapshots as this product
        );

        if (categoryBenchmark && categoryBenchmark.benchmarkQuality !== "failed") {
          usedCategoryBenchmark = true;
          dataSource = `category_benchmark_${categoryBenchmark.benchmarkQuality}`;

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

          if (categoryBenchmark.benchmarkQuality === "weak") {
            productWeight = Math.max(productWeight, 0.5);
            categoryBlendPercentage = Math.min(categoryBlendPercentage, 50);
          }

          const categoryWeight = 1 - productWeight;
          avgDailySales =
            avgDailySales * productWeight + categoryBenchmark.avgDailySales * categoryWeight;
          standardDeviation =
            standardDeviation * productWeight +
            categoryBenchmark.standardDeviation * categoryWeight;

          console.log(
            `Blended: ${productWeight * 100}% product + ` +
              `${categoryWeight * 100}% category (quality: ${categoryBenchmark.benchmarkQuality})`,
          );
        } else {
          // ─── FIX 6: Cascading failure fallback chain ─────────────────────
          console.error(
            `🚨 Cascading data failure for ${productId}: ` +
              `product AND all category peers have insufficient data`,
          );

          const preStockoutAvg =
            stockoutDates.size > 0
              ? calculatePreStockoutAverage(dailySales, stockoutDates, startDate)
              : null;

          if (preStockoutAvg !== null && preStockoutAvg > 0) {
            avgDailySales = preStockoutAvg * 1.1;
            dataSource = "pre_stockout_history";
            dataQuality = "poor";
          } else if (inStockDays > 0 && totalSales > 0) {
            // ─── FIX 16: Correct name — uses full window ──────────────────
            avgDailySales = totalSales / days;
            dataSource = "product_full_window";
            dataQuality = "poor";
            console.log(
              `📊 Using full window avg: ${avgDailySales.toFixed(3)} ` +
                `(${totalSales} units over ${days} day window)`,
            );
          } else {
            avgDailySales = 0.5;
            dataSource = "conservative_fallback";
            dataQuality = "insufficient";
          }
        }
      } catch (benchmarkError) {
        console.error("Error calculating category benchmark:", benchmarkError);
        dataQuality = "poor";
        dataSource = "product_history_fallback";
      }
    } else if (!needsBenchmarking) {
      // ─── FIX 7: dataQuality considers snapshot coverage ──────────────────
      if (inStockDays >= 21 && stockoutDays <= 3 && snapshotCoverage >= 0.8) {
        dataQuality = "excellent";
      } else if (inStockDays >= 14 && snapshotCoverage >= 0.5) {
        dataQuality = "good";
      } else if (inStockDays >= 7) {
        dataQuality = "fair";
      } else {
        dataQuality = "poor";
      }
      dataSource = "product_history";
    }

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
      daysWithSnapshots,
      daysWithoutData,
      snapshotCoverage,
      dataQuality,
      usedCategoryBenchmark,
      categoryBlendPercentage,
      dataSource,
    };
  } catch (error) {
    console.error(`Critical error in calculateSalesMetrics for ${productId}:`, error);
    return {
      avgDailySales: 0,
      last7DaysAvg: 0,
      last14DaysAvg: 0,
      last30DaysAvg: 0,
      standardDeviation: 0,
      trendMultiplier: 1.0,
      inStockDays: 0,
      stockoutDays: days,
      daysWithSnapshots: 0,
      daysWithoutData: days,
      snapshotCoverage: 0,
      dataQuality: "insufficient",
      usedCategoryBenchmark: false,
      dataSource: "error_fallback",
    };
  }
}

function calculatePeriodAverage(
  dailySales: { [date: string]: number },
  days: number,
  stockoutDates: Set<string>,
): number {
  try {
    const now = new Date();
    let total = 0;
    let validDays = 0;

    for (let i = 0; i < days; i++) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateKey = date.toISOString().split("T")[0];
      if (!stockoutDates.has(dateKey)) {
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

function calculateStandardDeviation(values: number[], mean: number): number {
  try {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const validValues = values.filter((v) => typeof v === "number" && !isNaN(v));
    if (validValues.length === 0) return 0;
    const variance =
      validValues.map((val) => Math.pow(val - mean, 2)).reduce((sum, v) => sum + v, 0) /
      validValues.length;
    return Math.sqrt(variance);
  } catch (error) {
    console.error("Error calculating standard deviation:", error);
    return 0;
  }
}

function calculateTrendMultiplier(
  last7DaysAvg: number,
  last14DaysAvg: number,
  last30DaysAvg: number,
): number {
  try {
    if (last30DaysAvg === 0) return 1.0;
    const recentTrend = last14DaysAvg > 0 ? last7DaysAvg / last14DaysAvg : 1.0;
    const longerTrend = last30DaysAvg > 0 ? last14DaysAvg / last30DaysAvg : 1.0;
    return Math.max(0.5, Math.min(2.0, recentTrend * 0.7 + longerTrend * 0.3));
  } catch (error) {
    console.error("Error calculating trend multiplier:", error);
    return 1.0;
  }
}

function calculateSafetyStock(
  standardDeviation: number,
  leadTimeDays: number,
  serviceLevel: number = 0.95,
): number {
  try {
    const zScore = serviceLevel === 0.95 ? 1.65 : serviceLevel === 0.99 ? 2.33 : 1.28;
    return Math.ceil(
      Math.max(0, zScore * standardDeviation * Math.sqrt(Math.max(1, leadTimeDays))),
    );
  } catch (error) {
    console.error("Error calculating safety stock:", error);
    return 0;
  }
}

// ============================================================================
// MAIN RESTOCK RECOMMENDATION
// ============================================================================

export async function calculateRestockRecommendation(
  businessId: string,
  productId: string,
  forecastDays: number = 14,
  options: { serviceLevel?: number; forceMinimumOrder?: boolean } = {},
  sharedOrdersSnapshot?: any[], // ← pre-fetched from batch
  linkedStores?: string[], // ← FIX 13: pre-fetched from batch, skips businessDoc fetch
  productData?: Product, // ← FIX 14: pre-fetched from batch, skips productDoc fetch
): Promise<RestockRecommendation> {
  try {
    if (!businessId || typeof businessId !== "string") throw new Error("Invalid businessId");
    if (!productId || typeof productId !== "string") throw new Error("Invalid productId");

    forecastDays = Math.max(1, Math.min(90, forecastDays || 14));

    // ─── FIX 13: Only fetch businessDoc if linkedStores not provided ───────
    let resolvedLinkedStores = linkedStores;
    if (!resolvedLinkedStores) {
      const businessDoc = await db.doc(`users/${businessId}`).get();
      if (!businessDoc.exists) throw new Error(`Business ${businessId} not found`);
      resolvedLinkedStores = Array.isArray(businessDoc.data()?.stores)
        ? (businessDoc.data()!.stores as string[])
        : [];
    }

    // ─── FIX 14: Only fetch productDoc if productData not provided ─────────
    let product = productData;
    if (!product) {
      const productDoc = await db.doc(`users/${businessId}/products/${productId}`).get();
      if (!productDoc.exists) throw new Error(`Product ${productId} not found`);
      product = productDoc.data() as Product;
    }

    const currentStock = calculatePhysicalStock(product?.inventory);
    const leadTimeDays = Math.max(1, product?.inventoryTracking?.leadTimeDays || 7);
    const minimumOrderQuantity = Math.max(0, product?.inventoryTracking?.minimumOrderQuantity || 0);

    const metrics = await calculateSalesMetrics(
      businessId,
      resolvedLinkedStores,
      productId,
      30,
      sharedOrdersSnapshot,
      product, // ← pass down so calculateSalesMetrics doesn't fetch again
    );

    // ─── FIX 9/11: Warnings with correct reasons ──────────────────────────
    const warnings: string[] = [];

    if (metrics.dataQuality === "insufficient") {
      warnings.push("No confirmed sales history. Prediction based on fallback data.");
    } else if (metrics.dataQuality === "poor") {
      warnings.push("Limited confirmed sales history. Prediction has low confidence.");
    } else if (metrics.usedCategoryBenchmark) {
      // ─── FIX 11: Correct reason ──────────────────────────────────────────
      const reason =
        metrics.stockoutDays > 0 ? "due to high stockout days" : "due to low snapshot coverage";
      warnings.push(
        `Prediction blended with ${metrics.categoryBlendPercentage}% category data ${reason}.`,
      );
    }

    if (metrics.stockoutDays > 10) {
      warnings.push(`Product was out of stock for ${metrics.stockoutDays} days in the last month.`);
    }

    if (metrics.snapshotCoverage < 0.5) {
      warnings.push(
        `Only ${metrics.daysWithSnapshots} of 30 days have inventory snapshots. ` +
          `Predictions will improve as daily snapshot data accumulates.`,
      );
    }

    if (metrics.dataSource === "pre_stockout_history") {
      warnings.push(
        "⚠️ Both product and all category peers have insufficient data. " +
          "Using pre-stockout sales rate as fallback.",
      );
    }

    if (metrics.dataSource === "conservative_fallback") {
      warnings.push(
        "🚨 CRITICAL: No reliable data found for product or any category peer. " +
          "Using conservative minimum (0.5 units/day). Manual review required.",
      );
    }

    if (metrics.dataSource?.includes("weak")) {
      warnings.push(
        "Only 1 reliable peer found in category benchmark. Benchmark confidence is low.",
      );
    }

    if (!product.category && metrics.dataQuality !== "excellent") {
      warnings.push("Product has no category. Assign one for better benchmarking.");
    }

    if (resolvedLinkedStores.length === 0) {
      warnings.push("No linked stores found. Sales data may be incomplete.");
    }

    let stockoutAdjustment = 1.0;
    if (metrics.stockoutDays > 10) stockoutAdjustment = 1.4;
    else if (metrics.stockoutDays > 5) stockoutAdjustment = 1.25;
    else if (metrics.stockoutDays > 2) stockoutAdjustment = 1.15;

    if (
      metrics.usedCategoryBenchmark &&
      metrics.categoryBlendPercentage &&
      metrics.categoryBlendPercentage > 50
    ) {
      stockoutAdjustment = Math.min(stockoutAdjustment, 1.15);
    }

    const weightedDailySales =
      metrics.last7DaysAvg * 0.5 + metrics.last14DaysAvg * 0.3 + metrics.last30DaysAvg * 0.2;

    const predictedDailyDemand = weightedDailySales * metrics.trendMultiplier * stockoutAdjustment;

    const safetyStock = calculateSafetyStock(
      metrics.standardDeviation,
      leadTimeDays,
      options.serviceLevel || 0.95,
    );

    let suggestedQuantity = Math.max(
      0,
      Math.ceil(predictedDailyDemand * forecastDays + safetyStock - currentStock),
    );

    if (options.forceMinimumOrder && minimumOrderQuantity > 0) {
      suggestedQuantity = Math.max(suggestedQuantity, minimumOrderQuantity);
    }

    const dataQualityScore = {
      excellent: 1.0,
      good: 0.85,
      fair: 0.7,
      poor: 0.5,
      insufficient: 0.3,
    }[metrics.dataQuality];

    const volatilityPenalty = metrics.standardDeviation / (metrics.avgDailySales || 1);
    const coveragePenalty = Math.max(0, 0.5 - metrics.snapshotCoverage) * 0.2;
    const categoryBonus = metrics.usedCategoryBenchmark ? 0.1 : 0;

    const confidence = Math.max(
      0,
      Math.min(
        1,
        dataQualityScore * (1 - Math.min(0.5, volatilityPenalty * 0.1)) -
          coveragePenalty +
          categoryBonus,
      ),
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
    console.error(`Error in calculateRestockRecommendation for ${productId}:`, error);
    throw error;
  }
}

// ============================================================================
// BATCH + METADATA FUNCTIONS
// ============================================================================

export async function calculateAllRestockRecommendations(
  businessId: string,
  options: { minStockThreshold?: number; forecastDays?: number } = {},
): Promise<RestockRecommendation[]> {
  try {
    if (!businessId) throw new Error("Invalid businessId");

    // ─── Fetch businessDoc ONCE ────────────────────────────────────────────
    const businessDoc = await db.doc(`users/${businessId}`).get();
    if (!businessDoc.exists) throw new Error(`Business ${businessId} not found`);

    const linkedStores = Array.isArray(businessDoc.data()?.stores)
      ? (businessDoc.data()!.stores as string[])
      : [];

    const days = 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const dateStringForOrder = formatDateForQuery(startDate);

    // ─── Fetch orders ONCE across all stores in parallel ──────────────────
    console.log(`Fetching orders for ${linkedStores.length} stores...`);
    const storeOrderSnapshots = await Promise.all(
      linkedStores.map(async (store) => {
        try {
          const snapshot = await db
            .collection(`accounts/${store}/orders`)
            .where("createdAt", ">=", dateStringForOrder)
            .orderBy("createdAt", "asc")
            .get();
          return snapshot.docs;
        } catch (err) {
          console.error(`Failed to fetch orders for store ${store}:`, err);
          return [];
        }
      }),
    );

    const sharedOrdersSnapshot = storeOrderSnapshots.flat();
    console.log(`Fetched ${sharedOrdersSnapshot.length} total orders`);

    // ─── Fetch all products ONCE ───────────────────────────────────────────
    const productsSnapshot = await db.collection(`users/${businessId}/products`).get();

    // ─── Process all products in PARALLEL ─────────────────────────────────
    const recommendations: RestockRecommendation[] = [];
    const errors: Array<{ productId: string; error: any }> = [];

    await Promise.all(
      productsSnapshot.docs.map(async (doc) => {
        try {
          const product = doc.data() as Product;
          const currentStock = calculatePhysicalStock(product?.inventory);

          if (options.minStockThreshold && currentStock > options.minStockThreshold) return;

          const recommendation = await calculateRestockRecommendation(
            businessId,
            doc.id,
            options.forecastDays,
            {},
            sharedOrdersSnapshot, // ← pre-fetched orders
            linkedStores, // ← pre-fetched stores (skips businessDoc fetch)
            product, // ← pre-fetched product (skips productDoc fetch ×2)
          );

          if (recommendation.suggestedQuantity > 0) {
            recommendations.push(recommendation);
          }
        } catch (error) {
          console.error(`Error calculating restock for product ${doc.id}:`, error);
          errors.push({ productId: doc.id, error });
        }
      }),
    );

    if (errors.length > 0) {
      console.warn(
        `Failed to calculate ${errors.length} products:`,
        errors.map((e) => e.productId),
      );
    }

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

export async function updateProductTrackingMetadata(
  businessId: string,
  productId: string,
): Promise<void> {
  try {
    if (!businessId || !productId) throw new Error("Invalid businessId or productId");

    const businessDoc = await db.doc(`users/${businessId}`).get();
    if (!businessDoc.exists) throw new Error(`Business ${businessId} not found`);

    const productDoc = await db.doc(`users/${businessId}/products/${productId}`).get();
    if (!productDoc.exists) throw new Error(`Product ${productId} not found`);

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
