/**
 * Checks if business is authorized to process this order
 */
export function BusinessIsAuthorisedToProcessThisOrder(
  businessData: any,
  storeId: string,
) {
  try {
    if (!businessData || !storeId) {
      return {
        authorised: true,
      };
    }

    const isAuthorized = (businessData?.stores ?? [])?.includes(storeId);
    
    if (!isAuthorized) {
      return {
        authorised: false,
        error: "Not authorised to process this order",
        status: 403,
      };
    }

    return {
      authorised: true,
    };
  } catch (error: any) {
    return {
      authorised: false,
      error: error?.message ?? "Unknown error occurred",
      status: 500,
    };
  }
}
