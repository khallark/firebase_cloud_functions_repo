import { SUPER_ADMIN_ID } from "../config";

/**
 * Checks if business is authorized to process this order
 */
export function BusinessIsAuthorisedToProcessThisOrder(
  businessId: string,
  vendorName: string,
  vendors: any,
) {
  try {
    if (businessId === SUPER_ADMIN_ID) {
      return {
        authorised: true,
      };
    }
    if (!vendorName) {
      return {
        authorised: false,
        error: "No vendorName provided",
        status: 400,
      };
    }
    if (!vendors || !Array.isArray(vendors) || !vendors.length) {
      return {
        authorised: false,
        error: "Invalid vendors array",
        status: 400,
      };
    }

    const isAuthorized =
      vendorName !== "OWR"
        ? vendors.includes(vendorName)
        : (vendors.includes(vendorName) ||
            vendors.includes("Ghamand") ||
            vendors.includes("BBB")) &&
          !vendors.includes("ENDORA") &&
          !vendors.includes("STYLE 05");

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
