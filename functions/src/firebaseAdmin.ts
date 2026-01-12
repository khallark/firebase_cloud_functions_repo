// functions/src/firebaseAdmin.ts
import * as admin from "firebase-admin";

let _db: admin.firestore.Firestore | null = null;
let _storage: admin.storage.Storage | null = null;

function ensureInit() {
  try {
    admin.app(); // will throw if no default app
  } catch {
    admin.initializeApp(); // create default app
  }
}

export const db: admin.firestore.Firestore = new Proxy({} as admin.firestore.Firestore, {
  get(_target, prop: keyof admin.firestore.Firestore) {
    ensureInit();
    if (!_db) {
      _db = admin.firestore();
    }
    return _db[prop];
  },
});

export const storage: admin.storage.Storage = new Proxy({} as admin.storage.Storage, {
  get(_target, prop: keyof admin.storage.Storage) {
    ensureInit();
    if (!_storage) {
      _storage = admin.storage();
    }
    return _storage[prop];
  },
});
