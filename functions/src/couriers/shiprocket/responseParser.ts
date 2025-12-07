// couriers/shiprocket/responseParser.ts

import { httpRetryable } from "../../helpers";

interface ShiprocketResponseEvaluation {
  ok: boolean;
  retryable: boolean;
  code: string;
  message: string;
  orderId?: string | number | null;
  shipmentId?: string | number | null;
}

/**
 * Parses and evaluates Shiprocket create-shipment API response
 * Determines success/failure and whether error is retryable
 */
export function evaluateShiprocketResponse(sr: any): ShiprocketResponseEvaluation {
  const msgFields = [
    sr?.message,
    sr?.msg,
    sr?.error,
    sr?.error_message,
    sr?.errors ? JSON.stringify(sr?.errors) : "",
  ]
    .filter((x) => typeof x === "string" && x.length)
    .join(" | ");

  const rawMsg = msgFields || "";

  // Success shape seen in docs: { order_id, shipment_id, status: "NEW", status_code: 1, ... }
  const looksSuccess = !("status_code" in (sr ?? {})) || sr?.status_code === 1;

  if (looksSuccess) {
    return {
      ok: true,
      retryable: false,
      code: "OK",
      message: "created",
      orderId: sr?.order_id ?? null,
      shipmentId: sr?.shipment_id ?? null,
    };
  }

  // Check for insufficient balance error
  const lowerMsg = rawMsg.toLowerCase();

  const balanceKeywords = [
    "insufficient",
    "balance",
    "wallet",
    "insufficient balance",
    "low balance",
    "wallet balance",
    "insufficient wallet",
    "insufficient fund",
    "recharge",
    "add balance",
    "balance low",
    "no balance",
    "wallet amount",
    "credit limit",
  ];

  const isBalanceError = balanceKeywords.some((keyword) => lowerMsg.includes(keyword));

  if (isBalanceError) {
    return {
      ok: false,
      retryable: false,
      code: "INSUFFICIENT_BALANCE",
      message: rawMsg || "Insufficient balance in carrier account",
    };
  }

  return {
    ok: false,
    retryable: httpRetryable(sr?.status_code),
    code: "CARRIER_AMBIGUOUS",
    message: rawMsg || "carrier error",
  };
}
