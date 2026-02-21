// cloud-functions.ts
// Firebase Cloud Functions for automated restock logic
// import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  calculateAllRestockRecommendations,
  calculateRestockRecommendation,
  // calculateAllRestockRecommendations,
  // updateProductTrackingMetadata,
} from "./restockLogic";
// import { db } from '../firebaseAdmin';
// import { Timestamp } from 'firebase-admin/firestore';
import { onRequest } from "firebase-functions/v2/https";
import { ENQUEUE_FUNCTION_SECRET } from "../config";

// ============================================================================
// SCHEDULED FUNCTIONS (Run automatically)
// ============================================================================

/**
 * Runs daily at 9 AM to generate restock recommendations
 * Sends notifications or creates purchase orders
 *
 * Deploy: firebase deploy --only functions:dailyRestockCheck
 */
// export const dailyRestockCheck = onSchedule(
//     {
//         schedule: "0 9 * * *", // 9 AM daily
//         timeZone: "Asia/Kolkata",
//         memory: "1GiB",
//         timeoutSeconds: 540,
//     },
//     async () => {
//         console.log('Running daily restock check...');

//         const recommendations = await calculateAllRestockRecommendations(db, {
//             forecastDays: 14, // 2 weeks ahead
//         });

//         console.log(`Generated ${recommendations.length} restock recommendations`);

//         // Save recommendations to Firestore
//         const batch = db.batch();
//         recommendations.forEach(rec => {
//             const docRef = db.collection('restock_predictions').doc();
//             batch.set(docRef, {
//                 ...rec,
//                 status: 'pending',
//                 createdAt: Timestamp.now(),
//             });
//         });
//         await batch.commit();

//         // TODO: Send email/notification to procurement team
//         // await sendRestockNotification(recommendations);
//     },
// );

/**
 * Runs weekly to update product tracking metadata
 */
// export const weeklyMetadataUpdate = functions.pubsub
//     .schedule('0 3 * * 0') // Sunday at 3 AM
//     .timeZone('Asia/Kolkata')
//     .onRun(async (context) => {
//         console.log('Updating product metadata...');

//         const productsSnapshot = await db.collection('products').get();
//         const promises = productsSnapshot.docs.map(doc =>
//             updateProductTrackingMetadata(db, doc.id)
//         );

//         await Promise.all(promises);
//         console.log(`Updated metadata for ${promises.length} products`);

//         return null;
//     });

// ============================================================================
// HTTP CALLABLE FUNCTIONS (Call from your app)
// ============================================================================

function validateRestockRequest(body: any): {
  valid: boolean;
  businessId?: string;
  productId?: string;
  forecastDays?: number;
  options?: {
    serviceLevel?: number;
    forceMinimumOrder?: boolean;
  };
  error?: string;
} {
  try {
    // Check if body exists
    if (!body || typeof body !== "object") {
      return { valid: false, error: "Request body is required" };
    }

    // Validate businessId
    if (!body.businessId || typeof body.businessId !== "string" || body.businessId.trim() === "") {
      return { valid: false, error: "businessId is required and must be a non-empty string" };
    }

    // Validate productId
    if (!body.productId || typeof body.productId !== "string" || body.productId.trim() === "") {
      return { valid: false, error: "productId is required and must be a non-empty string" };
    }

    const businessId = body.businessId.trim();
    const productId = body.productId.trim();

    // Validate forecastDays
    let forecastDays = 14; // Default
    if (body.forecastDays !== undefined) {
      const parsed = Number(body.forecastDays);
      if (isNaN(parsed) || parsed < 1 || parsed > 90) {
        return { valid: false, error: "forecastDays must be a number between 1 and 90" };
      }
      forecastDays = Math.floor(parsed);
    }

    // Validate options if provided
    let options: { serviceLevel?: number; forceMinimumOrder?: boolean } | undefined;
    if (body.options && typeof body.options === "object") {
      options = {};

      // Validate serviceLevel
      if (body.options.serviceLevel !== undefined) {
        const serviceLevel = Number(body.options.serviceLevel);
        if (isNaN(serviceLevel) || serviceLevel < 0.5 || serviceLevel > 0.99) {
          return { valid: false, error: "options.serviceLevel must be between 0.5 and 0.99" };
        }
        options.serviceLevel = serviceLevel;
      }

      // Validate forceMinimumOrder
      if (body.options.forceMinimumOrder !== undefined) {
        if (typeof body.options.forceMinimumOrder !== "boolean") {
          return { valid: false, error: "options.forceMinimumOrder must be a boolean" };
        }
        options.forceMinimumOrder = body.options.forceMinimumOrder;
      }
    }

    return {
      valid: true,
      businessId,
      productId,
      forecastDays,
      options,
    };
  } catch (error) {
    console.error("Error validating request:", error);
    return { valid: false, error: "Invalid request format" };
  }
}

/**
 * Cloud Function: Get restock recommendation for a product
 * ROBUST VERSION with comprehensive error handling and validation
 */
export const getRestockRecommendation = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    secrets: [ENQUEUE_FUNCTION_SECRET],
    memory: "512MiB",
  },
  async (req, res) => {
    const startTime = Date.now();
    let businessId: string | undefined;
    let productId: string | undefined;

    try {
      // Log request
      console.log("Restock recommendation request received", {
        method: req.method,
        hasBody: !!req.body,
        timestamp: new Date().toISOString(),
      });

      // Only accept POST requests
      if (req.method !== "POST") {
        res.status(405).json({
          success: false,
          error: "Method not allowed. Use POST.",
        });
        return;
      }

      // Validate request body
      const validation = validateRestockRequest(req.body);

      if (!validation.valid) {
        console.warn("Invalid request:", validation.error);
        res.status(400).json({
          success: false,
          error: validation.error || "Invalid request",
        });
        return;
      }

      businessId = validation.businessId!;
      productId = validation.productId!;
      const forecastDays = validation.forecastDays!;
      const options = validation.options;

      console.log("Processing restock recommendation:", {
        businessId,
        productId,
        forecastDays,
        options,
      });

      // Calculate recommendation with timeout handling
      const recommendation = await Promise.race([
        calculateRestockRecommendation(businessId, productId, forecastDays, options),
        new Promise(
          (_, reject) => setTimeout(() => reject(new Error("Calculation timeout")), 530000), // 530s (before Cloud Function timeout)
        ),
      ]);

      const duration = Date.now() - startTime;

      console.log("Restock calculation successful:", {
        businessId,
        productId,
        suggestedQuantity: (recommendation as any).suggestedQuantity,
        confidence: (recommendation as any).confidence,
        duration: `${duration}ms`,
      });

      // Log warnings if any
      if ((recommendation as any).warnings && (recommendation as any).warnings.length > 0) {
        console.warn("Data quality warnings:", {
          businessId,
          productId,
          warnings: (recommendation as any).warnings,
        });
      }

      res.status(200).json({
        success: true,
        recommendation,
        meta: {
          processingTimeMs: duration,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      const duration = Date.now() - startTime;

      console.error("Error calculating restock:", {
        businessId,
        productId,
        error: error.message,
        stack: error.stack,
        duration: `${duration}ms`,
      });

      // Determine appropriate status code based on error type
      let statusCode = 500;
      let errorMessage = "Internal server error";
      let errorDetails: string | undefined;

      if (error.message) {
        errorDetails = error.message;

        // Handle specific error types
        if (error.message.includes("not found")) {
          statusCode = 404;
          errorMessage = "Resource not found";
        } else if (error.message.includes("Invalid")) {
          statusCode = 400;
          errorMessage = "Invalid request";
        } else if (error.message.includes("timeout")) {
          statusCode = 504;
          errorMessage = "Request timeout";
        } else if (error.message.includes("permission") || error.message.includes("unauthorized")) {
          statusCode = 403;
          errorMessage = "Permission denied";
        }
      }

      res.status(statusCode).json({
        success: false,
        error: errorMessage,
        details: errorDetails,
        meta: {
          processingTimeMs: duration,
          timestamp: new Date().toISOString(),
        },
      });
    }
  },
);

/**
 * Cloud Function: Get restock recommendations for all products
 * ROBUST VERSION with batch processing and error handling
 */
export const getAllRestockRecommendations = onRequest(
  {
    cors: true,
    timeoutSeconds: 3600,
    secrets: [ENQUEUE_FUNCTION_SECRET],
    memory: "1GiB", // More memory for batch processing
  },
  async (req, res) => {
    const startTime = Date.now();
    let businessId: string | undefined;

    try {
      console.log("Batch restock recommendations request received", {
        method: req.method,
        hasBody: !!req.body,
        timestamp: new Date().toISOString(),
      });

      // Only accept POST requests
      if (req.method !== "POST") {
        res.status(405).json({
          success: false,
          error: "Method not allowed. Use POST.",
        });
        return;
      }

      // Validate businessId
      if (!req.body || !req.body.businessId || typeof req.body.businessId !== "string") {
        res.status(400).json({
          success: false,
          error: "businessId is required and must be a string",
        });
        return;
      }

      businessId = String(req.body.businessId).trim();

      // Validate optional parameters
      let minStockThreshold: number | undefined;
      if (req.body.minStockThreshold !== undefined) {
        const parsed = Number(req.body.minStockThreshold);
        if (isNaN(parsed) || parsed < 0) {
          res.status(400).json({
            success: false,
            error: "minStockThreshold must be a non-negative number",
          });
          return;
        }
        minStockThreshold = parsed;
      }

      let forecastDays: number | undefined;
      if (req.body.forecastDays !== undefined) {
        const parsed = Number(req.body.forecastDays);
        if (isNaN(parsed) || parsed < 1 || parsed > 90) {
          res.status(400).json({
            success: false,
            error: "forecastDays must be between 1 and 90",
          });
          return;
        }
        forecastDays = parsed;
      }

      console.log("Processing batch recommendations:", {
        businessId,
        minStockThreshold,
        forecastDays,
      });

      // Calculate with timeout
      const recommendations = await Promise.race([
        calculateAllRestockRecommendations(businessId, {
          minStockThreshold,
          forecastDays,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Batch calculation timeout")), 530000),
        ),
      ]);

      const duration = Date.now() - startTime;

      console.log("Batch calculation successful:", {
        businessId,
        count: (recommendations as any[]).length,
        duration: `${duration}ms`,
      });

      // Collect warnings summary
      const totalWarnings = (recommendations as any[]).reduce(
        (sum, rec) => sum + (rec.warnings?.length || 0),
        0,
      );

      if (totalWarnings > 0) {
        console.warn(`Total warnings across all products: ${totalWarnings}`);
      }

      res.status(200).json({
        success: true,
        recommendations,
        meta: {
          count: (recommendations as any[]).length,
          totalWarnings,
          processingTimeMs: duration,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      const duration = Date.now() - startTime;

      console.error("Error in batch restock calculation:", {
        businessId,
        error: error.message,
        stack: error.stack,
        duration: `${duration}ms`,
      });

      let statusCode = 500;
      let errorMessage = "Internal server error";

      if (error.message?.includes("not found")) {
        statusCode = 404;
        errorMessage = "Business not found";
      } else if (error.message?.includes("timeout")) {
        statusCode = 504;
        errorMessage = "Request timeout - try reducing the scope";
      }

      res.status(statusCode).json({
        success: false,
        error: errorMessage,
        details: error.message,
        meta: {
          processingTimeMs: duration,
          timestamp: new Date().toISOString(),
        },
      });
    }
  },
);

/**
 * Manually trigger inventory snapshot for a product
 */
// export const triggerInventorySnapshot = functions.https.onCall(
//     async (data, context) => {
//         const { productId } = data;

//         if (!productId) {
//             throw new functions.https.HttpsError('invalid-argument', 'productId is required');
//         }

//         try {
//             await createInventorySnapshot(db, productId);
//             return { success: true };
//         } catch (error) {
//             console.error('Error creating snapshot:', error);
//             throw new functions.https.HttpsError('internal', 'Failed to create snapshot');
//         }
//     }
// );

// ============================================================================
// FIRESTORE TRIGGERS (Auto-run on database changes)
// ============================================================================

/**
 * When a new order is created, check if product needs restocking
 * This provides real-time alerts for fast-moving products
 */
// export const onOrderCreated = functions.firestore
//     .document('orders/{orderId}')
//     .onCreate(async (snap, context) => {
//         const order = snap.data();
//         const productId = order.productId;

//         // Get current product stock
//         const productDoc = await db.collection('products').doc(productId).get();
//         if (!productDoc.exists) return;

//         const product = productDoc.data();
//         const currentStock = product?.currentStock || 0;

//         // If stock is critically low (< 10 units), generate immediate alert
//         if (currentStock < 10) {
//             console.log(`⚠️ LOW STOCK ALERT: Product ${productId} has only ${currentStock} units`);

//             // Calculate restock recommendation
//             const recommendation = await calculateRestockRecommendation(db, productId, 7);

//             // Save as high-priority recommendation
//             await db.collection('restock_predictions').add({
//                 ...recommendation,
//                 status: 'urgent',
//                 createdAt: admin.firestore.Timestamp.now(),
//             });

//             // TODO: Send immediate notification
//             // await sendUrgentRestockAlert(productId, recommendation);
//         }

//         return null;
//     });

/**
 * When product stock is updated, check if it went to zero (stockout)
 */
// export const onProductStockUpdate = functions.firestore
//     .document('products/{productId}')
//     .onUpdate(async (change, context) => {
//         const beforeStock = change.before.data()?.currentStock || 0;
//         const afterStock = change.after.data()?.currentStock || 0;

//         // Detect stockout event
//         if (beforeStock > 0 && afterStock === 0) {
//             const productId = context.params.productId;

//             console.log(`📉 STOCKOUT: Product ${productId} is now out of stock`);

//             // Update product tracking
//             await db.collection('products').doc(productId).update({
//                 'inventoryTracking.lastStockoutDate': admin.firestore.Timestamp.now(),
//             });

//             // Create immediate restock recommendation
//             const recommendation = await calculateRestockRecommendation(db, productId, 7);

//             await db.collection('restock_predictions').add({
//                 ...recommendation,
//                 status: 'stockout',
//                 createdAt: admin.firestore.Timestamp.now(),
//             });
//         }

//         // Detect restock event
//         if (beforeStock === 0 && afterStock > 0) {
//             const productId = context.params.productId;

//             console.log(`📈 RESTOCKED: Product ${productId} now has ${afterStock} units`);

//             await db.collection('products').doc(productId).update({
//                 'inventoryTracking.lastRestockDate': admin.firestore.Timestamp.now(),
//                 'inventoryTracking.lastRestockQuantity': afterStock,
//             });
//         }

//         return null;
//     });

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Example notification function (implement based on your needs)
 */
// async function sendRestockNotification(recommendations: any[]) {
//     // Option 1: Send email via SendGrid, Mailgun, etc.
//     // Option 2: Send SMS via Twilio
//     // Option 3: Create Slack notification
//     // Option 4: Create in-app notification in Firestore

//     console.log('Sending notifications for restocks:', recommendations.length);

//     // Example: Create notification documents
//     const batch = db.batch();
//     recommendations.forEach(rec => {
//         const notifRef = db.collection('notifications').doc();
//         batch.set(notifRef, {
//             type: 'restock_needed',
//             productId: rec.productId,
//             suggestedQuantity: rec.suggestedQuantity,
//             read: false,
//             createdAt: admin.firestore.Timestamp.now(),
//         });
//     });
//     await batch.commit();
// }
