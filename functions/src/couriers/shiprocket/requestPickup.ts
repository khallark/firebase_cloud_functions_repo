import { parseJson } from "../../helpers";
import { evaluateShiprocketResponse } from "./responseParser";

export async function requestShiprocketPickup(
  srToken: string,
  shipmentId: string | number,
): Promise<{ success: boolean; error?: string; data?: any }> {
  try {
    const base = "https://apiv2.shiprocket.in";
    const pickupPath = "/v1/external/courier/generate/pickup";

    const pickupResp = await fetch(`${base}${pickupPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${srToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        shipment_id: shipmentId,
      }),
    });

    const pickupText = await pickupResp.text();
    const pickupJson = parseJson(pickupText);

    // Evaluate all responses (both 2xx and non-2xx)
    const verdict = evaluateShiprocketResponse(pickupJson);

    if (!verdict.ok) {
      return {
        success: false,
        error: verdict.message || `HTTP ${pickupResp.status}`,
        data: pickupJson,
      };
    }

    // Success response has pickup_status: 1
    if (pickupJson?.pickup_status === 1) {
      return {
        success: true,
        data: pickupJson,
      };
    }

    // Ambiguous response - no clear error but no success either
    return {
      success: false,
      error: pickupJson?.message || "Unknown pickup error",
      data: pickupJson,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
