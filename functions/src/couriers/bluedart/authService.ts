// couriers/bluedart/authService.ts
interface BlueDartAuthResponse {
  token?: string;
  error?: string;
}

/**
 * Fetches JWT token for Blue Dart API authentication
 * Token is required for all Blue Dart API calls
 */
export async function getBlueDartToken(appApiKey: string): Promise<string> {
  
  try {
    const response = await fetch(
      "https://apigateway.bluedart.com/in/transportation/token/v1/login",
      {
        method: "GET",
        headers: {
          ClientID: appApiKey,
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`AUTH_FAILED_HTTP_${response.status}`);
    }

    const data = await response.json() as BlueDartAuthResponse;
    
    if (!data.token) {
      throw new Error("AUTH_TOKEN_MISSING");
    }

    return data.token;
  } catch (error: any) {
    if (error.message.startsWith("AUTH_")) {
      throw error;
    }
    throw new Error(`AUTH_NETWORK_ERROR: ${error.message}`);
  }
}