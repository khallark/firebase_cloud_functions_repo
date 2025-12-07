// couriers/xpressbees/payloadBuilder.ts

import { normalizePhoneNumber } from "../../helpers";

interface XpressbeesShipmentParams {
  orderId: string;
  order: any;
  pickupName: string;
  shippingMode: string;
  courierId: string;
}

/**
 * Builds Xpressbees shipment creation payload from order data
 */
export function buildXpressbeesPayload(params: XpressbeesShipmentParams) {
  const { orderId, order, courierId } = params;

  const ship =
    order?.raw?.shipping_address || order?.shipping_address || order?.shippingAddress || {};

  const paid = !Number(order.raw.total_outstanding);
  const items =
    (Array.isArray(order?.raw?.line_items) && order.raw.line_items) || order?.lineItems || [];

  // Calculate package weight: 250g per item, considering quantity
  const totalQuantity = items.reduce((sum: number, item: any) => {
    return sum + Number(item?.quantity ?? 1);
  }, 0);
  const packageWeight = totalQuantity * 250;

  let total = Number(order.raw.total_price);
  let cod = Number(order.raw.total_outstanding);

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
