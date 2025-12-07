// couriers/delhivery/payloadBuilder.ts

import { normalizePhoneNumber } from "../../helpers";

interface DelhiveryShipmentParams {
  orderId?: string;
  awb: string;
  order: any;
  pickupName: string;
  shippingMode: string;
}

/**
 * Builds Delhivery shipment creation payload from order data
 * Maps order document to Delhivery's flat schema
 */
export function buildDelhiveryPayload(params: DelhiveryShipmentParams) {
  const { awb, order, pickupName, shippingMode } = params;

  const ship =
    order?.raw?.shipping_address || order?.shipping_address || order?.shippingAddress || {};

  const paid = !Number(order.raw.total_outstanding);
  const items =
    (Array.isArray(order?.raw?.line_items) && order.raw.line_items) || order?.lineItems || [];

  const products_desc = items.length
    ? items
        .map((it: any) => {
          const name = it?.name || it?.title || "Item";
          const qty = Number(it?.quantity ?? it?.qty ?? 1);
          return `${name} x ${qty}`;
        })
        .join(", ")
        .slice(0, 500)
    : "";

  const quantity = items.reduce(
    (n: number, it: any) => n + Number(it?.quantity ?? it?.qty ?? 0),
    0,
  );

  let total = Number(order.raw.total_price);
  let cod = Number(order.raw.total_outstanding);

  const _ = (v: any) => (v === undefined || v === null ? "" : String(v));

  const shipment = {
    name: _(
      order?.raw?.billing_address?.name ||
        ship?.name ||
        order?.raw?.customer?.default_address?.name ||
        "Customer",
    ),
    add: _([ship?.address1, ship?.address2].filter(Boolean).join(", ")),
    pin: _(ship?.zip || order?.raw?.billing_address?.zip),
    city: _(ship?.city),
    state: _(ship?.province),
    country: _(ship?.country || "India"),
    phone: normalizePhoneNumber(
      ship?.phone ||
        order?.raw?.phone ||
        ship?.phone ||
        order?.raw?.billing_address?.phone ||
        order?.raw?.customer?.phone ||
        "",
    ),
    order: _(order?.name),
    payment_mode: paid ? "Prepaid" : "COD",

    // Return-to fields (left blank unless you populate from your store profile)
    return_pin: _(order?.returns?.pin),
    return_city: _(order?.returns?.city),
    return_phone: _(order?.returns?.phone),
    return_add: _(order?.returns?.address),
    return_state: _(order?.returns?.state),
    return_country: _(order?.returns?.country),

    products_desc,
    hsn_code: "6109",
    cod_amount: cod === 0 ? "" : _(cod),
    order_date: order?.createdAt ? new Date(order.createdAt).toISOString() : null,
    total_amount: _(total),

    // Seller fields (fill from your account doc if available)
    seller_add: _(order?.seller?.address),
    seller_name: _(order?.seller?.name),
    seller_inv: _(order?.seller?.invoice_no || order?.invoice_number),

    quantity: _(quantity || ""),
    waybill: _(awb),

    // Dimensions (strings as per sample)
    shipment_width: "10",
    shipment_height: "10",
    shipment_length: "10",
    weight: _(order?.raw?.total_weight ? order?.raw?.total_weight : 250),

    shipping_mode: shippingMode,
    address_type: _(order?.address_type),
  };

  return {
    shipments: [shipment],
    pickup_location: {
      name: pickupName,
    },
  };
}
