import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firebaseAdmin";

// Helper to normalize phone numbers for comparison
function normalizePhoneNumber(phone: string): string {
  if (!phone) return "";
  // Removes non-digit characters and takes the last 10 digits
  const digitsOnly = phone.replace(/\D/g, "");
  return digitsOnly.slice(-10);
}

/**
 * Extract customer name from order
 */
function getCustomerName(order: any): string {
  return (
    order?.raw?.shipping_address?.name ||
    order?.raw?.billing_address?.name ||
    `${order?.raw?.customer?.first_name || ""} ${order?.raw?.customer?.last_name || ""}`.trim() ||
    "Customer"
  );
}

/**
 * Extract phone number from order
 */
function getCustomerPhone(order: any): string {
  const phone =
    order?.raw?.shipping_address?.phone ||
    order?.raw?.billing_address?.phone ||
    order?.raw?.customer?.phone ||
    "";

  return phone.replace(/[^\d+]/g, "");
}

/**
 * Format date
 */
function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(date));
}

/**
 * Send WhatsApp order dispatched notification
 */
export async function sendDispatchedOrderWhatsAppMessage(shop: any, order: any) {
  try {
    const customerName = getCustomerName(order);
    const customerPhone = String("91" + normalizePhoneNumber(getCustomerPhone(order)));
    const orderName = order.name;
    const orderAWB = String(order?.awb ?? "NOT AVAILABLE");
    const orderCourierProvider = String(order?.courierProvider ?? order.courier);
    const shopName = encodeURIComponent(shop.shopName);
    const queryString = `?shop=${shopName}&order=${encodeURIComponent(orderName)}`;

    if (!customerPhone) {
      console.error("No phone number found for order:", orderName);
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: "dipatched_order_1",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: customerName,
              },
              {
                type: "text",
                text: orderName,
              },
              {
                type: "text",
                text: orderAWB,
              },
              {
                type: "text",
                text: orderCourierProvider,
              },
            ],
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [
              {
                type: "text",
                text: queryString, // "?shop=onewhorules&order=%23OWR-MT2342"
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    const messageDoc = {
      orderName: orderName,
      forStatus: "Dispatched",
      orderId: order.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    await db
      .collection("accounts")
      .doc(shop.shopName)
      .collection("orders")
      .doc(String(order.orderId))
      .update({
        whatsapp_messages: FieldValue.arrayUnion(messageId),
      });

    console.log(`✅ WhatsApp message sent for order ${orderName}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}

/**
 * Send WhatsApp order in transit notification
 */
export async function sendInTransitOrderWhatsAppMessage(shop: any, order: any) {
  try {
    const customerName = getCustomerName(order);
    const customerPhone = String("91" + normalizePhoneNumber(getCustomerPhone(order)));
    const orderName = order.name;
    const orderAWB = String(order?.awb ?? "NOT AVAILABLE");
    const orderCourierProvider = String(order?.courierProvider ?? order.courier);
    const shopName = encodeURIComponent(shop.shopName);
    const queryString = `?shop=${shopName}&order=${encodeURIComponent(orderName)}`;

    if (!customerPhone) {
      console.error("No phone number found for order:", orderName);
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: "intransit_order_1",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: customerName,
              },
              {
                type: "text",
                text: orderName,
              },
              {
                type: "text",
                text: orderAWB,
              },
              {
                type: "text",
                text: orderCourierProvider,
              },
            ],
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [
              {
                type: "text",
                text: queryString, // "?shop=onewhorules&order=%23OWR-MT2342"
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    const messageDoc = {
      orderName: orderName,
      forStatus: "In Transit",
      orderId: order.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    await db
      .collection("accounts")
      .doc(shop.shopName)
      .collection("orders")
      .doc(String(order.orderId))
      .update({
        whatsapp_messages: FieldValue.arrayUnion(messageId),
      });

    console.log(`✅ WhatsApp message sent for order ${orderName}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}

/**
 * Send WhatsApp order out for delivery notification
 */
export async function sendOutForDeliveryOrderWhatsAppMessage(shop: any, order: any) {
  try {
    const customerName = getCustomerName(order);
    const customerPhone = String("91" + normalizePhoneNumber(getCustomerPhone(order)));
    const orderName = order.name;
    const orderAWB = String(order?.awb ?? "NOT AVAILABLE");
    const orderCourierProvider = String(order?.courierProvider ?? order.courier);
    const shopName = encodeURIComponent(shop.shopName);
    const queryString = `?shop=${shopName}&order=${encodeURIComponent(orderName)}`;

    if (!customerPhone) {
      console.error("No phone number found for order:", orderName);
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: "outfordelivery_order_2",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: customerName,
              },
              {
                type: "text",
                text: orderName,
              },
              {
                type: "text",
                text: orderAWB,
              },
              {
                type: "text",
                text: orderCourierProvider,
              },
            ],
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [
              {
                type: "text",
                text: queryString, // "?shop=onewhorules&order=%23OWR-MT2342"
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    const messageDoc = {
      orderName: orderName,
      forStatus: "Out For Delivery",
      orderId: order.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    await db
      .collection("accounts")
      .doc(shop.shopName)
      .collection("orders")
      .doc(String(order.orderId))
      .update({
        whatsapp_messages: FieldValue.arrayUnion(messageId),
      });

    console.log(`✅ WhatsApp message sent for order ${orderName}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}

/**
 * Send WhatsApp order delivered notification
 */
export async function sendDeliveredOrderWhatsAppMessage(shop: any, order: any) {
  try {
    const customerName = getCustomerName(order);
    const customerPhone = String("91" + normalizePhoneNumber(getCustomerPhone(order)));
    const orderName = order.name;
    const deliveredDate = order.lastStatusUpdate.toDate
      ? formatDate(order.lastStatusUpdate.toDate()) // Firestore Timestamp
      : formatDate(new Date(order.lastStatusUpdate)); // Already a Date/number

    if (!customerPhone) {
      console.error("No phone number found for order:", orderName);
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: "delivered_order_2",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: customerName,
              },
              {
                type: "text",
                text: orderName,
              },
              {
                type: "text",
                text: deliveredDate,
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    const messageDoc = {
      orderName: orderName,
      forStatus: "Delivered",
      orderId: order.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    await db
      .collection("accounts")
      .doc(shop.shopName)
      .collection("orders")
      .doc(String(order.orderId))
      .update({
        whatsapp_messages: FieldValue.arrayUnion(messageId),
      });

    console.log(`✅ WhatsApp message sent for order ${orderName}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}

/**
 * Send WhatsApp order dto booked notification
 */
export async function sendDTOBookedOrderWhatsAppMessage(shop: any, order: any) {
  try {
    const customerName = getCustomerName(order);
    const customerPhone = String("91" + normalizePhoneNumber(getCustomerPhone(order)));
    const orderName = order.name;
    const orderAWB = String(order?.awb_reverse ?? "NOT AVAILABLE");
    const orderCourierProvider = String(order?.courierReverseProvider ?? order.courier_reverse);
    const shopName = encodeURIComponent(shop.shopName);
    const queryString = `?shop=${shopName}&order=${encodeURIComponent(orderName)}`;

    if (!customerPhone) {
      console.error("No phone number found for order:", orderName);
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: "dtobooked_order_1",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: customerName,
              },
              {
                type: "text",
                text: orderName,
              },
              {
                type: "text",
                text: orderAWB,
              },
              {
                type: "text",
                text: orderCourierProvider,
              },
            ],
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [
              {
                type: "text",
                text: queryString, // "?shop=onewhorules&order=%23OWR-MT2342"
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    const messageDoc = {
      orderName: orderName,
      forStatus: "DTO Booked",
      orderId: order.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    await db
      .collection("accounts")
      .doc(shop.shopName)
      .collection("orders")
      .doc(String(order.orderId))
      .update({
        whatsapp_messages: FieldValue.arrayUnion(messageId),
      });

    console.log(`✅ WhatsApp message sent for order ${orderName}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}

/**
 * Send WhatsApp order dto in transit notification
 */
export async function sendDTOInTransitOrderWhatsAppMessage(shop: any, order: any) {
  try {
    const customerName = getCustomerName(order);
    const customerPhone = String("91" + normalizePhoneNumber(getCustomerPhone(order)));
    const orderName = order.name;
    const orderAWB = String(order?.awb_reverse ?? "NOT AVAILABLE");
    const orderCourierProvider = String(order?.courierReverseProvider ?? order.courier_reverse);
    const shopName = encodeURIComponent(shop.shopName);
    const queryString = `?shop=${shopName}&order=${encodeURIComponent(orderName)}`;

    if (!customerPhone) {
      console.error("No phone number found for order:", orderName);
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: "dtointransit_order_1",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: customerName,
              },
              {
                type: "text",
                text: orderName,
              },
              {
                type: "text",
                text: orderAWB,
              },
              {
                type: "text",
                text: orderCourierProvider,
              },
            ],
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [
              {
                type: "text",
                text: queryString, // "?shop=onewhorules&order=%23OWR-MT2342"
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    const messageDoc = {
      orderName: orderName,
      forStatus: "DTO In Transit",
      orderId: order.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    await db
      .collection("accounts")
      .doc(shop.shopName)
      .collection("orders")
      .doc(String(order.orderId))
      .update({
        whatsapp_messages: FieldValue.arrayUnion(messageId),
      });

    console.log(`✅ WhatsApp message sent for order ${orderName}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}

/**
 * Send WhatsApp order dto delivered notification
 */
export async function sendDTODeliveredOrderWhatsAppMessage(shop: any, order: any) {
  try {
    const customerName = getCustomerName(order);
    const customerPhone = String("91" + normalizePhoneNumber(getCustomerPhone(order)));
    const orderName = order.name;
    const deliveredDate = order.lastStatusUpdate.toDate
      ? formatDate(order.lastStatusUpdate.toDate()) // Firestore Timestamp
      : formatDate(new Date(order.lastStatusUpdate)); // Already a Date/number

    if (!customerPhone) {
      console.error("No phone number found for order:", orderName);
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: "dtodelivered_order_1",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: customerName,
              },
              {
                type: "text",
                text: orderName,
              },
              {
                type: "text",
                text: deliveredDate,
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    const messageDoc = {
      orderName: orderName,
      forStatus: "DTO Delivered",
      orderId: order.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    await db
      .collection("accounts")
      .doc(shop.shopName)
      .collection("orders")
      .doc(String(order.orderId))
      .update({
        whatsapp_messages: FieldValue.arrayUnion(messageId),
      });

    console.log(`✅ WhatsApp message sent for order ${orderName}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}

/**
 * Send WhatsApp order dto delivered notification
 */
export async function sendRTOInTransitOrderWhatsAppMessage(shop: any, order: any) {
  try {
    const customerName = getCustomerName(order);
    const customerPhone = String("91" + normalizePhoneNumber(getCustomerPhone(order)));
    const orderName = order.name;

    if (!customerPhone) {
      console.error("No phone number found for order:", orderName);
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: "rtointransit_order_2",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: customerName,
              },
              {
                type: "text",
                text: orderName,
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    const messageDoc = {
      orderName: orderName,
      forStatus: "RTO In Transit",
      orderId: order.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    await db
      .collection("accounts")
      .doc(shop.shopName)
      .collection("orders")
      .doc(String(order.orderId))
      .update({
        whatsapp_messages: FieldValue.arrayUnion(messageId),
      });

    console.log(`✅ WhatsApp message sent for order ${orderName}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}

/**
 * Send WhatsApp order dto delivered notification
 */
export async function sendRTODeliveredOrderWhatsAppMessage(shop: any, order: any) {
  try {
    const customerName = getCustomerName(order);
    const customerPhone = String("91" + normalizePhoneNumber(getCustomerPhone(order)));
    const orderName = order.name;

    if (!customerPhone) {
      console.error("No phone number found for order:", orderName);
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: "rtodelivered_order_4",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: customerName,
              },
              {
                type: "text",
                text: orderName,
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    const messageDoc = {
      orderName: orderName,
      forStatus: "RTO Delivered",
      orderId: order.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    await db
      .collection("accounts")
      .doc(shop.shopName)
      .collection("orders")
      .doc(String(order.orderId))
      .update({
        whatsapp_messages: FieldValue.arrayUnion(messageId),
      });

    console.log(`✅ WhatsApp message sent for order ${orderName}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}

/**
 * Send WhatsApp order lost notification
 */
export async function sendLostOrderWhatsAppMessage(shop: any, order: any) {
  try {
    const customerName = getCustomerName(order);
    const customerPhone = String("91" + normalizePhoneNumber(getCustomerPhone(order)));
    const orderName = order.name;

    if (!customerPhone) {
      console.error("No phone number found for order:", orderName);
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: "lost_order_1",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: customerName,
              },
              {
                type: "text",
                text: orderName,
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    const messageDoc = {
      orderName: orderName,
      forStatus: "RTO Delivered",
      orderId: order.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    await db
      .collection("accounts")
      .doc(shop.shopName)
      .collection("orders")
      .doc(String(order.orderId))
      .update({
        whatsapp_messages: FieldValue.arrayUnion(messageId),
      });

    console.log(`✅ WhatsApp message sent for order ${orderName}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}

/**
 * Send WhatsApp orders splitted notification
 */
export async function sendSplitOrdersWhatsAppMessage(shop: any, oldOrder: any, newOrders: any[]) {
  try {
    const customerName = getCustomerName(oldOrder);
    const customerPhone = String("91" + normalizePhoneNumber(getCustomerPhone(oldOrder)));
    const oldOrderName = oldOrder.name;
    const newOrderList = (() => {
      return newOrders
        .map((order) => {
          return `${order.name} → ${order.product_name} x ${order.quantity}`;
        })
        .join(" | ");
    })();

    if (!customerPhone) {
      console.error("No phone number found for order:", oldOrderName);
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: "split_order_1",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: customerName,
              },
              {
                type: "text",
                text: oldOrderName,
              },
              {
                type: "text",
                text: String(newOrders.length),
              },
              {
                type: "text",
                text: newOrderList,
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    const messageDoc = {
      orderName: oldOrderName,
      forStatus: "Order Split",
      orderId: oldOrder.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    await db
      .collection("accounts")
      .doc(shop.shopName)
      .collection("orders")
      .doc(String(oldOrder.orderId))
      .update({
        whatsapp_messages: FieldValue.arrayUnion(messageId),
      });

    console.log(`✅ WhatsApp message sent for order ${oldOrderName}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}

/**
 * Send WhatsApp confirmed order delayed level 1 notification
 */
export async function sendConfirmedDelayedLvl1WhatsAppMessage(shop: any, order: any) {
  try {
    const customerName = getCustomerName(order);
    const customerPhone = String("91" + normalizePhoneNumber(getCustomerPhone(order)));
    const orderName = order.name;

    if (!customerPhone) {
      console.error("No phone number found for order:", orderName);
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: "confirm_delay_1_order_1",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: customerName,
              },
              {
                type: "text",
                text: orderName,
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    const messageDoc = {
      orderName: orderName,
      forStatus: "RTO In Transit",
      orderId: order.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    await db
      .collection("accounts")
      .doc(shop.shopName)
      .collection("orders")
      .doc(String(order.orderId))
      .update({
        whatsapp_messages: FieldValue.arrayUnion(messageId),
      });

    console.log(`✅ WhatsApp message sent for order ${orderName}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}

/**
 * Send WhatsApp confirmed order delayed level 2 notification
 */
export async function sendConfirmedDelayedLvl2WhatsAppMessage(shop: any, order: any) {
  try {
    const customerName = getCustomerName(order);
    const customerPhone = String("91" + normalizePhoneNumber(getCustomerPhone(order)));
    const orderName = order.name;

    if (!customerPhone) {
      console.error("No phone number found for order:", orderName);
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: "confirm_delay_2_order_1",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: customerName,
              },
              {
                type: "text",
                text: orderName,
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    const messageDoc = {
      orderName: orderName,
      forStatus: "RTO In Transit",
      orderId: order.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    await db
      .collection("accounts")
      .doc(shop.shopName)
      .collection("orders")
      .doc(String(order.orderId))
      .update({
        whatsapp_messages: FieldValue.arrayUnion(messageId),
      });

    console.log(`✅ WhatsApp message sent for order ${orderName}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}

/**
 * Send WhatsApp confirmed order delayed level 3 notification
 */
export async function sendConfirmedDelayedLvl3WhatsAppMessage(shop: any, order: any) {
  try {
    const customerName = getCustomerName(order);
    const customerPhone = String("91" + normalizePhoneNumber(getCustomerPhone(order)));
    const orderName = order.name;

    if (!customerPhone) {
      console.error("No phone number found for order:", orderName);
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: "confirm_delay_3_order_1",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: customerName,
              },
              {
                type: "text",
                text: orderName,
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    const messageDoc = {
      orderName: orderName,
      forStatus: "RTO In Transit",
      orderId: order.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    await db
      .collection("accounts")
      .doc(shop.shopName)
      .collection("orders")
      .doc(String(order.orderId))
      .update({
        whatsapp_messages: FieldValue.arrayUnion(messageId),
      });

    console.log(`✅ WhatsApp message sent for order ${orderName}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}

/**
 * Send WhatsApp confirmed order delayed level 3 notification
 */
export async function sendConfirmedDelayedOrdersPDFWhatsAppMessage(
  shop: any,
  url: string,
  phone: string,
) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: "delayed_pdf_order_1",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: url,
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${shop.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shop.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    console.log(`✅ WhatsApp message sent.`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Sent to: ${sentTo}`);

    return {
      success: true,
      messageId,
      sentTo,
    };
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    return null;
  }
}
