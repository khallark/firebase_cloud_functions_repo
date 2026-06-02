import { onRequest } from "firebase-functions/v2/https";
import { db } from "../../firebaseAdmin";
import { normalizePhoneNumber } from "../../helpers";

// ─── Constants ───────────────────────────────────────────────────────────────

const RTO_STATUSES = ["RTO In Transit", "RTO Delivered", "RTO Closed"];

const isEliminationStatus = (status: unknown): boolean => {
    if (typeof status !== "string") return false;

    return (
        status === "Delivered" ||
        status === "Closed" ||
        status === "Pending Refunds" ||
        status.includes("DTO")
    );
};

function getOrderPhone(order: any): string | null {
    const phone = order?.raw?.shipping_address?.phone;

    if (typeof phone !== "string") return null;

    const trimmed = phone.trim();

    return trimmed || null;
}

function toMillis(value: any): number {
    if (!value) return 0;

    if (typeof value === "number") return value;

    if (value instanceof Date) return value.getTime();

    if (
        typeof value === "object" &&
        value !== null &&
        typeof value.toDate === "function"
    ) {
        return value.toDate().getTime();
    }

    if (typeof value === "string") {
        const time = new Date(value).getTime();
        return Number.isNaN(time) ? 0 : time;
    }

    return 0;
}

async function getLatestOrderForPhoneAcrossShops(shopIds: string[], rawPhone: string) {
    const snapshots = await Promise.all(
        shopIds.map((shopId) =>
            db
                .collection("accounts")
                .doc(shopId)
                .collection("orders")
                .where("raw.shipping_address.phone", "==", rawPhone)
                .get()
        )
    );

    let latestOrder: any = null;
    let latestTime = 0;

    for (const snapshot of snapshots) {
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const time = toMillis(data.newAt);

            if (!latestOrder || time > latestTime) {
                latestOrder = data;
                latestTime = time;
            }
        }
    }

    return latestOrder;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export const generateCodBanList = onRequest(
    {
        cors: true,
        timeoutSeconds: 540,
        memory: "1GiB",
    },
    async (req, res) => {
        try {
            const { shopIds } = req.body as {
                shopIds: string[];
            };

            if (
                !shopIds ||
                !Array.isArray(shopIds) ||
                !shopIds.length ||
                !shopIds.every((item) => typeof item === "string" && item.trim())
            ) {
                res.status(400).json({
                    error: "Invalid data. The shopIds parameter must be a non-empty array of strings.",
                });
                return;
            }

            const cleanShopIds = [...new Set(shopIds.map((shopId) => shopId.trim()))];

            /**
             * 1. Get all RTO orders.
             */
            const rtoSnapshots = await Promise.all(
                cleanShopIds.map((shopId) =>
                    db
                        .collection("accounts")
                        .doc(shopId)
                        .collection("orders")
                        .where("customStatus", "in", RTO_STATUSES)
                        .get()
                )
            );

            const rtoOrdersWithShop = rtoSnapshots.flatMap((snapshot, index) => {
                const shopId = cleanShopIds[index];

                return snapshot.docs.map((doc) => ({
                    shopId,
                    orderId: doc.id,
                    data: doc.data(),
                }));
            });

            /**
             * 2. Get all unique raw phone numbers from RTO orders.
             * Not normalized here, because these raw values are used for Firestore query.
             */
            const uniqueRawPhones = [
                ...new Set(
                    rtoOrdersWithShop
                        .map((order) => getOrderPhone(order.data))
                        .filter((phone): phone is string => !!phone)
                ),
            ];

            /**
             * 3. For each raw phone number, get the latest order.
             * If latest order is Delivered / Closed / DTO* / Pending Refunds,
             * eliminate that number from the ban list.
             */
            const culpritNormalizedNumbers = new Set<string>();

            for (const rawPhone of uniqueRawPhones) {
                const latestOrder = await getLatestOrderForPhoneAcrossShops(
                    cleanShopIds,
                    rawPhone
                );

                if (!latestOrder) continue;

                const latestStatus = latestOrder.customStatus;

                if (isEliminationStatus(latestStatus)) {
                    continue;
                }

                const normalizedPhone = normalizePhoneNumber(rawPhone);

                if (normalizedPhone) {
                    culpritNormalizedNumbers.add(normalizedPhone);
                }
            }

            const banList = [...culpritNormalizedNumbers];

            res.status(200).json({
                success: true,
                totalRtoOrders: rtoOrdersWithShop.length,
                uniqueRawPhones: uniqueRawPhones.length,
                banListCount: banList.length,
                banList,
            });
        } catch (error: unknown) {
            console.error("generateCodBanList failed:", error);

            res.status(500).json({
                error: "Internal server error.",
                details: error instanceof Error ? error.message : String(error),
            });
        }
    }
);