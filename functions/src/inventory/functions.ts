// cloud-functions.ts
// Firebase Cloud Functions for automated restock logic
// import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
    calculateRestockRecommendation,
    // calculateAllRestockRecommendations,
    // updateProductTrackingMetadata,
} from './restockLogic';
// import { db } from '../firebaseAdmin';
// import { Timestamp } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { ENQUEUE_FUNCTION_SECRET } from '../config';


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

/**
 * Get restock recommendation for a specific product
 * 
 * Usage from client:
 * const getRestock = httpsCallable(functions, 'getRestockRecommendation');
 * const result = await getRestock({ productId: 'abc123', forecastDays: 14 });
 */
export const getRestockRecommendation = onRequest(
    { cors: true, timeoutSeconds: 540, secrets: [ENQUEUE_FUNCTION_SECRET], memory: "512MiB" },
    async (req, res) => {
        const { businessId, productId, forecastDays = 14 } = req.body;

        if (!businessId || !productId) {
            throw new Error('invalid argument: businessId or productId missing');
        }
        try {
            const recommendation = await calculateRestockRecommendation(
                businessId,
                productId,
                forecastDays
            );

            res.status(200).json({
                success: true,
                recommendation,
            });
        } catch (error) {
            console.error('Error calculating restock:', error);
            res.status(500).json({ error: `Failed to calculate restock: ${error}` });
        }
    }
);

/**
 * Get all restock recommendations
 * 
 * Usage from client:
 * const getAllRestocks = httpsCallable(functions, 'getAllRestockRecommendations');
 * const result = await getAllRestocks({ minStockThreshold: 10 });
 */
// export const getAllRestockRecommendations = functions.https.onCall(
//     async (data, context) => {
//         const { minStockThreshold, forecastDays = 14 } = data;

//         try {
//             const recommendations = await calculateAllRestockRecommendations(db, {
//                 minStockThreshold,
//                 forecastDays,
//             });

//             return {
//                 success: true,
//                 recommendations,
//                 count: recommendations.length,
//             };
//         } catch (error) {
//             console.error('Error calculating restocks:', error);
//             throw new functions.https.HttpsError('internal', 'Failed to calculate restocks');
//         }
//     }
// );

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