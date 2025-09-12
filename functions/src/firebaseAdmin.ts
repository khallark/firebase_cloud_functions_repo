// functions/src/firebaseAdmin.ts
import { getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

// Resolve project & bucket
const projectId =
  process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;

// Prefer explicit env (from functions/.env). Falls back to the conventional default.
const storageBucket =
  process.env.STORAGE_BUCKET || (projectId ? `${projectId}.appspot.com` : undefined);

// Init once
if (!getApps().length) {
  initializeApp({
    credential: applicationDefault(),
    ...(storageBucket ? { storageBucket } : {}),
  });
}

// Firestore + helpers
export const db = getFirestore();
export { FieldValue };

// Storage bucket (used by the packing slip uploader)
export const bucket = getStorage().bucket(); // uses storageBucket set above
