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

  const paid = !order.raw.payment_gateway_names.join(",").toLowerCase().includes("cod");
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

  const total = Number(order.raw.total_price);
  const cod = Number(order.raw.total_outstanding);

  const _ = (v: any) => (v === undefined || v === null ? "" : String(v));

  function normalizePhoneNumber(phoneNumber: string): string {
    // Remove all whitespace characters from the phone number
    const cleanedNumber = phoneNumber.replace(/\s/g, "");

    // Check if the cleaned number length is >= 10
    if (cleanedNumber.length >= 10) {
      // Extract the last 10 digits
      return cleanedNumber.slice(-10);
    } else {
      // Return the whole string if length is less than 10
      return cleanedNumber;
    }
  }

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
    weight: _(order?.raw?.total_weight),

    shipping_mode: shippingMode,
    address_type: _(order?.address_type),
  };

  return {
    shipments: [shipment],
    pickup_location: {
      name: pickupName ? "Majime Productions 2" : "Majime Productions 2",
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
  const ship = order?.raw?.shipping_address || {};

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

  const sub_total = order?.raw?.total_outstanding;

  const payment_method = order.raw.payment_gateway_names.join(",").toLowerCase().includes("cod")
    ? "COD"
    : "Prepaid";

  const weight = Number(order?.raw?.total_weight) / 1000;

  function normalizePhoneNumber(phoneNumber: string): string {
    // Remove all whitespace characters from the phone number
    const cleanedNumber = phoneNumber.replace(/\s/g, "");

    // Check if the cleaned number length is >= 10
    if (cleanedNumber.length >= 10) {
      // Extract the last 10 digits
      return cleanedNumber.slice(-10);
    } else {
      // Return the whole string if length is less than 10
      return cleanedNumber;
    }
  }

  return {
    order_id: String(orderId), // make order_id == jobId for idempotency
    order_date: new Date().toISOString().slice(0, 16).replace("T", " "), // "YYYY-MM-DD HH:mm"
    pickup_location: pickupName ? "Majime Productions 2" : "Majime Productions 2",
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
    billing_phone: normalizePhoneNumber(
      ship?.phone ||
        order?.raw?.phone ||
        ship?.phone ||
        order?.raw?.billing_address?.phone ||
        order?.raw?.customer?.phone ||
        "",
    ),
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
    shipping_charges: Number(order?.raw?.shipping_lines?.[0]?.price ?? 0) || 0,
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: Number(order?.raw?.total_discounts ?? 0) || 0,
    sub_total: Number(sub_total || 0),
    length: 10,
    breadth: 10,
    height: 10,
    weight,
  };
}
