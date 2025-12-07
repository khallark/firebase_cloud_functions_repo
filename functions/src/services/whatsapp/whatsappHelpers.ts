/**
 * Normalizes phone number by removing whitespace and extracting last 10 digits
 * Used by all courier payload builders
 *
 * @param phoneNumber - Raw phone number string
 * @returns Normalized 10-digit phone number or the original cleaned string if less than 10 digits
 */
export function normalizePhoneNumber(phoneNumber: string): string {
  if (!phoneNumber) return "";

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

/**
 * Prepares customer phone with country code
 */
export function preparePhoneNumber(order: any): string {
  return String("91" + normalizePhoneNumber(getCustomerPhone(order)));
}

/**
 * Extracts phone number from order
 */
export function getCustomerPhone(order: any): string {
  const phone =
    order?.raw?.shipping_address?.phone ||
    order?.raw?.billing_address?.phone ||
    order?.raw?.customer?.phone ||
    "";

  return phone.replace(/[^\d+]/g, "");
}

/**
 * Extracts customer name from order
 */
export function getCustomerName(order: any): string {
  return (
    order?.raw?.shipping_address?.name ||
    order?.raw?.billing_address?.name ||
    `${order?.raw?.customer?.first_name || ""} ${order?.raw?.customer?.last_name || ""}`.trim() ||
    "Customer"
  );
}

/**
 * Formats a timestamp to DD-MM-YYYY
 */
export function formatDate(timestamp: any): string {
  if (!timestamp) return "N/A";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}
