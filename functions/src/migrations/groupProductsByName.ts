import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";

export const groupProductsByName = onRequest(
    {
        cors: true,
        timeoutSeconds: 540,
        memory: "512MiB",
    },
    async (req, res) => {
        try {
            const userId = "2yEGCC8AffNxDoTZEqhAkCRgxNl2";

            const productsSnap = await db.collection(`users/${userId}/products`).get();

            const groups: Record<string, string[]> = {};

            let noName = 0;
            let totalChildren = 0;
            for (const productDoc of productsSnap.docs) {
                const sku = productDoc.id;
                const name = productDoc.data().name as string | undefined;

                if (!name) {
                    noName++;
                    continue;
                }

                if (!groups[name]) {
                    groups[name] = [];
                }
                groups[name].push(sku);
                totalChildren++;
            }

            res.status(200).json({ groups, totalProducts: productsSnap.docs.length, noName, totalChildren });
        } catch (error) {
            console.error("Error grouping products by name:", error);
            res.status(500).json({ error: "Internal server error" });
        }
    },
);