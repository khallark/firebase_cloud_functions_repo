// config/secrets.ts

import { defineSecret } from "firebase-functions/params";

/**
 * Secrets Configuration
 *
 * Manages Firebase secrets and environment variables for:
 * - Task authentication
 * - Webhook authentication
 * - Courier API keys
 * - Third-party integrations
 *
 * Usage:
 * ```typescript
 * import { TASKS_SECRET, getTasksSecret } from "./config/secrets";
 *
 * // In function definition
 * export const myFunction = onRequest(
 *   { secrets: [TASKS_SECRET] },
 *   async (req, res) => {
 *     const secret = getTasksSecret();
 *     // ...
 *   }
 * );
 * ```
 */

// ============================================================================
// FIREBASE SECRETS (Cloud Functions v2)
// ============================================================================

/**
 * Secret for Cloud Tasks authentication
 * Used to verify requests from Cloud Tasks to function endpoints
 */
export const TASKS_SECRET = defineSecret("TASKS_SECRET");

/**
 * Secret for enqueueing shipment tasks
 * Used by frontend/API to enqueue shipment batches
 */
export const ENQUEUE_FUNCTION_SECRET = defineSecret("ENQUEUE_FUNCTION_SECRET");

/**
 * WhatsApp Business API credentials
 */
// export const WHATSAPP_API_KEY = defineSecret("WHATSAPP_API_KEY");
// export const WHATSAPP_PHONE_NUMBER_ID = defineSecret("WHATSAPP_PHONE_NUMBER_ID");

// ============================================================================
// SECRET ACCESSORS
// ============================================================================

/**
 * Get Tasks secret value
 * @returns Tasks secret string
 */
// export function getTasksSecret(): string {
//   return TASKS_SECRET.value() || "";
// }

/**
 * Get Enqueue secret value
 * @returns Enqueue secret string
 */
// export function getEnqueueSecret(): string {
//   return ENQUEUE_SECRET.value() || "";
// }

/**
 * Get Webhook secret value
 * @returns Webhook secret string
 */
// export function getWebhookSecret(): string {
//   return WEBHOOK_SECRET.value() || "";
// }

/**
 * Get WhatsApp API key
 * @returns WhatsApp API key string
 */
// export function getWhatsAppApiKey(): string {
//   return WHATSAPP_API_KEY.value() || "";
// }

/**
 * Get WhatsApp phone number ID
 * @returns WhatsApp phone number ID string
 */
// export function getWhatsAppPhoneNumberId(): string {
//   return WHATSAPP_PHONE_NUMBER_ID.value() || "";
// }

// ============================================================================
// ENVIRONMENT VARIABLES
// ============================================================================

/**
 * Cloud Tasks queue configuration
 */
// export const CLOUD_TASKS_CONFIG = {
//   projectId: process.env.GCP_PROJECT || "",
//   location: process.env.TASKS_LOCATION || "asia-south1",
//   shipmentQueueName: process.env.SHIPMENT_QUEUE_NAME || "shipments-queue",
//   statusUpdateQueueName: process.env.STATUS_UPDATE_QUEUE_NAME || "status-updates-queue",
//   returnQueueName: process.env.RETURN_QUEUE_NAME || "returns-queue",
// } as const;

/**
 * Task target URLs for shipment processors
 */
// export const SHIPMENT_TASK_URLS = {
//   delhivery: process.env.SHIPMENT_TASK_TARGET_URL_1 || "",
//   shiprocket: process.env.SHIPMENT_TASK_TARGET_URL_2 || "",
//   xpressbees: process.env.SHIPMENT_TASK_TARGET_URL_3 || "",
// } as const;

/**
 * Priority fallback handler URL
 */
// export const PRIORITY_FALLBACK_HANDLER_URL = process.env.PRIORITY_FALLBACK_HANDLER_URL || "";

/**
 * Return shipment task URLs
 */
// export const RETURN_TASK_URLS = {
//   delhivery: process.env.RETURN_TASK_TARGET_URL_1 || "",
//   shiprocket: process.env.RETURN_TASK_TARGET_URL_2 || "",
//   xpressbees: process.env.RETURN_TASK_TARGET_URL_3 || "",
// } as const;

/**
 * Status update task URL
 */
// export const STATUS_UPDATE_TASK_URL = process.env.STATUS_UPDATE_TASK_URL || "";

/**
 * Frontend/Dashboard URL
 */
// export const DASHBOARD_URL = process.env.DASHBOARD_URL || "";

/**
 * Firebase Storage bucket for exports
 */
// export const EXPORTS_BUCKET = process.env.EXPORTS_BUCKET || "";

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

/**
 * Validates that required environment variables are set
 * @param variables Object mapping variable names to values
 * @throws Error if any required variable is missing
 */
// export function validateEnvironmentVariables(
//   variables: Record<string, string | undefined>
// ): void {
//   const missing: string[] = [];

//   for (const [name, value] of Object.entries(variables)) {
//     if (!value || value.trim() === "") {
//       missing.push(name);
//     }
//   }

//   if (missing.length > 0) {
//     throw new Error(
//       `Missing required environment variables: ${missing.join(", ")}`
//     );
//   }
// }

/**
 * Validates Cloud Tasks configuration
 * @throws Error if configuration is invalid
 */
// export function validateCloudTasksConfig(): void {
//   validateEnvironmentVariables({
//     GCP_PROJECT: CLOUD_TASKS_CONFIG.projectId,
//     TASKS_LOCATION: CLOUD_TASKS_CONFIG.location,
//     SHIPMENT_QUEUE_NAME: CLOUD_TASKS_CONFIG.shipmentQueueName,
//   });
// }

/**
 * Validates shipment task URLs
 * @throws Error if URLs are missing
 */
// export function validateShipmentTaskUrls(): void {
//   validateEnvironmentVariables({
//     SHIPMENT_TASK_TARGET_URL_1: SHIPMENT_TASK_URLS.delhivery,
//     SHIPMENT_TASK_TARGET_URL_2: SHIPMENT_TASK_URLS.shiprocket,
//     SHIPMENT_TASK_TARGET_URL_3: SHIPMENT_TASK_URLS.xpressbees,
//   });
// }

/**
 * Get courier task URL by courier name
 * @param courier Courier name (lowercase)
 * @returns Task URL for the courier
 * @throws Error if courier is not supported
 */
// export function getCourierTaskUrl(courier: string): string {
//   const courierLower = courier.toLowerCase();

//   switch (courierLower) {
//     case "delhivery":
//       return SHIPMENT_TASK_URLS.delhivery;
//     case "shiprocket":
//       return SHIPMENT_TASK_URLS.shiprocket;
//     case "xpressbees":
//       return SHIPMENT_TASK_URLS.xpressbees;
//     default:
//       throw new Error(`Unsupported courier: ${courier}`);
//   }
// }

/**
 * Get return task URL by courier name
 * @param courier Courier name (lowercase)
 * @returns Return task URL for the courier
 * @throws Error if courier is not supported
 */
// export function getReturnTaskUrl(courier: string): string {
//   const courierLower = courier.toLowerCase();

//   switch (courierLower) {
//     case "delhivery":
//       return RETURN_TASK_URLS.delhivery;
//     case "shiprocket":
//       return RETURN_TASK_URLS.shiprocket;
//     case "xpressbees":
//       return RETURN_TASK_URLS.xpressbees;
//     default:
//       throw new Error(`Unsupported courier for returns: ${courier}`);
//   }
// }

// ============================================================================
// SECRET VALIDATION
// ============================================================================

/**
 * Validates that a secret matches the expected value
 * @param provided Provided secret
 * @param expected Expected secret
 * @returns true if secrets match
 */
// export function validateSecret(provided: string, expected: string): boolean {
//   if (!expected || expected.trim() === "") {
//     throw new Error("Expected secret is not configured");
//   }
//   return provided === expected;
// }

/**
 * Validates header secret for Cloud Tasks authentication
 * @param req Express request object
 * @param headerName Header name to check
 * @param expectedSecret Expected secret value
 * @throws Error if secret is invalid or missing
 */
// export function requireTaskHeaderSecret(
//   req: any,
//   headerName: string,
//   expectedSecret: string
// ): void {
//   const providedSecret = req.headers[headerName];

//   if (!providedSecret) {
//     throw new Error(`Missing required header: ${headerName}`);
//   }

//   if (!validateSecret(String(providedSecret), expectedSecret)) {
//     throw new Error("Invalid secret");
//   }
// }

// ============================================================================
// TYPE EXPORTS
// ============================================================================

// export type CloudTasksConfig = typeof CLOUD_TASKS_CONFIG;
// export type ShipmentTaskUrls = typeof SHIPMENT_TASK_URLS;
// export type ReturnTaskUrls = typeof RETURN_TASK_URLS;
