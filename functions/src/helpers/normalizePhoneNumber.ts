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
 * Safely converts a value to a string, returning empty string for null/undefined
 */
export function safeString(value: any): string {
  return value === undefined || value === null ? "" : String(value);
}
