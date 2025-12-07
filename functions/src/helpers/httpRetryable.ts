/**
 * Decides if an HTTP failure status is retryable
 */
export function httpRetryable(status: number) {
  if (status === 429 || status === 408 || status === 409 || status === 425) return true;
  if (status >= 500) return true;
  return false;
}
