/** Map your order doc → Delhivery CMU create payload. */
export function buildDelhiveryPayload(params: {
  awb: string;
  order: any;
  pickupName?: string;
  shippingMode: string; // "Express" | "Surface"
}) {
  const { awb, order, pickupName, shippingMode } = params;

  // Helpers
  const S = (v: any) => (v === undefined || v === null ? "" : String(v));
  const trimDigits = (v: any) => S(v).replace(/\D+/g, "");
  const omitEmpty = <T extends Record<string, any>>(obj: T): T =>
    Object.fromEntries(
      Object.entries(obj).filter(([, v]) => v !== "" && v !== null && v !== undefined),
    ) as T;

  const ship =
    order?.raw?.shipping_address || order?.shipping_address || order?.shippingAddress || {};

  const bill = order?.raw?.billing_address || {};
  const cust = order?.raw?.customer || {};

  // Build a sensible full name
  const fromAddr = (addr: any) =>
    addr?.name || [addr?.first_name, addr?.last_name].filter(Boolean).join(" ").trim();

  const customerName =
    fromAddr(bill) ||
    fromAddr(cust?.default_address || {}) ||
    fromAddr(ship) ||
    order?.name ||
    "Customer";

  const paid =
    String(order?.financialStatus || order?.raw?.financial_status || "").toLowerCase() === "paid";

  const items: any[] =
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

  const quantity =
    items.reduce((n: number, it: any) => n + Number(it?.quantity ?? it?.qty ?? 0), 0) || 1;

  const grams = items.reduce(
    (g: number, it: any) => g + Number(it?.grams ?? it?.weight_grams ?? it?.weight ?? 0),
    0,
  );
  const weightKg = grams > 0 ? (grams / 1000).toFixed(3) : "";

  const totalNum = Number(order?.raw?.total_price ?? order?.totalPrice ?? order?.amount ?? 0) || 0;

  // Prefer shipping phone; fallback through other possible places
  const phone =
    trimDigits(ship?.phone) ||
    trimDigits(order?.raw?.phone) ||
    trimDigits(bill?.phone) ||
    trimDigits(cust?.phone) ||
    "";

  const shipment = omitEmpty({
    name: S(customerName),
    add: S([ship?.address1, ship?.address2].filter(Boolean).join(", ")),
    pin: S(ship?.zip),
    city: S(ship?.city),
    state: S(ship?.province),
    country: S(ship?.country || "India"),
    phone,

    order: S(order?.name || order?.order_number || order?.id || ""),

    payment_mode: paid ? "Prepaid" : "COD",

    // Return-to fields (only if you actually have them)
    return_pin: S(order?.returns?.pin),
    return_city: S(order?.returns?.city),
    return_phone: trimDigits(order?.returns?.phone),
    return_add: S(order?.returns?.address),
    return_state: S(order?.returns?.state),
    return_country: S(order?.returns?.country),

    products_desc,
    hsn_code: "6109",

    cod_amount: paid ? "" : String(totalNum),
    order_date: null, // Delhivery accepts null; ISO can be rejected on some tenants
    total_amount: String(totalNum),

    seller_add: S(order?.seller?.address),
    seller_name: S(order?.seller?.name),
    seller_inv: S(order?.seller?.invoice_no || order?.invoice_number),

    quantity: String(quantity),
    waybill: S(awb),

    shipment_width: S(order?.package?.width ?? order?.shipment_width ?? "100"),
    shipment_height: S(order?.package?.height ?? order?.shipment_height ?? "100"),
    weight: S(order?.package?.weight ?? weightKg),

    shipping_mode: S(shippingMode || "Express"),
    address_type: S(order?.address_type),
  });

  return {
    shipments: [shipment],
    pickup_location: omitEmpty({
      name:
        S(pickupName ?? order?.pickup_location_name ?? order?.raw?.location?.name) ||
        "Default Warehouse",
    }),
  };
}
