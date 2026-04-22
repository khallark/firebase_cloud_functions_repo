// functions/src/agent/tools/queryFirestore.ts
//
// Fetches documents from any Firestore collection and stores them
// in the per-invocation DataStore under a UUID handle.
//
// Returns only: { handle, count, type, schema, note? }
// Raw data never leaves the server — the agent uses the handle
// to pass to analytical tools.
//
// Special path conventions:
//   "accounts/*/orders"          → auto-expands to all stores for this business
//   "users/{businessId}/products" → {businessId} substituted automatically

import { db } from '../../firebaseAdmin';
import { Query, Timestamp, WhereFilterOp } from 'firebase-admin/firestore';
import { DataStore } from '../dataStore';
import { inferSchema, serializeDoc, selectFields } from './utils';

// Hard cap: protect Cloud Function memory and timeout
const MAX_DOCS_PER_STORE = 1000;
const MAX_TOTAL_DOCS = 3000;

/** Try to convert a string value to a Firestore Timestamp if it looks like a date. */
function parseFilterValue(value: any): any {
  if (typeof value !== 'string') return value;
  // ISO date or datetime
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.+Z-]*)?$/.test(value)) {
    const normalized = value.includes('T') ? value : `${value}T00:00:00+05:30`;
    const d = new Date(normalized);
    if (!isNaN(d.getTime())) return Timestamp.fromDate(d);
  }
  return value;
}

export interface QueryFirestoreParams {
  path: string;
  filters?: Array<{ field: string; operator: string; value: any }>;
  orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  select?: string[];
  businessId: string;
}

export interface QueryFirestoreResult {
  handle: string;
  count: number;
  type: 'docs';
  schema: Record<string, string>;
  note?: string;
}

export async function queryFirestore(
  params: QueryFirestoreParams,
  dataStore: DataStore,
): Promise<QueryFirestoreResult> {
  const effectiveLimit = Math.min(params.limit ?? MAX_TOTAL_DOCS, MAX_TOTAL_DOCS);
  let collectionPaths: string[] = [];

  // ── Path resolution ─────────────────────────────────────────────────────────
  const resolvedPath = params.path.replace('{businessId}', params.businessId);

  if (resolvedPath.includes('*/')) {
    // Multi-store wildcard: accounts/*/orders → accounts/{storeId}/orders for each store
    const bizDoc = await db.collection('users').doc(params.businessId).get();
    if (!bizDoc.exists) throw new Error(`Business ${params.businessId} not found`);
    const stores: string[] = bizDoc.data()?.stores ?? [];
    if (stores.length === 0) {
      const handle = dataStore.put([], 'docs');
      return { handle, count: 0, type: 'docs', schema: {} };
    }
    collectionPaths = stores.map(storeId => resolvedPath.replace('*', storeId));
  } else {
    collectionPaths = [resolvedPath];
  }

  const isMultiPath = collectionPaths.length > 1;
  const perPathLimit = isMultiPath
    ? Math.min(Math.ceil(effectiveLimit / collectionPaths.length), MAX_DOCS_PER_STORE)
    : effectiveLimit;

  // ── Query each path ─────────────────────────────────────────────────────────
  const allDocs: any[] = [];

  for (const collPath of collectionPaths) {
    const segments = collPath.split('/');
    if (segments.length % 2 === 0) {
      throw new Error(`Invalid collection path (even segment count = document path): "${collPath}"`);
    }

    let ref: Query = db.collection(collPath);

    for (const filter of (params.filters ?? [])) {
      const val = parseFilterValue(filter.value);
      ref = ref.where(filter.field, filter.operator as WhereFilterOp, val);
    }

    for (const ob of (params.orderBy ?? [])) {
      ref = ref.orderBy(ob.field, ob.direction);
    }

    ref = ref.limit(perPathLimit);

    const snap = await ref.get();
    for (const doc of snap.docs) {
      let data = serializeDoc({ id: doc.id, ...doc.data() });
      if (params.select && params.select.length > 0) {
        data = selectFields(data, ['id', ...params.select]);
      }
      allDocs.push(data);
    }
  }

  // ── Trim to total limit and store ───────────────────────────────────────────
  const finalDocs = allDocs.slice(0, effectiveLimit);
  const handle = dataStore.put(finalDocs, 'docs');
  const schema = inferSchema(finalDocs);

  const note = finalDocs.length >= effectiveLimit
    ? `Results capped at ${effectiveLimit} documents. Aggregations reflect this sample only.`
    : undefined;

  return {
    handle,
    count: finalDocs.length,
    type: 'docs',
    schema,
    ...(note ? { note } : {}),
  };
}