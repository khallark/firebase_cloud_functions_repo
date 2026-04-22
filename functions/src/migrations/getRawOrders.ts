import { onRequest } from "firebase-functions/v2/https";
import { SHARED_STORE_ID_2 } from "../config";
import { db } from "../firebaseAdmin";

export const getRawOrders = onRequest(
  { cors: true, timeoutSeconds: 3600, memory: "4GiB" },
  async (req, res) => {
    try {
      const limit = 1500;

      const startAfterName = req.query.startAfterName as string | undefined;
      const startAfterId = req.query.startAfterId as string | undefined;

      let query = db
        .collection("accounts")
        .doc(SHARED_STORE_ID_2)
        .collection("products")
        .orderBy("__name__", "desc") // 🔥 tie-breaker
        .limit(limit);

      // 🔥 Apply cursor if present
      if (startAfterName && startAfterId) {
        query = query.startAfter(startAfterName, startAfterId);
      }

      const snap = await query.get();

      const data = snap.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
      }));

      const lastDoc = snap.docs[snap.docs.length - 1];

      const nextCursor = lastDoc
        ? {
            name: lastDoc.data().name,
            id: lastDoc.id,
          }
        : null;

      res.json({
        count: data.length,
        data,
        nextCursor,
      });
    } catch (error: any) {
      console.error(error);
      res.status(500).json({
        error: error.message || "Internal Server Error",
      });
    }
  }
);