// services/whatsapp/orderStatusMessages.ts

import { sendWhatsAppTemplate, WhatsAppMessageResult } from "./whatsappMessageSender";
import { formatDate, getCustomerName } from "./whatsappHelpers";

/**
 * Build query string for order tracking button
 */
function buildOrderQueryString(shop: any, orderName: string): string {
  const shopName = encodeURIComponent(shop.shopName);
  return `?shop=${shopName}&order=${encodeURIComponent(orderName)}`;
}

/**
 * Send WhatsApp dispatched order notification
 */
export async function sendDispatchedOrderWhatsAppMessage(
  shop: any,
  order: any,
): Promise<WhatsAppMessageResult | null> {
  const customerName = getCustomerName(order);
  const orderName = order.name;
  const orderAWB = String(order?.awb ?? "NOT AVAILABLE");
  const orderCourierProvider = String(order?.courierProvider ?? order.courier);
  const queryString = buildOrderQueryString(shop, orderName);

  return sendWhatsAppTemplate(
    shop,
    order,
    {
      name: "dipatched_order_1",
      bodyParameters: [
        { type: "text", text: customerName },
        { type: "text", text: orderName },
        { type: "text", text: orderAWB },
        { type: "text", text: orderCourierProvider },
      ],
      buttonParameters: [{ type: "text", text: queryString }],
    },
    "Dispatched",
  );
}

/**
 * Send WhatsApp in transit order notification
 */
export async function sendInTransitOrderWhatsAppMessage(
  shop: any,
  order: any,
): Promise<WhatsAppMessageResult | null> {
  const customerName = getCustomerName(order);
  const orderName = order.name;
  const orderAWB = String(order?.awb ?? "NOT AVAILABLE");
  const orderCourierProvider = String(order?.courierProvider ?? order.courier);
  const queryString = buildOrderQueryString(shop, orderName);

  return sendWhatsAppTemplate(
    shop,
    order,
    {
      name: "intransit_order_1",
      bodyParameters: [
        { type: "text", text: customerName },
        { type: "text", text: orderName },
        { type: "text", text: orderAWB },
        { type: "text", text: orderCourierProvider },
      ],
      buttonParameters: [{ type: "text", text: queryString }],
    },
    "In Transit",
  );
}

/**
 * Send WhatsApp out for delivery order notification
 */
export async function sendOutForDeliveryOrderWhatsAppMessage(
  shop: any,
  order: any,
): Promise<WhatsAppMessageResult | null> {
  const customerName = getCustomerName(order);
  const orderName = order.name;
  const orderAWB = String(order?.awb ?? "NOT AVAILABLE");
  const orderCourierProvider = String(order?.courierProvider ?? order.courier);
  const queryString = buildOrderQueryString(shop, orderName);

  return sendWhatsAppTemplate(
    shop,
    order,
    {
      name: "outfordelivery_order_2",
      bodyParameters: [
        { type: "text", text: customerName },
        { type: "text", text: orderName },
        { type: "text", text: orderAWB },
        { type: "text", text: orderCourierProvider },
      ],
      buttonParameters: [{ type: "text", text: queryString }],
    },
    "Out For Delivery",
  );
}

/**
 * Send WhatsApp delivered order notification
 */
export async function sendDeliveredOrderWhatsAppMessage(
  shop: any,
  order: any,
): Promise<WhatsAppMessageResult | null> {
  const customerName = getCustomerName(order);
  const orderName = order.name;
  const deliveredDate = order.lastStatusUpdate.toDate
    ? formatDate(order.lastStatusUpdate.toDate()) // Firestore Timestamp
    : formatDate(new Date(order.lastStatusUpdate)); // Already a Date/number

  return sendWhatsAppTemplate(
    shop,
    order,
    {
      name: "delivered_order_2",
      bodyParameters: [
        { type: "text", text: customerName },
        { type: "text", text: orderName },
        { type: "text", text: deliveredDate },
      ],
    },
    "Delivered",
  );
}

/**
 * Send WhatsApp RTO in transit notification
 */
export async function sendRTOInTransitOrderWhatsAppMessage(
  shop: any,
  order: any,
): Promise<WhatsAppMessageResult | null> {
  const customerName = getCustomerName(order);
  const orderName = order.name;

  return sendWhatsAppTemplate(
    shop,
    order,
    {
      name: "rtointransit_order_2",
      bodyParameters: [
        { type: "text", text: customerName },
        { type: "text", text: orderName },
      ],
    },
    "RTO In Transit",
  );
}

/**
 * Send WhatsApp RTO delivered notification
 */
export async function sendRTODeliveredOrderWhatsAppMessage(
  shop: any,
  order: any,
): Promise<WhatsAppMessageResult | null> {
  const customerName = getCustomerName(order);
  const orderName = order.name;

  return sendWhatsAppTemplate(
    shop,
    order,
    {
      name: "rtodelivered_order_4",
      bodyParameters: [
        { type: "text", text: customerName },
        { type: "text", text: orderName },
      ],
    },
    "RTO Delivered",
  );
}

/**
 * Send WhatsApp lost order notification
 */
export async function sendLostOrderWhatsAppMessage(
  shop: any,
  order: any,
): Promise<WhatsAppMessageResult | null> {
  const customerName = getCustomerName(order);
  const orderName = order.name;

  return sendWhatsAppTemplate(
    shop,
    order,
    {
      name: "lost_order_1",
      bodyParameters: [
        { type: "text", text: customerName },
        { type: "text", text: orderName },
      ],
    },
    "Lost",
  );
}

/**
 * Send WhatsApp order split notification
 */
export async function sendSplitOrdersWhatsAppMessage(
  shop: any,
  oldOrder: any,
  newOrders: any[],
): Promise<WhatsAppMessageResult | null> {
  const customerName = getCustomerName(oldOrder);
  const oldOrderName = oldOrder.name;
  const newOrderList = (() => {
    return newOrders
      .map((order) => {
        return `${order.name} → ${order.product_name} x ${order.quantity}`;
      })
      .join(" | ");
  })();

  return sendWhatsAppTemplate(
    shop,
    oldOrder,
    {
      name: "split_order_1",
      bodyParameters: [
        { type: "text", text: customerName },
        { type: "text", text: oldOrderName },
        { type: "text", text: String(newOrders.length) },
        { type: "text", text: newOrderList },
      ],
    },
    "Order Splitted",
  );
}

/**
 * Send WhatsApp DTO Booked order notification
 */
export async function sendDTOBookedOrderWhatsAppMessage(
  shop: any,
  order: any,
): Promise<WhatsAppMessageResult | null> {
  const customerName = getCustomerName(order);
  const orderName = order.name;
  const orderAWB = String(order?.awb_reverse ?? "NOT AVAILABLE");
  const orderCourierProvider = String(order?.courierReverseProvider ?? order.courier_reverse);
  const queryString = buildOrderQueryString(shop, orderName);

  return sendWhatsAppTemplate(
    shop,
    order,
    {
      name: "dtobooked_order_1",
      bodyParameters: [
        { type: "text", text: customerName },
        { type: "text", text: orderName },
        { type: "text", text: orderAWB },
        { type: "text", text: orderCourierProvider },
      ],
      buttonParameters: [{ type: "text", text: queryString }],
    },
    "DTO Booked",
  );
}

/**
 * Send WhatsApp DTO In Transit order notification
 */
export async function sendDTOInTransitOrderWhatsAppMessage(
  shop: any,
  order: any,
): Promise<WhatsAppMessageResult | null> {
  const customerName = getCustomerName(order);
  const orderName = order.name;
  const orderAWB = String(order?.awb_reverse ?? "NOT AVAILABLE");
  const orderCourierProvider = String(order?.courierReverseProvider ?? order.courier_reverse);
  const queryString = buildOrderQueryString(shop, orderName);

  return sendWhatsAppTemplate(
    shop,
    order,
    {
      name: "dtointransit_order_1",
      bodyParameters: [
        { type: "text", text: customerName },
        { type: "text", text: orderName },
        { type: "text", text: orderAWB },
        { type: "text", text: orderCourierProvider },
      ],
      buttonParameters: [{ type: "text", text: queryString }],
    },
    "DTO In Transit",
  );
}

/**
 * Send WhatsApp DTO Delivered order notification
 */
export async function sendDTODeliveredOrderWhatsAppMessage(
  shop: any,
  order: any,
): Promise<WhatsAppMessageResult | null> {
  const customerName = getCustomerName(order);
  const orderName = order.name;
  const deliveredDate = order.lastStatusUpdate.toDate
    ? formatDate(order.lastStatusUpdate.toDate()) // Firestore Timestamp
    : formatDate(new Date(order.lastStatusUpdate)); // Already a Date/number

  return sendWhatsAppTemplate(
    shop,
    order,
    {
      name: "dtodelivered_order_1",
      bodyParameters: [
        { type: "text", text: customerName },
        { type: "text", text: orderName },
        { type: "text", text: deliveredDate },
      ],
    },
    "DTO Delivered",
  );
}
