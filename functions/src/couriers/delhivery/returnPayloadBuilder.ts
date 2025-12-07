// couriers/delhivery/returnPayloadBuilder.ts

import { normalizePhoneNumber } from "../../helpers";

interface DelhiveryReturnShipmentParams {
  orderId: string;
  awb: string;
  order: any;
  pickupName: string;
  shippingMode?: string;
}

/**
 * Builds Delhivery return shipment payload
 * Used for RTO (Return to Origin) shipments
 */
export function buildDelhiveryReturnPayload(params: DelhiveryReturnShipmentParams): any {
  const { awb, order, pickupName, shippingMode } = params;

  const addr = order.raw?.shipping_address ||
    order.raw?.billing_address || {
      name: undefined,
      first_name: undefined,
      last_name: undefined,
      address1: undefined,
      address2: undefined,
      city: undefined,
      province: undefined,
      country: "India",
      zip: undefined,
      phone: order.phone,
    };

  const consigneeName =
    addr?.name ||
    [addr?.first_name, addr?.last_name].filter(Boolean).join(" ").trim() ||
    "Customer";

  const addLine = [addr?.address1, addr?.address2].filter(Boolean).join(", ");
  const phone = addr?.phone || order.phone || "";
  const city = addr?.city || "";
  const state = addr?.province || "";
  const country = addr?.country || "India";
  const pin = addr?.zip || "";

  // Get line items
  const lineItems: any[] = Array.isArray(order.raw?.line_items) ? order.raw.line_items : [];

  // Check if returnItemsVariantIds exists in order
  let selected: any[];

  if (Array.isArray(order.returnItemsVariantIds) && order.returnItemsVariantIds.length > 0) {
    // Filter by returnItemsVariantIds
    const variantIdSet = new Set(order.returnItemsVariantIds.map((x: any) => String(x)));
    selected = lineItems.filter((li) => variantIdSet.has(String(li.variant_id)));

    if (selected.length === 0) {
      throw new Error("NO_ITEMS_MATCH_RETURN_VARIANT_IDS");
    }
  } else {
    // Include all line items
    selected = lineItems;

    if (selected.length === 0) {
      throw new Error("NO_LINE_ITEMS_IN_ORDER");
    }
  }

  const products_desc = selected
    .map((li) => {
      const name = li?.name || li?.title || "Item";
      const qty = Number(li?.quantity ?? 1);
      return `${name} x ${qty}`;
    })
    .join(", ")
    .slice(0, 500);

  const totalQty = selected.reduce((sum, li) => sum + (li.quantity ?? 1), 0);

  const totalWeightGm = order?.raw?.total_weight;
  const weightField = totalWeightGm ? String(totalWeightGm) : "250";

  const shipment: any = {
    name: consigneeName,
    add: addLine,
    pin,
    city,
    state,
    country,
    phone: normalizePhoneNumber(phone),
    order: String(order.name || order.raw?.name),
    payment_mode: "Pickup",
    return_pin: "",
    return_city: "",
    return_phone: "",
    return_add: "",
    return_state: "",
    return_country: "",
    products_desc,
    hsn_code: "",
    cod_amount: "",
    order_date: null,
    total_amount: "",
    seller_add: "",
    seller_name: "",
    seller_inv: "",
    quantity: String(totalQty),
    waybill: String(awb),
    shipment_width: "10",
    shipment_height: "10",
    shipment_length: "10",
    weight: weightField,
    address_type: "",
  };

  if (shippingMode) {
    shipment.shipping_mode = shippingMode;
  }

  return {
    shipments: [shipment],
    pickup_location: { name: pickupName },
  };
}
