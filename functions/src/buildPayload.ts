/** Map your order doc → Delhivery Shipment Creation payload (flat schema). */
export function buildDelhiveryPayload(params: {
  orderId: string;
  awb: string;
  order: any;
  pickupName: string;
  shippingMode: string;
}) {
  const { orderId, awb, order, pickupName, shippingMode } = params;

  const ship =
    order?.raw?.shipping_address || order?.shipping_address || order?.shippingAddress || {};

  const paid =
    String(order?.financialStatus || order?.raw?.financial_status || "").toLowerCase() === "paid";

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

  // weight in KG if you have grams on items
  const grams = items.reduce(
    (g: number, it: any) => g + Number(it?.grams ?? it?.weight_grams ?? it?.weight ?? 0),
    0,
  );
  const weightKg = grams > 0 ? (grams / 1000).toFixed(3) : "";

  const total = Number(order?.raw?.total_price ?? order?.totalPrice ?? order?.amount ?? 0) || "";

  const _ = (v: any) => (v === undefined || v === null ? "" : String(v));

  const shipment = {
    name: _(
      order?.raw?.billing_address?.name ||
        order?.raw?.customer?.default_address ||
        ship?.name ||
        "Customer",
    ),
    add: _([ship?.address1, ship?.address2].filter(Boolean).join(", ")),
    pin: _(ship?.zip),
    city: _(ship?.city),
    state: _(ship?.province),
    country: _(ship?.country || "India"),
    phone: _(
      ship?.phone ||
        order?.raw?.phone ||
        ship?.phone ||
        order?.raw?.billing_address?.phone ||
        order?.raw?.customer?.phone ||
        "",
    ),
    order: _(orderId),
    payment_mode: paid ? "Prepaid" : "COD",

    // Return-to fields (left blank unless you populate from your store profile)
    return_pin: _(order?.returns?.pin),
    return_city: _(order?.returns?.city),
    return_phone: _(order?.returns?.phone),
    return_add: _(order?.returns?.address),
    return_state: _(order?.returns?.state),
    return_country: _(order?.returns?.country),

    products_desc,
    hsn_code: _(order?.hsn_code),
    cod_amount: paid ? "" : _(total),
    order_date: order?.created_at ? new Date(order.created_at).toISOString() : null,
    total_amount: _(total),

    // Seller fields (fill from your account doc if available)
    seller_add: _(order?.seller?.address),
    seller_name: _(order?.seller?.name),
    seller_inv: _(order?.seller?.invoice_no || order?.invoice_number),

    quantity: _(quantity || ""),
    waybill: _(awb),

    // Dimensions (strings as per sample)
    shipment_width: _(order?.package?.width ?? order?.shipment_width ?? "100"),
    shipment_height: _(order?.package?.height ?? order?.shipment_height ?? "100"),
    weight: _(order?.package?.weight ?? weightKg),

    shipping_mode: shippingMode,
    address_type: _(order?.address_type),
  };

  return {
    shipments: [shipment],
    pickup_location: {
      name:
        _(pickupName ?? order?.pickup_location_name ?? order?.raw?.location?.name) ||
        "Default Warehouse",
    },
  };
}
