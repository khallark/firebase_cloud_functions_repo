// couriers/xpressbees/responseParser.ts

interface XpressbeesResponseEvaluation {
  ok: boolean;
  retryable: boolean;
  code: string;
  message: string;
  awbNumber?: string | null;
  shipmentId?: string | number | null;
  orderId?: string | number | null;
  courierName?: string | null;
}

/**
 * Parses and evaluates Xpressbees create-shipment API response
 * Determines success/failure and whether error is retryable
 */
export function evaluateXpressbeesResponse(carrier: any): XpressbeesResponseEvaluation {
  // Success: { status: true, data: { ... } }
  if (carrier?.status === true && carrier?.data) {
    const data = carrier.data;
    return {
      ok: true,
      retryable: false,
      code: "OK",
      message: "created",
      awbNumber: data?.awb_number ?? null,
      shipmentId: data?.shipment_id ?? null,
      orderId: data?.order_id ?? null,
      courierName: data?.courier_name ?? null,
    };
  }

  // Error: { status: false, message: "..." }
  const errorMessage = carrier?.message || "Unknown Xpressbees error";

  // Check for insufficient balance error
  const lowerMsg = String(errorMessage).toLowerCase();
  const balanceKeywords = [
    "insufficient",
    "balance",
    "wallet",
    "recharge",
    "add balance",
    "low balance",
  ];

  const isBalanceError = balanceKeywords.some((keyword) => lowerMsg.includes(keyword));

  if (isBalanceError) {
    return {
      ok: false,
      retryable: false,
      code: "INSUFFICIENT_BALANCE",
      message: errorMessage,
    };
  }

  // Other errors are non-retryable (validation errors, etc.)
  return {
    ok: false,
    retryable: false,
    code: "CARRIER_ERROR",
    message: errorMessage,
  };
}
