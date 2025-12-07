// couriers/delhivery/responseParser.ts

interface DelhiveryResponseEvaluation {
  ok: boolean;
  retryable: boolean;
  code: string;
  message: string;
  carrierShipmentId?: string | null;
}

/**
 * Parses and evaluates Delhivery create-shipment API response
 * Determines success/failure and whether error is retryable
 */
export function evaluateDelhiveryResponse(carrier: any): DelhiveryResponseEvaluation {
  const remarksArr = carrier.packages?.[0]?.remarks;
  let remarks = "";
  if (Array.isArray(remarksArr)) remarks = remarksArr.join("\n ");

  // Success signals seen in Delhivery responses
  const waybill =
    carrier?.shipment_id ?? carrier?.packets?.[0]?.waybill ?? carrier?.waybill ?? null;

  const okFlag = (carrier?.success === true && carrier?.error !== true) || Boolean(waybill);

  if (okFlag) {
    return {
      ok: true,
      retryable: false,
      code: "OK",
      message: "created",
      carrierShipmentId: waybill,
    };
  }

  // Check for insufficient balance error
  const lowerRemarks = remarks.toLowerCase();
  const lowerError = String(carrier?.error || carrier?.message || "").toLowerCase();
  const combinedText = `${lowerRemarks} ${lowerError}`;

  const balanceKeywords = [
    "insufficient",
    "wallet",
    "balance",
    "insufficient balance",
    "low balance",
    "wallet balance",
    "insufficient wallet",
    "insufficient fund",
    "recharge",
    "add balance",
    "balance low",
    "no balance",
  ];

  const isBalanceError = balanceKeywords.some((keyword) => combinedText.includes(keyword));

  if (isBalanceError) {
    return {
      ok: false,
      retryable: false,
      code: "INSUFFICIENT_BALANCE",
      message: remarks || "Insufficient balance in carrier account",
    };
  }

  // ----- Known permanent validation/business errors (non-retryable) -----
  return {
    ok: false,
    retryable: false,
    code: "CARRIER_AMBIGUOUS",
    message: remarks || "Unknown carrier error",
  };
}
