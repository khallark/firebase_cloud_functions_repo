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
  downloadUrl: string,
  phone: string,
): Promise<void> {
  const message =
    `📊 *Daily Tax Report*\n\n` +
    `Your tax report for the previous day is ready!\n\n` +
    `📥 Download: ${downloadUrl}\n\n` +
    `Generated on: ${new Date().toLocaleDateString("en-GB")}\n\n` +
    `Thank you for using Majime! 🎉`;

  await sendWhatsAppTextMessage(shop, phone, message);
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
