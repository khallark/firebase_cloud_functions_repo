/** Map your order doc → Delhivery Shipment Creation payload (flat schema). */
export function buildDelhiveryPayload(params: {
  orderId?: string;
  awb: string;
  order: any;
  pickupName: string;
  shippingMode: string;
}) {
  const { awb, order, pickupName, shippingMode } = params;

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

export function buildShiprocketPayload(opts: {
  orderId: string;
  order: any;
  pickupName: string;
  shippingMode: string;
}) {
  const { orderId, order, pickupName } = opts;
  const ship =
    order?.shippingAddress ||
    order?.shipping_address ||
    order?.customer?.default_address ||
    order?.billingAddress ||
    order?.billing_address ||
    {};

  const name =
    `${ship?.first_name ?? ship?.firstName ?? ""}`.trim() ||
    `${order?.customer?.first_name ?? ""}`.trim() ||
    "Customer";
  const last =
    `${ship?.last_name ?? ship?.lastName ?? ""}`.trim() ||
    `${order?.customer?.last_name ?? ""}`.trim();

  const pinCandidate =
    ship?.zip ?? ship?.postal_code ?? ship?.postalCode ?? ship?.pincode ?? ship?.pin;
  const pinMatch = String(pinCandidate ?? "").match(/\d{6}/);
  const pincode = pinMatch ? pinMatch[0] : "";

  const itemsSrc: any[] = Array.isArray(order?.raw?.line_items) ? order?.raw?.line_items : [];
  const order_items =
    itemsSrc.length > 0
      ? itemsSrc.map((li) => ({
          name: li?.name ?? "Item",
          sku: li?.sku ?? String(li?.variant_id ?? li?.product_id ?? "SKU"),
          units: Number(li?.quantity ?? 1),
          selling_price: Number(li?.price ?? li?.selling_price ?? 0),
          discount: Number(li?.total_discount ?? 0) || 0,
          tax: li?.tax ?? "",
          hsn: li?.hsn ?? li?.hsn_code ?? "",
        }))
      : [
          {
            name: "Item",
            sku: "SKU",
            units: 1,
            selling_price: Number(order?.total_price ?? order?.amount ?? 0),
            discount: 0,
            tax: "",
            hsn: "",
          },
        ];

  const sub_total =
    order_items.reduce(
      (sum: number, it: any) => sum + Number(it.selling_price || 0) * Number(it.units || 0),
      0,
    ) - order_items.reduce((sum: number, it: any) => sum + Number(it.discount || 0), 0);

  const payment_method = order?.financialStatus === "pending" ? "COD" : "Prepaid";

  const length = Number(order?.package?.length ?? 10);
  const breadth = Number(order?.package?.breadth ?? 10);
  const height = Number(order?.package?.height ?? 10);
  const weight = Number(order?.package?.weight ?? order?.total_weight ?? 0.5);

  return {
    order_id: String(orderId), // make order_id == jobId for idempotency
    order_date: new Date().toISOString().slice(0, 16).replace("T", " "), // "YYYY-MM-DD HH:mm"
    pickup_location: pickupName,
    comment: order?.note || "",
    billing_customer_name: name,
    billing_last_name: last,
    billing_address: ship?.address1 ?? ship?.address ?? "",
    billing_address_2: ship?.address2 ?? "",
    billing_city: ship?.city ?? "",
    billing_pincode: pincode,
    billing_state: ship?.province ?? ship?.state ?? "",
    billing_country: ship?.country ?? "India",
    billing_email: ship?.email ?? order?.email ?? "",
    billing_phone: ship?.phone ?? order?.phone ?? "",
    shipping_is_billing: true,
    shipping_address: "",
    shipping_address_2: "",
    shipping_city: "",
    shipping_pincode: "",
    shipping_country: "",
    shipping_state: "",
    shipping_phone: "",
    order_items,
    payment_method,
    shipping_charges: Number(order?.shipping_lines?.[0]?.price ?? 0) || 0,
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: Number(order?.total_discounts ?? 0) || 0,
    sub_total: Number(sub_total || 0),
    length,
    breadth,
    height,
    weight,
  };
}
