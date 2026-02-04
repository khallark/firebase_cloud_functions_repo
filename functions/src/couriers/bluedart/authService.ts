// couriers/bluedart/authService.ts

interface BlueDartAuthSuccessResponse {
  JWTToken: string;
}

interface BlueDartAuthErrorResponse {
  status: number;
  title: string;
  "error-response": Array<{ msg: string }> | string;
}

/**
 * Fetches JWT token for Blue Dart API authentication
 * Token is required for all Blue Dart API calls
 */
export async function getBlueDartToken(appApiKey: string, appApiSecret: string): Promise<string> {
  try {
    const response = await fetch(
      "https://apigateway.bluedart.com/in/transportation/token/v1/login",
      {
        method: "GET",
        headers: {
          ClientID: appApiKey,
          clientSecret: appApiSecret,
          Accept: "application/json",
        },
      },
    );

    const data = await response.json();

    // Handle error responses (status 401, etc.)
    if (!response.ok) {
      const errorData = data as BlueDartAuthErrorResponse;

      // Extract error message from error-response array
      let errorMessage = "Authentication failed";
      if (errorData["error-response"]) {
        if (Array.isArray(errorData["error-response"]) && errorData["error-response"].length > 0) {
          errorMessage = errorData["error-response"].map((err) => err.msg).join(", ");
        }
        if (typeof errorData["error-response"] === "string") {
          errorMessage = errorData["error-response"];
        }
      }

      throw new Error(`AUTH_FAILED_HTTP_${response.status}: ${errorMessage}`);
    }

    // Handle success response
    const successData = data as BlueDartAuthSuccessResponse;

    if (!successData.JWTToken) {
      throw new Error("AUTH_TOKEN_MISSING: Response does not contain JWTToken");
    }

    return successData.JWTToken;
  } catch (error: any) {
    // Re-throw our custom auth errors
    if (error.message && error.message.startsWith("AUTH_")) {
      throw error;
    }

    // Wrap network/parsing errors
    throw new Error(`AUTH_NETWORK_ERROR: ${error.message}`);
  }
}
