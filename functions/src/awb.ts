// functions/src/awb.ts
import { db } from "./firebaseAdmin";

/** Pops one AWB from accounts/{shop}/unused_awbs by deleting the first doc. */
export async function allocateAwb(shop: string): Promise<string> {
  const coll = db.collection("accounts").doc(shop).collection("unused_awbs").limit(1);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(coll);
    if (snap.empty) throw new Error("NO_AWB_AVAILABLE");
    const doc = snap.docs[0];
    const awb = doc.id;
    tx.delete(doc.ref); // or tx.update(doc.ref, { status: "used" })
    return awb;
  });
}

/** Optionally push AWB back if you want strict accounting on failures. */
export async function releaseAwb(shop: string, awb: string) {
  await db
    .collection("accounts")
    .doc(shop)
    .collection("unused_awbs")
    .doc(awb)
    .set({ status: "unused", createdAt: new Date() }, { merge: true });
}
