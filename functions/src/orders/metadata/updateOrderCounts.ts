// ============================================================================
// BACKGROUND FUNCTION: Auto-Update Order Counts
// ============================================================================

import { FieldValue } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/firestore";
import { db } from "../../firebaseAdmin";
import { SHARED_STORE_ID } from "../../config";

export const updateOrderCounts = onDocumentWritten(
  {
    document: "accounts/{storeId}/orders/{orderId}",
    memory: "256MiB",
  },
  async (event) => {
    const storeId = event.params.storeId;
    const orderId = event.params.orderId;

    console.log(`📝 Order ${orderId} changed in store ${storeId}`);

    const metadataRef = db
      .collection("accounts")
      .doc(storeId)
      .collection("metadata")
      .doc("orderCounts");

    try {
      const change = event.data;
      if (!change) return;

      // ============================================================
      // CASE 1: Order Deleted
      // ============================================================
      if (!change.after.exists) {
        const oldOrder = change.before.data();
        if (!oldOrder) return;

        const oldStatus = oldOrder.customStatus || "New";

        await metadataRef.set(
          {
            counts: {
              "All Orders": FieldValue.increment(-1),
              [oldStatus]: FieldValue.increment(-1),
            },
            lastUpdated: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        console.log(`✅ Decremented count for deleted order (${oldStatus})`);
        return;
      }

      // ============================================================
      // CASE 2: New Order Created
      // ============================================================
      if (!change.before.exists) {
        const newOrder = change.after.data();
        if (!newOrder) return;

        const newStatus = newOrder.customStatus || "New";

        await metadataRef.set(
          {
            counts: {
              "All Orders": FieldValue.increment(1),
              [newStatus]: FieldValue.increment(1),
            },
            lastUpdated: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        console.log(storeId === SHARED_STORE_ID, newOrder.vendors, Array.isArray(newOrder.vendors));

        if (storeId === SHARED_STORE_ID && newOrder.vendors && Array.isArray(newOrder.vendors)) {
          console.log(
            "Shared Store detected, incrementing the 'All Orders' count of vendors too...",
          );
          const vendors = newOrder.vendors;
          for (let i = 0; i < vendors.length; i++) {
            const memberDocQuery = await db
              .collection("accounts")
              .doc(storeId)
              .collection("members")
              .where("vendorName", "==", vendors[i])
              .get();
            console.log(
              `for vendor "${vendors[i]}", ${memberDocQuery.empty ? "document not found" : `document ${memberDocQuery.docs[0].id} found`}`,
            );
            if (!memberDocQuery.empty) {
              console.log(
                `Found vendor ${vendors[i]} with member document id ${memberDocQuery.docs[0].id}, updating 'All Orders' Count...`,
              );
              await memberDocQuery.docs[0].ref.set(
                {
                  counts: {
                    "All Orders": FieldValue.increment(1),
                    [newStatus]: FieldValue.increment(1),
                  },
                  lastUpdated: FieldValue.serverTimestamp(),
                },
                { merge: true },
              );
              console.log(`Vendor ${vendors[i]} Counts updated!`);
            }
          }
        }

        console.log(`✅ Incremented count for new order (${newStatus})`);
        return;
      }

      // ============================================================
      // CASE 3: Order Updated (Status Changed)
      // ============================================================
      const oldOrder = change.before.data();
      const newOrder = change.after.data();

      if (!oldOrder || !newOrder) return;

      const oldStatus = oldOrder.customStatus || "New";
      const newStatus = newOrder.customStatus || "New";

      // If status hasn't changed, do nothing
      if (oldStatus === newStatus) {
        console.log(`⏭️ No status change for order ${orderId}, skipping`);
        return;
      }

      // Update counts atomically
      const updates: any = {
        lastUpdated: FieldValue.serverTimestamp(),
        [`counts.${oldStatus}`]: FieldValue.increment(-1),
        [`counts.${newStatus}`]: FieldValue.increment(1),
      };

      await metadataRef.update(updates);

      console.log(storeId === SHARED_STORE_ID, newOrder.vendors, Array.isArray(newOrder.vendors));

      if (storeId === SHARED_STORE_ID && newOrder.vendors && Array.isArray(newOrder.vendors)) {
        console.log("Shared Store detected, updating count of vendors too...");
        const vendors = newOrder.vendors;
        for (let i = 0; i < vendors.length; i++) {
          const memberDocQuery = await db
            .collection("accounts")
            .doc(storeId)
            .collection("members")
            .where("vendorName", "==", vendors[i])
            .get();
          console.log(
            `for vendor "${vendors[i]}", ${memberDocQuery.empty ? "document not found" : `document ${memberDocQuery.docs[0].id} found`}`,
          );
          if (!memberDocQuery.empty) {
            console.log(
              `Found vendor ${vendors[i]} with member document id ${memberDocQuery.docs[0].id}, updating counts...`,
            );
            await memberDocQuery.docs[0].ref.update(updates);
            console.log(`Vendor ${vendors[i]} Counts updated!`);
          }
        }
      }

      console.log(`✅ Updated counts: ${oldStatus} → ${newStatus}`);
    } catch (error) {
      console.error(`❌ Error updating counts for ${storeId}:`, error);

      // If metadata doesn't exist, log warning
      if ((error as any).code === "not-found") {
        console.error(
          `⚠️ Metadata not found for ${storeId}. Please run initializeMetadata function first.`,
        );
      }
    }
  },
);
