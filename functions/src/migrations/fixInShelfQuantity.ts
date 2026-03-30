import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";

export const fixInShelfQuantity = onRequest(
  {
    cors: true,
    timeoutSeconds: 3600,
    memory: "4GiB",
  },
  async (req, res) => {
    try {
      const { dryRun }: { dryRun: boolean } = req.body;
      const userId = "2yEGCC8AffNxDoTZEqhAkCRgxNl2";

      const productsSnap = await db.collection(`users/${userId}/products`).get();

      const updates: {
        sku: string;
        oldInShelfQuantity: number;
        newInShelfQuantity: number;
      }[] = [];

      // Firestore batch limit is 500 — use multiple batches
      let batch = db.batch();
      let batchCount = 0;

      for (const productDoc of productsSnap.docs) {
        const sku = productDoc.id;
        const oldInShelfQuantity = productDoc.data().inShelfQuantity ?? 0;

        const upcsSnap = await db
          .collection(`users/${userId}/upcs`)
          .where("productId", "==", sku)
          .where("putAway", "==", "none")
          .get();

        const newInShelfQuantity = upcsSnap.size;

        if (oldInShelfQuantity !== newInShelfQuantity) {
          updates.push({ sku, oldInShelfQuantity, newInShelfQuantity });
          batch.update(productDoc.ref, { inShelfQuantity: newInShelfQuantity });
          batchCount++;

          // Commit and start a new batch before hitting the 500 limit
          if (batchCount === 499) {
            if(!dryRun) await batch.commit();
            batch = db.batch();
            batchCount = 0;
          }
        }
      }

      // Commit any remaining updates
      if (batchCount > 0) {
        await batch.commit();
      }

      res.status(200).json({
        updated: updates.length,
        updates,
      });
    } catch (error) {
      console.error("Error fixing inShelfQuantity:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);