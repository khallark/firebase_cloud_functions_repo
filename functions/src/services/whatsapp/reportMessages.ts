// services/whatsapp/reportMessages.ts

import { sendWhatsAppTextMessage, WhatsAppMessageResult } from "./whatsappMessageSender";

/**
 * Send WhatsApp message with Excel download link
 */
export async function sendSharedStoreOrdersExcelWhatsAppMessage(
  shop: any,
  downloadUrl: string,
  phone: string,
): Promise<void> {
  const message =
    `📊 *Shared Store Orders Report*\n\n` +
    `Your Excel file containing all orders from the shared store is ready!\n\n` +
    `📥 Download: ${downloadUrl}\n\n` +
    `Generated on: ${new Date().toLocaleDateString("en-GB")}\n\n` +
    `Thank you for using Majime! 🎉`;

  await sendWhatsAppTextMessage(shop, phone, message);
}

/**
 * Send WhatsApp message with tax report download link
 */
export async function sendTaxReportWhatsAppMessage(
  shop: any,
  startDate: string,
  endDate: string,
  downloadUrlPath: string,
  phone: string,
): Promise<WhatsAppMessageResult | null> {
  try {
    const accessToken = shop?.whatsappAccessToken;
    const phoneNumberId = shop?.whatsappPhoneNumberId;

    if (!accessToken || !phoneNumberId) {
      console.warn("WhatsApp credentials not configured, skipping message");
      return null;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: "tax_report_1",
        language: {
          code: "en",
        },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: startDate },
              { type: "text", text: endDate },
            ],
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: downloadUrlPath }],
          },
        ],
      },
    };

    const response = await fetch(`https://graph.facebook.com/v24.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error("WhatsApp API error:", error);
      return null;
    }

    const result = (await response.json()) as any;
    const messageId = result.messages[0].id;
    const sentTo = result.contacts[0].input;

    console.log(`✅ WhatsApp message sent for ${phone}`);
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
 * Send WhatsApp message with unavailable stock PDF link
 */
export async function sendUnavailableStockPDFWhatsAppMessage(
  shop: any,
  downloadUrl: string,
  phone: string,
): Promise<void> {
  const message =
    `📦 *Unavailable Stock Report*\n\n` +
    `Your PDF report of unavailable stock items is ready!\n\n` +
    `📥 Download: ${downloadUrl}\n\n` +
    `Generated on: ${new Date().toLocaleDateString("en-GB")}\n\n` +
    `Thank you for using Majime! 🎉`;

  await sendWhatsAppTextMessage(shop, phone, message);
}

/**
 * Send generic WhatsApp message with document link
 */
export async function sendDocumentLinkWhatsAppMessage(
  shop: any,
  documentName: string,
  downloadUrl: string,
  phone: string,
): Promise<WhatsAppMessageResult | null> {
  const message =
    `📄 *${documentName}*\n\n` +
    `Your document is ready!\n\n` +
    `📥 Download: ${downloadUrl}\n\n` +
    `Generated on: ${new Date().toLocaleDateString("en-GB")}\n\n` +
    `Thank you for using Majime! 🎉`;

  return sendWhatsAppTextMessage(shop, phone, message);
}
