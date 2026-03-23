import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { DocumentReference, FieldValue } from "firebase-admin/firestore";

export const correctGrnUnitCosts = onRequest(
  { cors: true, timeoutSeconds: 540, memory: "1GiB" },
  async (req, res) => {
    const businessId = (req.query.businessId as string) || req.body?.businessId;
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;

    if (!businessId) {
      res.status(400).json({ error: "businessId is required" });
      return;
    }

    // ── 1. Fetch all completed GRNs ──────────────────────────────────────
    const grnsSnap = await db
      .collection(`users/${businessId}/grns`)
      .where("status", "==", "completed")
      .get();

    console.log(`Found ${grnsSnap.size} completed GRNs`);

    // ── 2. Collect all unique SKUs across all GRNs ───────────────────────
    const allSkus = new Set<string>();
    for (const doc of grnsSnap.docs) {
      for (const item of doc.data().items ?? []) {
        if (item.sku) allSkus.add(item.sku);
      }
    }

    // ── 3. Fetch all product prices in parallel ──────────────────────────
    const skuList = Array.from(allSkus);
    const productDocs = await Promise.all(
      skuList.map((sku) => db.doc(`users/${businessId}/products/${sku}`).get()),
    );

    const pricesBySku = new Map<string, number>();
    for (let i = 0; i < skuList.length; i++) {
      const doc = productDocs[i];
      if (doc.exists) {
        const price = Number(doc.data()?.price ?? 0);
        if (price > 0) pricesBySku.set(skuList[i], price);
      }
    }

    console.log(`Resolved prices for ${pricesBySku.size}/${skuList.length} SKUs`);

    // ── 4. Compute updates ───────────────────────────────────────────────
    let updatedGrnCount = 0;
    let skippedGrnCount = 0;
    let missingPriceSkus = new Set<string>();

    const updates: Array<{ ref: DocumentReference; items: any[]; totalReceivedValue: number }> = [];

    for (const doc of grnsSnap.docs) {
      const grn = doc.data();
      const items: any[] = grn.items ?? [];
      let changed = false;

      const updatedItems = items.map((item) => {
        const sku = item.sku as string;
        const price = pricesBySku.get(sku);

        if (price === undefined) {
          missingPriceSkus.add(sku);
          return item; // leave unchanged
        }

        const newUnitCost = price;
        const newTotalCost = Math.round(newUnitCost * Number(item.receivedQty ?? 0) * 100) / 100;

        if (newUnitCost !== Number(item.unitCost) || newTotalCost !== Number(item.totalCost)) {
          changed = true;
          return { ...item, unitCost: newUnitCost, totalCost: newTotalCost };
        }

        return item;
      });

      if (!changed) {
        skippedGrnCount++;
        continue;
      }

      const newTotalReceivedValue =
        Math.round(updatedItems.reduce((sum, item) => sum + Number(item.totalCost ?? 0), 0) * 100) /
        100;

      updates.push({
        ref: doc.ref,
        items: updatedItems,
        totalReceivedValue: newTotalReceivedValue,
      });
      updatedGrnCount++;
    }

    // ── 5. Write in batches of 499 ───────────────────────────────────────
    if (!dryRun) {
      const BATCH_SIZE = 499;
      for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        const batch = db.batch();
        for (const { ref, items, totalReceivedValue } of updates.slice(i, i + BATCH_SIZE)) {
          batch.update(ref, {
            items,
            totalReceivedValue,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        await batch.commit();
        console.log(`Committed batch ${Math.floor(i / BATCH_SIZE) + 1}`);
      }
    }

    res.status(200).json({
      dryRun,
      totalGrns: grnsSnap.size,
      updatedGrns: updatedGrnCount,
      skippedGrns: skippedGrnCount,
      missingPriceSkus: Array.from(missingPriceSkus),
    });
  },
);
