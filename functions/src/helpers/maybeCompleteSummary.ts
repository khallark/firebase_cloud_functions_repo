import { DocumentReference, FieldValue, Transaction } from "firebase-admin/firestore";
import { db } from "../firebaseAdmin";

export async function maybeCompleteSummary(summaryRef: DocumentReference) {
  await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(summaryRef);
    if (!snap.exists) return;
    const d = snap.data() as any;
    const total = d.total ?? 0;
    const done = (d.success ?? 0) + (d.failed ?? 0);
    const processing = d.processing ?? 0;

    if (done >= total && processing === 0 && d.status !== "complete") {
      tx.update(summaryRef, { status: "complete", completedAt: FieldValue.serverTimestamp() });
    }
  });
}
