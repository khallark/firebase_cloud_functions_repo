// services/whatsapp/whatsappMessageSender.ts

import { FieldValue } from "firebase-admin/firestore";
import { preparePhoneNumber } from "./whatsappHelpers";
import { db } from "../../firebaseAdmin";

export interface WhatsAppMessageResult {
  success: boolean;
  messageId?: string;
  sentTo?: string;
}

export interface WhatsAppTemplateConfig {
  name: string;
  bodyParameters: Array<{ type: string; text: string }>;
  buttonParameters?: Array<{ type: string; text: string }>;
}

/**
 * Core function to send WhatsApp template messages
 */
async function sendWhatsAppTemplate(
  shop: any,
  order: any,
  templateConfig: WhatsAppTemplateConfig,
  forStatus: string,
): Promise<WhatsAppMessageResult | null> {
  try {
    const customerPhone = preparePhoneNumber(order);
    const orderName = order.name;

    if (!customerPhone) {
      console.error("No phone number found for order:", orderName);
      return null;
    }

    // Build template components
    const components: any[] = [
      {
        type: "body",
        parameters: templateConfig.bodyParameters,
      },
    ];

    // Add button component if provided
    if (templateConfig.buttonParameters && templateConfig.buttonParameters.length > 0) {
      components.push({
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: templateConfig.buttonParameters,
      });
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customerPhone,
      type: "template",
      template: {
        name: templateConfig.name,
        language: {
          code: "en",
        },
        components,
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

    // Store message in Firestore
    const messageDoc = {
      orderName: orderName,
      forStatus: forStatus,
      orderId: order.orderId,
      shopName: shop.shopName,
      sentAt: FieldValue.serverTimestamp(),
      messageStatus: "sent",
      sentTo: sentTo,
      messageId: messageId,
    };

    await db.collection("whatsapp_messages").doc(messageId).set(messageDoc);

    // Update order with message ID
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
 * Sends a plain text WhatsApp message
 */
export async function sendWhatsAppTextMessage(
  shop: any,
  phone: string,
  message: string,
): Promise<WhatsAppMessageResult | null> {
  try {
    const accessToken = shop?.whatsappAccessToken;
    const phoneNumberId = shop?.whatsappPhoneNumberId;

    if (!accessToken || !phoneNumberId) {
      console.warn("WhatsApp credentials not configured, skipping message");
      return null;
    }

    const response = await fetch(`https://graph.facebook.com/v24.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: {
          preview_url: true,
          body: message,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `Failed to send WhatsApp message to ${phone}: ${response.status} - ${errorText}`,
      );
      return null;
    }

    const result = (await response.json()) as any;
    console.log(`✅ WhatsApp message sent successfully to ${phone}`);

    return {
      success: true,
      messageId: result.messages?.[0]?.id,
      sentTo: result.contacts?.[0]?.input,
    };
  } catch (error) {
    console.error(`Error sending WhatsApp message to ${phone}:`, error);
    return null;
  }
}

export { sendWhatsAppTemplate };
