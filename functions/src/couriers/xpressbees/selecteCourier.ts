/**
 * Fetch Xpressbees courier list and select appropriate courier based on mode and weight
 */
export async function selectCourier(
  token: string,
  shippingMode: string,
  totalQuantity: number,
): Promise<string> {
  try {
    const resp = await fetch("https://shipment.xpressbees.com/api/courier", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!resp.ok) {
      throw new Error(`Failed to fetch couriers: HTTP ${resp.status}`);
    }

    const result = (await resp.json()) as any;
    if (!result?.status || !Array.isArray(result?.data)) {
      throw new Error("Invalid courier list response");
    }

    const couriers = result.data as Array<{ id: string; name: string }>;

    // For Express mode: Select "Air Xpressbees 0.5 K.G"
    if (shippingMode === "Express") {
      const airCourier = couriers.find((c) => c.name.toLowerCase().includes("air"));
      if (airCourier) return airCourier.id;
      throw new Error("No Air courier found for Express mode");
    }

    // For Surface mode: Calculate weight and select based on weight
    const totalWeightGrams = totalQuantity * 250;
    const totalWeightKg = totalWeightGrams / 1000;

    // Extract weight from courier names and sort by weight
    // Expected format: "Surface Xpressbees 0.5 K.G", "Xpressbees 1 K.G", etc.
    const surfaceCouriers = couriers
      .filter((c) => {
        const nameLower = c.name.toLowerCase();
        return (
          (nameLower.includes("surface") || nameLower.includes("xpressbees")) &&
          !nameLower.includes("air") &&
          !nameLower.includes("express") &&
          !nameLower.includes("reverse") &&
          !nameLower.includes("same day") &&
          !nameLower.includes("next day")
        );
      })
      .map((c) => {
        // Extract weight value from name (e.g., "0.5", "1", "2", "5", "10")
        const weightMatch = c.name.match(/(\d+(?:\.\d+)?)\s*k\.?g/i);
        const weight = weightMatch ? parseFloat(weightMatch[1]) : 0;
        return { ...c, weight };
      })
      .filter((c) => c.weight > 0)
      .sort((a, b) => a.weight - b.weight);

    if (surfaceCouriers.length === 0) {
      throw new Error("No Surface couriers found");
    }

    // Select the smallest courier that can handle the weight
    // If weight exceeds all options, select the largest
    let selectedCourier = surfaceCouriers[surfaceCouriers.length - 1]; // default to largest

    for (const courier of surfaceCouriers) {
      if (totalWeightKg <= courier.weight) {
        selectedCourier = courier;
        break;
      }
    }

    return selectedCourier.id;
  } catch (error) {
    console.error("Courier selection error:", error);
    throw new Error(
      `COURIER_SELECTION_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
