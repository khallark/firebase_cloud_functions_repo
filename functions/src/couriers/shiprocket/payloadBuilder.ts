// couriers/shiprocket/payloadBuilder.ts

import { normalizePhoneNumber } from "../../helpers";

interface ShiprocketShipmentParams {
  orderId: string;
  order: any;
  pickupName: string;
  shippingMode: string;
}

/**
 * Builds Shiprocket shipment creation payload from order data
 */
export function buildShiprocketPayload(params: ShiprocketShipmentParams) {
  const { orderId, order, pickupName } = params;
  const ship =
    order?.raw?.shipping_address ||
    order?.raw?.billing_address ||
    order?.raw?.default_address ||
    {};

  const name =
    `${ship?.first_name ?? ship?.firstName ?? ""}`.trim() ||
    `${order?.customer?.first_name ?? ""}`.trim() ||
    "Customer";
  const last =
    `${ship?.last_name ?? ship?.lastName ?? ""}`.trim() ||
    `${order?.customer?.last_name ?? ""}`.trim();

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

  // Calculate sub_total as sum of (price * quantity) for all line items
  let sub_total =
    itemsSrc.length > 0
      ? itemsSrc.reduce((sum, li) => {
          const price = Number(li?.price ?? li?.selling_price ?? 0);
          const quantity = Number(li?.quantity ?? 1);
          return sum + price * quantity;
        }, 0)
      : Number(order?.total_price ?? order?.amount ?? 0);

  const payment_method = !Number(order.raw.total_outstanding) ? "Prepaid" : "COD";

  const weightingms = 250;
  // order?.raw?.total_weight ? Number(order?.raw.total_weight) :
  const weight = weightingms / 1000;

  return {
    order_id: String(order?.name || orderId), // make order_id == jobId for idempotency
    order_date: new Date().toISOString().slice(0, 16).replace("T", " "), // "YYYY-MM-DD HH:mm"
    pickup_location: pickupName,
    comment: order?.note || "",
    billing_customer_name: name,
    billing_last_name: last,
    billing_address: ship?.address1 ?? ship?.address ?? "",
    billing_address_2: ship?.address2 ?? "",
    billing_city: ship?.city ?? "",
    billing_pincode: ship?.zip,
    billing_state: ship?.province ?? ship?.state ?? "",
    billing_country: ship?.country ?? "India",
    billing_email:
      ship?.email ??
      (order?.email === "N/A" ? "" : order?.email) ??
      `${normalizePhoneNumber(
        ship?.phone ||
          order?.raw?.phone ||
          ship?.phone ||
          order?.raw?.billing_address?.phone ||
          order?.raw?.customer?.phone ||
          "unknown",
      )}@majime.in`,
    billing_phone: normalizePhoneNumber(
      ship?.phone ||
        order?.raw?.phone ||
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
