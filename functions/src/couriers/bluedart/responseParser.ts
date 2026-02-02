// couriers/bluedart/responseParser.ts

interface BlueDartResponseEvaluation {
  ok: boolean;
  retryable: boolean;
  code: string;
  message: string;
  carrierShipmentId?: string | null;
  awbNo?: string | null;
  tokenNumber?: string | null;
}

/**
 * Parses and evaluates Blue Dart GenerateWayBill API response
 * Handles both successful responses and various error formats
 */
export function evaluateBlueDartResponse(response: any): BlueDartResponseEvaluation {
  // Handle HTTP-level errors (400, 401, etc.)
  if (response?.status && response?.["error-response"]) {
    const statusCode = response.status;
    const errorResponse = response["error-response"];

    // Case 1: Simple string error
    if (typeof errorResponse === "string") {
      return {
        ok: false,
        retryable: statusCode >= 500, // Retry server errors
        code: `HTTP_${statusCode}`,
        message: errorResponse,
      };
    }

    // Case 2: Array with status objects
    if (Array.isArray(errorResponse) && errorResponse.length > 0) {
      const firstError = errorResponse[0];

      if (firstError.Status && Array.isArray(firstError.Status)) {
        const status = firstError.Status[0];
        const statusCode = status?.StatusCode || "UNKNOWN_ERROR";
        const statusInfo = status?.StatusInformation || "Unknown error occurred";

        return {
          ok: false,
          retryable: isRetryableError(statusCode),
          code: statusCode,
          message: statusInfo,
        };
      }
    }

    return {
      ok: false,
      retryable: statusCode >= 500,
      code: `HTTP_${statusCode}`,
      message: JSON.stringify(errorResponse),
    };
  }

  // Handle successful response structure with GenerateWayBillResult
  const result = response?.GenerateWayBillResult;

  if (!result) {
    return {
      ok: false,
      retryable: false,
      code: "INVALID_RESPONSE_FORMAT",
      message: "Response does not contain GenerateWayBillResult",
    };
  }

  // Check IsError flag
  if (result.IsError === true) {
    // Extract error information from Status array
    let statusCode = "UNKNOWN_ERROR";
    let statusInfo = "Unknown error occurred";

    if (Array.isArray(result.Status) && result.Status.length > 0) {
      const status = result.Status[0];
      statusCode = status?.StatusCode || statusCode;
      statusInfo = status?.StatusInformation || statusInfo;
    }

    // Check for insufficient balance
    const lowerMessage = statusInfo.toLowerCase();
    if (
      lowerMessage.includes("insufficient") ||
      lowerMessage.includes("balance") ||
      lowerMessage.includes("wallet") ||
      lowerMessage.includes("amount")
    ) {
      return {
        ok: false,
        retryable: false,
        code: "INSUFFICIENT_BALANCE",
        message: statusInfo,
      };
    }

    // Check for authentication errors
    if (statusCode.toLowerCase().includes("auth") || lowerMessage.includes("authentication")) {
      const retryable = lowerMessage.includes("token") || lowerMessage.includes("expired");

      return {
        ok: false,
        retryable,
        code: statusCode,
        message: statusInfo,
      };
    }

    return {
      ok: false,
      retryable: isRetryableError(statusCode),
      code: statusCode,
      message: statusInfo,
    };
  }

  // Success case: IsError is false and AWBNo is present
  if (result.IsError === false && result.AWBNo) {
    return {
      ok: true,
      retryable: false,
      code: "OK",
      message: "Shipment created successfully",
      awbNo: result.AWBNo,
      carrierShipmentId: null,
      tokenNumber: result.TokenNumber || null,
    };
  }

  // Edge case: IsError is false but no AWBNo
  if (result.IsError === false) {
    return {
      ok: false,
      retryable: true,
      code: "AWB_NOT_GENERATED",
      message: "Shipment processed but AWB number not generated",
    };
  }

  // Fallback for unexpected response format
  return {
    ok: false,
    retryable: false,
    code: "UNEXPECTED_RESPONSE",
    message: "Response format not recognized",
  };
}

/**
 * Determines if an error code is retryable
 */
function isRetryableError(statusCode: string): boolean {
  const lowerCode = statusCode.toLowerCase();

  // Non-retryable errors
  const nonRetryable = [
    "invalidpickupdate",
    "invalidpincode",
    "invalidaddress",
    "invalidcustomer",
    "invalidproduct",
    "requestauthenticationfailed",
    "invalidcredentials",
    "insufficientbalance",
    "pincode",
    "validation",
    "temporarily",
    "tryagain",
  ];

  for (const pattern of nonRetryable) {
    if (lowerCode.includes(pattern)) {
      return false;
    }
  }

  // Retryable errors (network, timeout, temporary server issues)
  const retryable = ["timeout", "network", "server", "unavailable", "temporary"];

  for (const pattern of retryable) {
    if (lowerCode.includes(pattern)) {
      return true;
    }
  }

  // Default: don't retry unknown errors
  return false;
}
