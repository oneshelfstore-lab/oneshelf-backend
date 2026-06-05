import admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let initialized = false;

export function initFirebase(): void {
  if (initialized) return;

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  try {
    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      initialized = true;
      console.log("Firebase Admin SDK initialized (from inline JSON).");
    } else if (serviceAccountPath) {
      // Resolve relative to the process working dir (the backend folder), not this source file.
      const absPath = resolve(process.cwd(), serviceAccountPath);
      const serviceAccount = JSON.parse(readFileSync(absPath, "utf8"));
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      initialized = true;
      console.log(`Firebase Admin SDK initialized (from ${absPath}).`);
    } else {
      console.warn(
        "WARNING: No Firebase service account configured. Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON in .env. Firebase auth bridge will reject all requests.",
      );
    }
  } catch (e) {
    console.error("ERROR: Failed to initialize Firebase Admin SDK:", (e as Error).message);
    console.error("Firebase auth bridge will reject all requests until this is fixed.");
  }
}

export function isFirebaseInitialized(): boolean {
  return initialized;
}

export { admin };
