// services/whatsapp/delayedOrderMessages.ts
import { getCustomerName } from "./whatsappHelpers";
import { sendWhatsAppTemplate, WhatsAppMessageResult } from "./whatsappMessageSender";

/**
 * Send WhatsApp confirmed order delayed level 1 notification
 */
export async function sendConfirmedDelayedLvl1WhatsAppMessage(
  shop: any,
  order: any,
): Promise<WhatsAppMessageResult | null> {
  const customerName = getCustomerName(order);
  const orderName = order.name;

  return sendWhatsAppTemplate(
    shop,
    order,
    {
      name: "confirm_delay_1_order_1",
      bodyParameters: [
        { type: "text", text: customerName },
        { type: "text", text: orderName },
      ],
    },
    "Confirmed",
  );
}

/**
 * Send WhatsApp confirmed order delayed level 2 notification
 */
export async function sendConfirmedDelayedLvl2WhatsAppMessage(
  shop: any,
  order: any,
): Promise<WhatsAppMessageResult | null> {
  const customerName = getCustomerName(order);
  const orderName = order.name;

  return sendWhatsAppTemplate(
    shop,
    order,
    {
      name: "confirm_delay_2_order_1",
      bodyParameters: [
        { type: "text", text: customerName },
        { type: "text", text: orderName },
      ],
    },
    "RTO In Transit",
  );
}

/**
 * Send WhatsApp confirmed order delayed level 3 notification
 */
export async function sendConfirmedDelayedLvl3WhatsAppMessage(
  shop: any,
  order: any,
): Promise<WhatsAppMessageResult | null> {
  const customerName = getCustomerName(order);
  const orderName = order.name;

  return sendWhatsAppTemplate(
    shop,
    order,
    {
      name: "confirm_delay_3_order_1",
      bodyParameters: [
        { type: "text", text: customerName },
        { type: "text", text: orderName },
      ],
    },
    "RTO In Transit",
  );
}

/**
 * Send WhatsApp delayed orders PDF notification
 */
export async function sendConfirmedDelayedOrdersPDFWhatsAppMessage(
  shop: any,
  url: string,
  phone: string,
): Promise<WhatsAppMessageResult | null> {
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
