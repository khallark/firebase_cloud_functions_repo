import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../firebaseAdmin";
import { onRequest } from "firebase-functions/v2/https";
import { ENQUEUE_FUNCTION_SECRET } from "../../config";
import { requireHeaderSecret, sleep } from "../../helpers";

interface InitializeStats {
  accountsProcessed: number;
  totalOrders: number;
  metadataCreated: number;
  errors: number;
}

// async function initializeAccountMetadata(accountId: string): Promise<{
//   totalOrders: number;
//   counts: Record<string, number>;
// }> {
//   console.log(`  📊 Counting orders for account: ${accountId}`);

//   const ordersSnapshot = await db
//     .collection("accounts")
//     .doc(accountId)
//     .collection("orders")
//     .where("vendors", "array-contains", "OWR")
//     .get();

//   const counts: Record<string, number> = {
//     "All Orders": 0,
//     New: 0,
//     Confirmed: 0,
//     "Ready To Dispatch": 0,
//     Dispatched: 0,
//     "In Transit": 0,
//     "Out For Delivery": 0,
//     Delivered: 0,
//     "RTO In Transit": 0,
//     "RTO Delivered": 0,
//     "DTO Requested": 0,
//     "DTO Booked": 0,
//     "DTO In Transit": 0,
//     "DTO Delivered": 0,
//     "Pending Refunds": 0,
//     "DTO Refunded": 0,
//     Lost: 0,
//     Closed: 0,
//     "RTO Closed": 0,
//     "Cancellation Requested": 0,
//     Cancelled: 0,
//   };

//   let allOrdersCount = 0;

//   ordersSnapshot.docs.forEach((doc) => {
//     const order = doc.data();
//     const isShopifyCancelled = !!order.raw?.cancelled_at && order?.customStatus === "Cancelled";

//     allOrdersCount++;
//     if (isShopifyCancelled) {
//       counts["Cancelled"]++;
//     } else {
//       const status = order.customStatus || "New";
//       if (counts[status] !== undefined) {
//         counts[status]++;
//       } else {
//         console.warn(`  ⚠️ Unknown status found: ${status}`);
//       }
//     }
//   });

//   counts["All Orders"] = allOrdersCount;

//   // Save to metadata document
//   await (
//     await db
//       .collection("accounts")
//       .doc(accountId)
//       .collection("members")
//       .where("vendorName", "==", "STYLE 05")
//       .get()
//   ).docs?.[0]?.ref.set(
//     {
//       counts,
//       lastUpdated: FieldValue.serverTimestamp(),
//     },
//     { merge: true },
//   );

//   // await db
//   //   .collection("accounts")
//   //   .doc(accountId)
//   //   .collection("metadata")
//   //   .doc('orderCounts')
//   //   .set(
//   //     {
//   //       counts,
//   //       lastUpdated: FieldValue.serverTimestamp(),
//   //     },
//   //     { merge: true },
//   //   );

//   console.log(`  ✅ Metadata created: ${ordersSnapshot.size} orders counted`);

//   return {
//     totalOrders: ordersSnapshot.size,
//     counts,
//   };
// }

async function initializeAccountMetadata(accountId: string): Promise<{
  totalOrders: number;
  counts: Record<string, number>;
}> {
  console.log(`  📊 Counting orders for account: ${accountId}`);

  const snapshot = await db.collection("accounts").doc(accountId).collection("orders").get();

  const counts: Record<string, number> = {
    "All Orders": 0,
    New: 0,
    Confirmed: 0,
    "Ready To Dispatch": 0,
    Dispatched: 0,
    "In Transit": 0,
    "Out For Delivery": 0,
    Delivered: 0,
    "RTO In Transit": 0,
    "RTO Delivered": 0,
    "DTO Requested": 0,
    "DTO Booked": 0,
    "DTO In Transit": 0,
    "DTO Delivered": 0,
    "Pending Refunds": 0,
    "DTO Refunded": 0,
    Lost: 0,
    Closed: 0,
    "RTO Processed": 0,
    "RTO Closed": 0,
    "Cancellation Requested": 0,
    Cancelled: 0,
  };

  snapshot.docs.forEach((doc) => {
    const order = doc.data();
    counts["All Orders"]++;

    const isShopifyCancelled = !!order.raw?.cancelled_at && order?.customStatus === "Cancelled";

    if (isShopifyCancelled) {
      counts["Cancelled"]++;
    } else {
      const status = order.customStatus || "New";
      if (counts[status] !== undefined) {
        counts[status]++;
      } else {
        console.warn(`⚠️ Unknown status: ${status}`);
      }
    }
  });

  const adminRef = db
    .collection("accounts")
    .doc(accountId)
    .collection("metadata")
    .doc("orderCounts");

  await adminRef.set(
    {
      counts,
      lastUpdated: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  console.log(`  ✅ Metadata created: ${counts["All Orders"]} orders counted`);

  return {
    totalOrders: counts["All Orders"],
    counts,
  };

  // const counts: Record<string, number> = {
  //   "All Orders": 0,
  //   New: 0,
  //   Confirmed: 0,
  //   "Ready To Dispatch": 0,
  //   Dispatched: 0,
  //   "In Transit": 0,
  //   "Out For Delivery": 0,
  //   Delivered: 0,
  //   "RTO In Transit": 0,
  //   "RTO Delivered": 0,
  //   "DTO Requested": 0,
  //   "DTO Booked": 0,
  //   "DTO In Transit": 0,
  //   "DTO Delivered": 0,
  //   "Pending Refunds": 0,
  //   "DTO Refunded": 0,
  //   Lost: 0,
  //   Closed: 0,
  //   "RTO Processed": 0,
  //   "RTO Closed": 0,
  //   "Cancellation Requested": 0,
  //   Cancelled: 0,
  // };

  // const snapshot = await db
  //   .collection("accounts")
  //   .doc(accountId)
  //   .collection("orders")
  //   .where("vendors", "array-contains", "ENDORA")
  //   .get();

  // snapshot.docs.forEach((doc) => {
  //   const order = doc.data();
  //   counts["All Orders"]++;

  //   const isShopifyCancelled = !!order.raw?.cancelled_at && order?.customStatus === "Cancelled";

  //   if (isShopifyCancelled) {
  //     counts["Cancelled"]++;
  //   } else {
  //     const status = order.customStatus || "New";
  //     if (counts[status] !== undefined) {
  //       counts[status]++;
  //     } else {
  //       console.warn(`⚠️ Unknown status: ${status}`);
  //     }
  //   }
  // });

  // // Save counts to the OWR member only
  // const owrMemberSnapshot = await db
  //   .collection("accounts")
  //   .doc(accountId)
  //   .collection("members")
  //   .where("vendorName", "==", "ENDORA")
  //   .get();

  // if (!owrMemberSnapshot.empty) {
  //   await owrMemberSnapshot.docs[0].ref.set(
  //     {
  //       counts,
  //       lastUpdated: FieldValue.serverTimestamp(),
  //     },
  //     { merge: true },
  //   );
  //   console.log(`  ✅ Metadata saved to OWR member`);
  // } else {
  //   console.warn(`  ⚠️ No OWR member found for account ${accountId}`);
  // }

  // console.log(`  ✅ Metadata created: ${counts["All Orders"]} orders counted`);

  // return {
  //   totalOrders: counts["All Orders"],
  //   counts,
  // };

  // const vendorsToMatch = ["OWR", "Ghamand", "BBB"];
  // const seenOrders = new Set<string>();

  // const counts: Record<string, number> = {
  //   "All Orders": 0,
  //   New: 0,
  //   Confirmed: 0,
  //   "Ready To Dispatch": 0,
  //   Dispatched: 0,
  //   "In Transit": 0,
  //   "Out For Delivery": 0,
  //   Delivered: 0,
  //   "RTO In Transit": 0,
  //   "RTO Delivered": 0,
  //   "DTO Requested": 0,
  //   "DTO Booked": 0,
  //   "DTO In Transit": 0,
  //   "DTO Delivered": 0,
  //   "Pending Refunds": 0,
  //   "DTO Refunded": 0,
  //   Lost: 0,
  //   Closed: 0,
  //   "RTO Processed": 0,
  //   "RTO Closed": 0,
  //   "Cancellation Requested": 0,
  //   Cancelled: 0,
  // };

  // // Run one query per vendor (stream + dedupe)
  // for (const vendor of vendorsToMatch) {
  //   const snapshot = await db
  //     .collection("accounts")
  //     .doc(accountId)
  //     .collection("orders")
  //     .where("vendors", "array-contains", vendor)
  //     .get();

  //   snapshot.docs.forEach((doc) => {
  //     if (seenOrders.has(doc.id)) return;
  //     seenOrders.add(doc.id);

  //     const order = doc.data();
  //     counts["All Orders"]++;

  //     const isShopifyCancelled = !!order.raw?.cancelled_at && order?.customStatus === "Cancelled";

  //     if (isShopifyCancelled) {
  //       counts["Cancelled"]++;
  //     } else {
  //       const status = order.customStatus || "New";
  //       if (counts[status] !== undefined) {
  //         counts[status]++;
  //       } else {
  //         console.warn(`⚠️ Unknown status: ${status}`);
  //       }
  //     }
  //   });
  // }

  // // Save counts to the OWR member only
  // const owrMemberSnapshot = await db
  //   .collection("accounts")
  //   .doc(accountId)
  //   .collection("members")
  //   // .where("vendorName", "==", "OWR")
  //   .get();

  // if (!owrMemberSnapshot.empty) {
  //   await owrMemberSnapshot.docs[0].ref.set(
  //     {
  //       counts,
  //       lastUpdated: FieldValue.serverTimestamp(),
  //     },
  //     { merge: true },
  //   );
  //   console.log(`  ✅ Metadata saved to OWR member`);
  // } else {
  //   console.warn(`  ⚠️ No OWR member found for account ${accountId}`);
  // }

  // console.log(`  ✅ Metadata created: ${counts["All Orders"]} orders counted`);

  // return {
  //   totalOrders: counts["All Orders"],
  //   counts,
  // };
}

export const initializeMetadata = onRequest(
  {
    cors: true,
    timeoutSeconds: 3600,
    memory: "1GiB",
    secrets: [ENQUEUE_FUNCTION_SECRET],
  },
  async (req, res): Promise<void> => {
    try {
      // Validate secret
      requireHeaderSecret(req, "x-api-key", ENQUEUE_FUNCTION_SECRET.value() || "");

      console.log("🚀 Starting Order Counts Metadata Initialization...\n");

      const stats: InitializeStats = {
        accountsProcessed: 0,
        totalOrders: 0,
        metadataCreated: 0,
        errors: 0,
      };

      try {
        // Get all accounts
        const accountsSnapshot = await db.collection("accounts").get();
        console.log(`Found ${accountsSnapshot.size} accounts to process\n`);

        // Process each account
        for (const accountDoc of accountsSnapshot.docs) {
          const accountId = accountDoc.id;
          console.log(`\n📦 Processing account: ${accountId}`);

          try {
            const result = await initializeAccountMetadata(accountId);
            stats.accountsProcessed++;
            stats.totalOrders += result.totalOrders;
            stats.metadataCreated++;

            console.log(`  ✅ Account completed: ${result.totalOrders} orders`);
          } catch (error) {
            stats.errors++;
            console.error(`  ❌ Error processing account ${accountId}:`, error);
          }

          // Small delay between accounts
          await sleep(100);
        }

        // Print final summary
        console.log("\n" + "=".repeat(60));
        console.log("📊 INITIALIZATION SUMMARY");
        console.log("=".repeat(60));
        console.log(`Accounts processed:   ${stats.accountsProcessed}`);
        console.log(`Total orders counted: ${stats.totalOrders}`);
        console.log(`Metadata created:     ${stats.metadataCreated}`);
        console.log(`Errors:               ${stats.errors}`);
        console.log("=".repeat(60));
        console.log("✨ Initialization completed!\n");

        res.json({
          success: true,
          summary: stats,
          message: "Metadata initialization completed successfully",
        });
      } catch (error) {
        console.error("\n❌ Initialization failed:", error);
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          stats,
        });
      }
    } catch (authError) {
      res.status(401).json({ error: `Unauthorized ${authError}` });
    }
  },
);
