/**
 * Helper to require a shared secret header for HTTP functions
 */
export function requireHeaderSecret(req: any, header: string, expected: string): void {
  const got = (req.get(header) || "").trim();
  if (!got || got !== (expected || "").trim()) {
    throw new Error(`UNAUTH_${header}`);
  }
}
