// services/awb/awbService.ts

import { db } from "../../firebaseAdmin";

/**
 * Allocates one AWB from the business's unused AWB pool
 * Removes the AWB from unused_awbs collection
 *
 * @param businessId - The business ID (userId)
 * @returns The allocated AWB string
 * @throws Error if no AWB is available
 */
export async function allocateAwb(businessId: string): Promise<string> {
  const coll = db.collection("users").doc(businessId).collection("unused_awbs").limit(1);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(coll);
    if (snap.empty) {
      throw new Error("NO_AWB_AVAILABLE");
    }

    const doc = snap.docs[0];
    const awb = doc.id;
    tx.delete(doc.ref);

    return awb;
  });
}

/**
 * Releases an AWB back to the business's unused AWB pool
 * Used when shipment creation fails and AWB needs to be returned
 *
 * @param businessId - The business ID (userId)
 * @param awb - The AWB to release
 */
export async function releaseAwb(businessId: string, awb: string): Promise<void> {
  await db.collection("users").doc(businessId).collection("unused_awbs").doc(awb).set(
    {
      status: "unused",
      createdAt: new Date(),
    },
    { merge: true },
  );
}
