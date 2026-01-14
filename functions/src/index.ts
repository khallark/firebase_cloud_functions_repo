import { setGlobalOptions } from "firebase-functions/v2";

setGlobalOptions({ region: process.env.LOCATION || "asia-south1" });

export * from "./shipments";
export * from "./orders";
export * from "./statusUpdates";
export * from "./scheduledJobs";
export * from "./migrations";
export * from "./reports";
export * from "./warehouse";
export * from "./inventory";
