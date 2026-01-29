// config/constants.ts

/**
 * Shared Constants
 *
 * Contains all application-wide constants including:
 * - Special IDs (shared store, super admin)
 * - Status sets for orders and jobs
 * - Courier configurations
 * - Error codes
 * - Shipping modes
 */

// ============================================================================
// SPECIAL IDS
// ============================================================================

/**
 * Shared store ID used for multi-vendor authorization
 */
export const SHARED_STORE_ID = "nfkjgp-sv.myshopify.com";
export const SHARED_STORE_ID_2 = "gj9ejg-cu.myshopify.com";
export const SHARED_STORE_IDS = ["nfkjgp-sv.myshopify.com", "gj9ejg-cu.myshopify.com"];
export const META_ADS_MANAGER_SECRET =
  "EAAZADNn6RfvwBQi9Q8BxPD93qvfIk7P9mdZCoX6JaJ2hk0ZCTyBDXxXJENwQsKPSwpTEkEZB7ze2Plj1DGYmUWwEjfDbQfrrNtn0Yp7xOkF5pj1ibSPCCvXMIZCdSVpLNxDKx4dvZAMS6eyMzuWQWoUPptFt28mQqIEdbkb1ZBP4zVfRTteYul7pIFgt2lApgZDZD";

/**
 * Super admin ID that bypasses all authorization checks
 */
export const SUPER_ADMIN_ID = "vD8UJMLtHNefUfkMgbcF605SNAm2";

export const REPORT_PHONE_NUMBER = "9779752241";

export const CLOSE_AFTER_HOURS = 360;

// ============================================================================
// ORDER STATUSES
// ============================================================================

/**
 * Valid order statuses in the system
 */
export const ORDER_STATUSES = {
  NEW: "New",
  CONFIRMED: "Confirmed",
  READY_TO_DISPATCH: "Ready To Dispatch",
  DISPATCHED: "Dispatched",
  IN_TRANSIT: "In Transit",
  OUT_FOR_DELIVERY: "Out For Delivery",
  DELIVERED: "Delivered",
  RTO_IN_TRANSIT: "RTO In Transit",
  RTO_DELIVERED: "RTO Delivered",
  DTO_REQUESTED: "DTO Requested",
  DTO_BOOKED: "DTO Booked",
  DTO_IN_TRANSIT: "DTO In Transit",
  DTO_DELIVERED: "DTO Delivered",
  PENDING_REFUNDS: "Pending Refunds",
  DTO_REFUNDED: "DTO Refunded",
  LOST: "Lost",
  CLOSED: "Closed",
  RTO_PROCESSED: "RTO Processed",
  RTO_CLOSED: "RTO Closed",
  CANCELLATION_REQUESTED: "Cancellation Requested",
  CANCELLED: "Cancelled",
} as const;

/**
 * Order statuses that indicate shipment is already created
 */
export const ALREADY_SHIPPED_STATUSES = new Set([
  ORDER_STATUSES.READY_TO_DISPATCH,
  ORDER_STATUSES.IN_TRANSIT,
  ORDER_STATUSES.OUT_FOR_DELIVERY,
  ORDER_STATUSES.DELIVERED,
  ORDER_STATUSES.RTO_IN_TRANSIT,
  ORDER_STATUSES.RTO_DELIVERED,
]);

export const RETURN_STATUSES = new Set([
  ORDER_STATUSES.RTO_CLOSED,
  ORDER_STATUSES.DTO_REFUNDED,
  ORDER_STATUSES.LOST,
  ORDER_STATUSES.CANCELLATION_REQUESTED,
  ORDER_STATUSES.CANCELLED,
]);

/**
 * Order statuses that indicate shipment is in transit
 */
export const IN_TRANSIT_STATUSES = new Set([
  ORDER_STATUSES.IN_TRANSIT,
  ORDER_STATUSES.OUT_FOR_DELIVERY,
  ORDER_STATUSES.RTO_IN_TRANSIT,
]);

/**
 * Order statuses that indicate shipment is delivered
 */
export const DELIVERED_STATUSES = new Set([ORDER_STATUSES.DELIVERED, ORDER_STATUSES.RTO_DELIVERED]);

// ============================================================================
// JOB STATUSES
// ============================================================================

/**
 * Job processing statuses
 */
export const JOB_STATUSES = {
  QUEUED: "queued",
  PROCESSING: "processing",
  SUCCESS: "success",
  FAILED: "failed",
  ATTEMPTING_FALLBACK: "attempting_fallback",
} as const;

/**
 * Terminal job statuses (processing complete)
 */
export const TERMINAL_JOB_STATUSES = new Set([JOB_STATUSES.SUCCESS, JOB_STATUSES.FAILED]);

// ============================================================================
// BATCH STATUSES
// ============================================================================

/**
 * Batch processing statuses
 */
export const BATCH_STATUSES = {
  RUNNING: "running",
  COMPLETED: "completed",
} as const;

// ============================================================================
// COURIERS
// ============================================================================

/**
 * Supported courier names
 */
export const COURIERS = {
  DELHIVERY: "Delhivery",
  SHIPROCKET: "Shiprocket",
  XPRESSBEES: "Xpressbees",
  PRIORITY: "Priority",
} as const;

/**
 * Courier API endpoints
 */
export const COURIER_ENDPOINTS = {
  DELHIVERY: {
    CREATE_SHIPMENT: "https://track.delhivery.com/api/cmu/create.json",
    TRACKING: "https://track.delhivery.com/api/v1/packages/json/",
  },
  SHIPROCKET: {
    BASE_URL: "https://apiv2.shiprocket.in/v1/external",
    CREATE_ORDER: "https://apiv2.shiprocket.in/v1/external/orders/create/adhoc",
    AWB_ASSIGN: "https://apiv2.shiprocket.in/v1/external/courier/assign/awb",
    PICKUP_REQUEST: "https://apiv2.shiprocket.in/v1/external/courier/generate/pickup",
    TRACKING: "https://apiv2.shiprocket.in/v1/external/courier/track",
  },
  XPRESSBEES: {
    COURIER_LIST: "https://shipment.xbwms.com/api2/fetch/courierlist",
    CREATE_SHIPMENT: "https://shipment.xbwms.com/api2/business/order/forward",
    TRACKING: "https://shipment.xbwms.com/api2/fetch/status",
  },
} as const;

// ============================================================================
// SHIPPING MODES
// ============================================================================

/**
 * Available shipping modes
 */
export const SHIPPING_MODES = {
  SURFACE: "Surface",
  EXPRESS: "Express",
} as const;

/**
 * Xpressbees courier mode mapping
 */
export const XPRESSBEES_MODES = {
  [SHIPPING_MODES.EXPRESS]: "Air",
  [SHIPPING_MODES.SURFACE]: "Surface",
} as const;

// ============================================================================
// ERROR CODES
// ============================================================================

/**
 * Application error codes
 */
export const ERROR_CODES = {
  // Authentication & Authorization
  NOT_AUTHORIZED_TO_PROCESS_THIS_ORDER: "NOT_AUTHORIZED_TO_PROCESS_THIS_ORDER",
  CARRIER_KEY_MISSING: "CARRIER_KEY_MISSING",

  // Order validation
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  ORDER_ALREADY_SHIPPED: "ORDER_ALREADY_SHIPPED",
  ORDER_STATUS_NOT_CONFIRMED: "ORDER_STATUS_NOT_CONFIRMED",
  NO_ITEMS_MATCH_RETURN_VARIANT_IDS: "NO_ITEMS_MATCH_RETURN_VARIANT_IDS",
  NO_LINE_ITEMS_IN_ORDER: "NO_LINE_ITEMS_IN_ORDER",
  NO_AWB_AVAILABLE: "NO_AWB_AVAILABLE",
  INVALID_ORDER_STATUS: "INVALID_ORDER_STATUS",

  // Carrier errors
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  COURIER_SELECTION_FAILED: "COURIER_SELECTION_FAILED",
  AWB_ALLOCATION_FAILED: "AWB_ALLOCATION_FAILED",

  // API errors
  API_ERROR: "API_ERROR",
  HTTP_ERROR: "HTTP_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
  TIMEOUT_ERROR: "TIMEOUT_ERROR",

  // Job processing
  JOB_ALREADY_TERMINAL: "JOB_ALREADY_TERMINAL",
  JOB_PROCESSING: "JOB_PROCESSING",
  MAX_ATTEMPTS_REACHED: "MAX_ATTEMPTS_REACHED",

  // Generic
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

/**
 * Non-retryable error codes (permanent failures)
 */
export const NON_RETRYABLE_ERROR_CODES = new Set([
  String(ERROR_CODES.CARRIER_KEY_MISSING),
  String(ERROR_CODES.ORDER_NOT_FOUND),
  String(ERROR_CODES.ORDER_ALREADY_SHIPPED),
  String(ERROR_CODES.NO_ITEMS_MATCH_RETURN_VARIANT_IDS),
  String(ERROR_CODES.NO_LINE_ITEMS_IN_ORDER),
  String(ERROR_CODES.NO_AWB_AVAILABLE),
  String(ERROR_CODES.INVALID_ORDER_STATUS),
  String(ERROR_CODES.ORDER_STATUS_NOT_CONFIRMED),
  String(ERROR_CODES.NOT_AUTHORIZED_TO_PROCESS_THIS_ORDER),
  String(ERROR_CODES.COURIER_SELECTION_FAILED),
  String(ERROR_CODES.INSUFFICIENT_BALANCE),
  String(ERROR_CODES.VALIDATION_ERROR),
]);

/**
 * Exception error codes (exclude from priority fallback)
 */
export const EXCEPTION_ERROR_CODES = new Set([
  ERROR_CODES.ORDER_NOT_FOUND,
  ERROR_CODES.ORDER_ALREADY_SHIPPED,
  ERROR_CODES.ORDER_STATUS_NOT_CONFIRMED,
  ERROR_CODES.NOT_AUTHORIZED_TO_PROCESS_THIS_ORDER,
]);

// ============================================================================
// HTTP STATUS CODES
// ============================================================================

/**
 * HTTP status codes that warrant retry
 */
export const RETRYABLE_HTTP_STATUSES = new Set([
  408, // Request Timeout
  409, // Conflict
  425, // Too Early
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
]);

// ============================================================================
// RETRY CONFIGURATION
// ============================================================================

/**
 * Maximum number of retry attempts for shipment tasks
 */
export const MAX_RETRY_ATTEMPTS = 3;

/**
 * Shiprocket-specific delay between order creation and AWB assignment (ms)
 */
export const SHIPROCKET_AWB_DELAY_MS = 500;

// ============================================================================
// WEIGHT CONFIGURATION
// ============================================================================

/**
 * Default weight per item in grams (for Xpressbees)
 */
export const DEFAULT_ITEM_WEIGHT_GRAMS = 250;

// ============================================================================
// PICKUP CONFIGURATION
// ============================================================================

/**
 * Default pickup time (for Shiprocket)
 */
export const DEFAULT_PICKUP_TIME = "09:00";

// ============================================================================
// SPECIAL VENDOR CODES
// ============================================================================

/**
 * Special vendor code for "Own Stock" in shared store
 */
export const OWN_STOCK_VENDOR = "OWR";

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type OrderStatus = (typeof ORDER_STATUSES)[keyof typeof ORDER_STATUSES];
export type JobStatus = (typeof JOB_STATUSES)[keyof typeof JOB_STATUSES];
export type BatchStatus = (typeof BATCH_STATUSES)[keyof typeof BATCH_STATUSES];
export type CourierName = (typeof COURIERS)[keyof typeof COURIERS];
export type ShippingMode = (typeof SHIPPING_MODES)[keyof typeof SHIPPING_MODES];
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
