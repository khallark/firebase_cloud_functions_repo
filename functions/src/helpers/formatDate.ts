/**
 * Formats a timestamp to DD-MM-YYYY in IST timezone
 */
export function formatDate(timestamp: any): string {
  if (!timestamp) return "N/A";

  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);

  if (isNaN(date.getTime())) return "N/A";

  // Format in IST timezone
  return date
    .toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    })
    .replace(/\//g, "-");
}
