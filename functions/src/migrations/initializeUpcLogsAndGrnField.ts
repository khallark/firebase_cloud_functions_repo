import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firebaseAdmin";
import { Timestamp } from "firebase-admin/firestore";

const BUSINESS_ID = "2yEGCC8AffNxDoTZEqhAkCRgxNl2";

export const initializeUpcLogsAndGrnField = onRequest(
    {
        cors: true,
        timeoutSeconds: 3600,
        memory: "1GiB",
    },
    async (req, res) => {
        try {
            const upcsRef = db.collection(`users/${BUSINESS_ID}/upcs`);
            const upcsSnapshot = await upcsRef.get();

            if (upcsSnapshot.empty) {
                res.json({ success: true, message: "No UPCs found", processed: 0 });
                return;
            }

            console.log(`Found ${upcsSnapshot.size} UPCs. Starting migration...`);

            const results = {
                total: upcsSnapshot.size,
                grnFieldAdded: 0,
                logsInitialized: 0,
                logsSkipped: 0,
                errors: [] as { upcId: string; error: string }[],
            };

            for (const upcDoc of upcsSnapshot.docs) {
                const upcId = upcDoc.id;
                const upcData = upcDoc.data();

                try {
                    // --------------------------------------------------------
                    // 1. Add grnRef: null to every UPC doc (skip if already set)
                    // --------------------------------------------------------
                    if (!("grnRef" in upcData)) {
                        await upcDoc.ref.update({ grnRef: null });
                        results.grnFieldAdded++;
                        console.log(`  ✓ Added grnRef to UPC ${upcId}`);
                    }

                    // --------------------------------------------------------
                    // 2. Initialize logs only if the logs subcollection is empty
                    // --------------------------------------------------------
                    const logsRef = upcDoc.ref.collection("logs");
                    const logsSnapshot = await logsRef.limit(1).get();

                    if (!logsSnapshot.empty) {
                        console.log(`  ⏭️ UPC ${upcId} already has logs, skipping`);
                        results.logsSkipped++;
                        continue;
                    }

                    const snapshot = {
                        putAway: upcData.putAway ?? null,
                        warehouseId: upcData.warehouseId ?? null,
                        zoneId: upcData.zoneId ?? null,
                        rackId: upcData.rackId ?? null,
                        shelfId: upcData.shelfId ?? null,
                        placementId: upcData.placementId ?? null,
                        storeId: upcData.storeId ?? null,
                        orderId: upcData.orderId ?? null,
                    };

                    // Use updatedAt as the log timestamp so it reflects actual history
                    // rather than the time this migration ran
                    const timestamp =
                        upcData.updatedAt instanceof Timestamp ? upcData.updatedAt : Timestamp.now();

                    await logsRef.add({ timestamp, snapshot });

                    results.logsInitialized++;
                    console.log(`  ✓ Initialized log for UPC ${upcId}`);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    console.error(`  ✗ Error processing UPC ${upcId}:`, message);
                    results.errors.push({ upcId, error: message });
                }
            }

            console.log("Migration complete:", results);

            res.json({
                success: true,
                ...results,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error("Migration failed:", message);
            res.status(500).json({ success: false, error: message });
        }
    },
);
