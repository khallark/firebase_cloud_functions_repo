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
    weight: _(order?.raw?.total_weight ? order?.raw?.total_weight : 250),

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

  const weightingms = order?.raw?.total_weight ? Number(order?.raw.total_weight) : 250;
  const weight = weightingms / 1000;

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
    order_id: String(order?.name || orderId), // make order_id == jobId for idempotency
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

export function buildDelhiveryReturnPayload(params: {
  orderId: string;
  awb: string;
  order: any;
  pickupName: string;
  shippingMode?: string;
}): any {
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

  function normalizePhoneNumber(phoneNumber: string): string {
    const cleanedNumber = phoneNumber.replace(/\s/g, "");
    if (cleanedNumber.length >= 10) {
      return cleanedNumber.slice(-10);
    }
    return cleanedNumber;
  }

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
    pickup_location: { name: pickupName ? "Majime Productions 2" : "Majime Productions 2" },
  };
}

/** Map your order doc → Xpressbees Shipment Creation payload */
export function buildXpressbeesPayload(params: {
  orderId: string;
  order: any;
  pickupName: string;
  shippingMode: string;
  courierId: string;
}) {
  const { orderId, order, courierId } = params;

  const ship =
    order?.raw?.shipping_address || order?.shipping_address || order?.shippingAddress || {};

  const paid = !order.raw.payment_gateway_names.join(",").toLowerCase().includes("cod");
  const items =
    (Array.isArray(order?.raw?.line_items) && order.raw.line_items) || order?.lineItems || [];

  // Calculate package weight: 250g per item, considering quantity
  const totalQuantity = items.reduce((sum: number, item: any) => {
    return sum + Number(item?.quantity ?? 1);
  }, 0);
  const packageWeight = totalQuantity * 250;

  const total = Number(order.raw.total_price);
  const cod = Number(order.raw.total_outstanding);

  function normalizePhoneNumber(phoneNumber: string): string {
    const cleanedNumber = phoneNumber.replace(/\s/g, "");
    if (cleanedNumber.length >= 10) {
      return cleanedNumber.slice(-10);
    }
    return cleanedNumber;
  }

  const consigneeName =
    order?.raw?.billing_address?.name ||
    ship?.name ||
    order?.raw?.customer?.default_address?.name ||
    "Customer";

  const consigneeAddress = [ship?.address1, ship?.address2].filter(Boolean).join(", ");

  const orderItems = items.map((li: any) => ({
    name: li?.name || li?.title || "Item",
    qty: String(li?.quantity ?? 1),
    price: String(li?.price ?? 0),
    sku: li?.sku || String(li?.variant_id || li?.product_id || "SKU"),
  }));

  const payload: any = {
    order_number: order?.name || String(orderId),
    unique_order_number: "no",
    payment_type: paid ? "prepaid" : "cod",
    order_amount: total,
    package_weight: packageWeight,
    package_length: 10,
    package_breadth: 10,
    package_height: 10,
    request_auto_pickup: "yes",
    consignee: {
      name: consigneeName,
      address: ship?.address1 || consigneeAddress || "",
      address_2: ship?.address2 || "",
      city: ship?.city || "",
      state: ship?.province || "",
      pincode: ship?.zip || "",
      phone: normalizePhoneNumber(
        ship?.phone ||
          order?.raw?.phone ||
          order?.raw?.billing_address?.phone ||
          order?.raw?.customer?.phone ||
          "",
      ),
    },
    pickup: {
      warehouse_name: "Majime Productions 2",
      name: "Majime Productions 2",
      address: "Udyog Vihaar, Bahadarke Road, Bhattian",
      address_2: "141008, Ludhiana",
      city: "Ludhiana",
      state: "Punjab",
      pincode: "141008",
      phone: "9132326000",
    },
    order_items:
      orderItems.length > 0
        ? orderItems
        : [
            {
              name: "Item",
              qty: "1",
              price: String(total),
              sku: "SKU",
            },
          ],
    courier_id: courierId,
    collectable_amount: String(cod),
  };

  // Add cod_charges only if payment is COD
  // if (!paid) {
  //   payload.cod_charges = 30;
  // }

  return payload;
}
