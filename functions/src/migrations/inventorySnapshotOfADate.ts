import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";

interface MappedVariant {
  productId: string;
  storeId: string;
  variantId: number;
  variantSku: string;
}

export const inventorySnapshotOfADate = onRequest(
  {
    cors: true,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    try {
      const snap = await db
        .collection("users/2yEGCC8AffNxDoTZEqhAkCRgxNl2/inventory_snapshots")
        .where("date", "==", "2026-02-15")
        .get();

      const result = await Promise.all(
        snap.docs.map(async (doc) => {
          const data = doc.data();
          const mappedVariants: MappedVariant[] = data.exactDocState?.mappedVariants ?? [];

          const targetVariant = mappedVariants.find((v) => v.storeId === "gj9ejg-cu.myshopify.com");

          let variantSku: string | null = targetVariant?.variantSku ?? null;
          let price: number | null = null;

          if (targetVariant) {
            try {
              const productDoc = await db
                .doc(`accounts/${targetVariant.storeId}/products/${targetVariant.productId}`)
                .get();

              if (productDoc.exists) {
                const variants: { id: number; price: number }[] = productDoc.data()?.variants ?? [];

                const matchedVariant = variants.find((v) => v.id === targetVariant.variantId);
                price = matchedVariant?.price ?? null;
              }
            } catch (err) {
              console.error(
                `Error fetching product for productId=${targetVariant.productId}:`,
                err,
              );
            }
          }

          return {
            productSku: data.productId as string,
            stock: data.stockLevel as number,
            variantSku,
            price,
          };
        }),
      );

      result.sort((a, b) => a.productSku.localeCompare(b.productSku));

      res.status(200).json({ result });
    } catch (error) {
      console.error("Error fetching inventory snapshots:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
