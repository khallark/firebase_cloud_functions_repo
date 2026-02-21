import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";

interface Inventory {
  autoAddition: number;
  autoDeduction: number;
  blockedStock: number;
  deduction: number;
  inwardAddition: number;
  openingStock: number;
}

export const checkWarehouseInventoryDiffs = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    try {
      const userId = "2yEGCC8AffNxDoTZEqhAkCRgxNl2";

      const productsSnap = await db.collection(`users/${userId}/products`).get();

      const diffs: {
        sku: string;
        inventoryValue: number;
        upcCount: number;
      }[] = [];

      for (const productDoc of productsSnap.docs) {
        const sku = productDoc.id;
        const inventory = productDoc.data().inventory as Inventory;

        const inventoryValue =
          inventory.openingStock +
          inventory.inwardAddition -
          inventory.deduction +
          inventory.autoAddition -
          inventory.autoDeduction;

        const upcsSnap = await db
          .collection(`users/${userId}/upcs`)
          .where("productId", "==", sku)
          .get();

        const upcCount = upcsSnap.docs.filter((upcDoc) => {
          const putAway = upcDoc.data().putAway as "none" | "outbound" | "inbound" | null;
          return putAway === "none" || putAway === "inbound" || putAway === "outbound";
        }).length;

        if (inventoryValue !== upcCount) {
          diffs.push({ sku, inventoryValue, upcCount });
        }
      }

      res.status(200).json({ diffs });
    } catch (error) {
      console.error("Error checking warehouse inventory diffs:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
