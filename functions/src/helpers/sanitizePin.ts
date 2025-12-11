// Add this helper at the top
export function sanitizePin(zip: any): string {
  if (!zip) return "";
  return String(zip).replace(/\D/g, "").slice(0, 6); // Keep only digits, max 6
}
