// functions/src/agent/tools/analyticalTools.ts
//
// In-memory analytical operations on DataStore handles.
// All functions are synchronous (no Firestore reads).
//
// Data types in the store:
//   'docs'   — flat array of plain objects
//   'groups' — array of { _groupKey: string, _count: number, _docs: any[] }
//
// Most tools return a new handle + schema.
// Terminal tools (sumField, countDocs, getTopN, listDocs) return actual values.

import { DataStore } from '../dataStore';
import { getNestedValue, inferSchema } from './utils';

// ── flattenArrayField ──────────────────────────────────────────────────────────
// Explodes an array field so each element becomes its own top-level doc.
// Essential for aggregating across line_items inside orders.
//
// e.g. flattenArrayField(ordersHandle, "raw.line_items")
//   → each line item object becomes a doc
//   → optionally carry over parent fields (e.g. "id", "customStatus") for context
export function flattenArrayField(params: {
  handle: string;
  arrayFieldPath: string;
  mergeParentFields?: string[]; // parent fields to copy onto each flattened item
}, dataStore: DataStore): {
  handle: string; count: number; type: 'docs'; schema: Record<string, string>;
} {
  const docs = dataStore.getDocs(params.handle);
  const flattened: any[] = [];

  for (const doc of docs) {
    const arr = getNestedValue(doc, params.arrayFieldPath);
    if (!Array.isArray(arr)) continue;

    const parentData: any = {};
    for (const f of (params.mergeParentFields ?? [])) {
      parentData[`_parent_${f.replace(/\./g, '_')}`] = getNestedValue(doc, f);
    }

    for (const item of arr) {
      if (typeof item === 'object' && item !== null) {
        flattened.push({ ...item, ...parentData });
      } else {
        flattened.push({ _value: item, ...parentData });
      }
    }
  }

  const handle = dataStore.put(flattened, 'docs');
  return { handle, count: flattened.length, type: 'docs', schema: inferSchema(flattened) };
}

// ── groupBy ───────────────────────────────────────────────────────────────────
// Groups docs by the distinct values at a field path.
// Returns a 'groups' handle: each group has _groupKey, _count, _docs.
export function groupBy(params: {
  handle: string;
  fieldPath: string;
}, dataStore: DataStore): {
  handle: string; groupCount: number; type: 'groups';
  schema: Record<string, string>;
} {
  const docs = dataStore.getDocs(params.handle);
  const groupMap = new Map<string, any[]>();

  for (const doc of docs) {
    const val = getNestedValue(doc, params.fieldPath);
    const key = val === undefined || val === null ? '__null__' : String(val);
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(doc);
  }

  const groups = Array.from(groupMap.entries()).map(([key, groupDocs]) => ({
    _groupKey: key,
    _count: groupDocs.length,
    _docs: groupDocs,
  }));

  const handle = dataStore.put(groups, 'groups');
  return {
    handle,
    groupCount: groups.length,
    type: 'groups',
    schema: { _groupKey: 'string', _count: 'number', _docs: 'array(docs)' },
  };
}

// ── sumGrouped ────────────────────────────────────────────────────────────────
// For each group, sums a numeric field across all _docs in that group.
// Converts the groups handle to a docs handle of { _key, _sum }.
export function sumGrouped(params: {
  handle: string;     // groups handle
  fieldPath: string;  // numeric field path inside each doc
}, dataStore: DataStore): {
  handle: string; count: number; type: 'docs'; schema: Record<string, string>;
} {
  const groups = dataStore.getGroups(params.handle);
  const result = groups.map(group => ({
    _key: group._groupKey,
    _count: group._count,
    _sum: group._docs.reduce((acc: number, doc: any) => {
      const val = getNestedValue(doc, params.fieldPath);
      return acc + (Number(val) || 0);
    }, 0),
  }));

  const handle = dataStore.put(result, 'docs');
  return {
    handle, count: result.length, type: 'docs',
    schema: { _key: 'string', _count: 'number', _sum: 'number' },
  };
}

// ── countGrouped ──────────────────────────────────────────────────────────────
// Converts a groups handle to a flat docs handle of { _key, _count }.
// Use when you only need the count per group, not a sum of a numeric field.
export function countGrouped(params: {
  handle: string; // groups handle
}, dataStore: DataStore): {
  handle: string; count: number; type: 'docs'; schema: Record<string, string>;
} {
  const groups = dataStore.getGroups(params.handle);
  const result = groups.map(group => ({
    _key: group._groupKey,
    _count: group._count,
  }));

  const handle = dataStore.put(result, 'docs');
  return {
    handle, count: result.length, type: 'docs',
    schema: { _key: 'string', _count: 'number' },
  };
}

// ── filterDocs ────────────────────────────────────────────────────────────────
// Client-side filter on a docs handle. Useful for narrowing down results
// after a Firestore query (e.g. filter to specific vendor after fetching orders).
export function filterDocs(params: {
  handle: string;
  fieldPath: string;
  operator: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'includes' | 'startsWith' | 'in';
  value: any; // for 'in', pass an array
}, dataStore: DataStore): {
  handle: string; count: number; type: 'docs'; schema: Record<string, string>;
} {
  const docs = dataStore.getDocs(params.handle);
  const filtered = docs.filter(doc => {
    const val = getNestedValue(doc, params.fieldPath);
    const v = params.value;
    switch (params.operator) {
      case '==':         return val === v || String(val) === String(v);
      case '!=':         return val !== v && String(val) !== String(v);
      case '>':          return Number(val) > Number(v);
      case '>=':         return Number(val) >= Number(v);
      case '<':          return Number(val) < Number(v);
      case '<=':         return Number(val) <= Number(v);
      case 'includes':   return typeof val === 'string' && val.toLowerCase().includes(String(v).toLowerCase());
      case 'startsWith': return typeof val === 'string' && val.startsWith(String(v));
      case 'in':         return Array.isArray(v) && v.some(iv => String(iv) === String(val));
      default:           return false;
    }
  });

  const handle = dataStore.put(filtered, 'docs');
  return { handle, count: filtered.length, type: 'docs', schema: inferSchema(filtered) };
}

// ── sortBy ────────────────────────────────────────────────────────────────────
// Sorts a docs handle by a field. Returns a new handle with the sorted array.
export function sortBy(params: {
  handle: string;
  fieldPath: string;
  direction: 'asc' | 'desc';
}, dataStore: DataStore): {
  handle: string; count: number; type: 'docs'; schema: Record<string, string>;
} {
  const docs = [...dataStore.getDocs(params.handle)];
  docs.sort((a, b) => {
    const va = getNestedValue(a, params.fieldPath);
    const vb = getNestedValue(b, params.fieldPath);
    let cmp: number;
    if (typeof va === 'string' && typeof vb === 'string') {
      cmp = va.localeCompare(vb);
    } else {
      cmp = (Number(va) || 0) - (Number(vb) || 0);
    }
    return params.direction === 'desc' ? -cmp : cmp;
  });

  const handle = dataStore.put(docs, 'docs');
  return { handle, count: docs.length, type: 'docs', schema: inferSchema(docs) };
}

// ── limitDocs ─────────────────────────────────────────────────────────────────
// Takes the first N docs from a handle.
export function limitDocs(params: {
  handle: string;
  n: number;
}, dataStore: DataStore): {
  handle: string; count: number; type: 'docs'; schema: Record<string, string>;
} {
  const docs = dataStore.getDocs(params.handle).slice(0, params.n);
  const handle = dataStore.put(docs, 'docs');
  return { handle, count: docs.length, type: 'docs', schema: inferSchema(docs) };
}

// ── sumField [TERMINAL] ───────────────────────────────────────────────────────
// Sums a numeric field across all docs. Returns a value, not a handle.
// Use as the last step when you just need a total number.
export function sumField(params: {
  handle: string;
  fieldPath: string;
}, dataStore: DataStore): { total: number; docCount: number } {
  const docs = dataStore.getDocs(params.handle);
  let total = 0;
  for (const doc of docs) {
    total += Number(getNestedValue(doc, params.fieldPath)) || 0;
  }
  return { total: Math.round(total * 100) / 100, docCount: docs.length };
}

// ── countDocs [TERMINAL] ──────────────────────────────────────────────────────
// Returns the number of docs in a handle.
export function countDocs(params: {
  handle: string;
}, dataStore: DataStore): { count: number } {
  return { count: dataStore.getDocs(params.handle).length };
}

// ── getTopN [TERMINAL] ────────────────────────────────────────────────────────
// Sorts a docs handle by a numeric field and returns the top N as actual data.
// Use as the final step in ranking queries (e.g. "top 3 selling products").
export function getTopN(params: {
  handle: string;
  sortFieldPath: string;
  n: number;
  direction: 'asc' | 'desc';
}, dataStore: DataStore): { results: Record<string, any>[]; count: number } {
  const docs = [...dataStore.getDocs(params.handle)];
  docs.sort((a, b) => {
    const va = Number(getNestedValue(a, params.sortFieldPath)) || 0;
    const vb = Number(getNestedValue(b, params.sortFieldPath)) || 0;
    return params.direction === 'desc' ? vb - va : va - vb;
  });
  const results = docs.slice(0, params.n);
  return { results, count: results.length };
}

// ── listDocs [TERMINAL] ───────────────────────────────────────────────────────
// Returns up to N docs as actual data, optionally projecting specific fields.
// Use as the final step when the agent needs to show records to the user.
export function listDocs(params: {
  handle: string;
  n?: number;
  fields?: string[]; // if provided, only these fields are included in output
}, dataStore: DataStore): { results: Record<string, any>[]; count: number } {
  const raw = dataStore.getDocs(params.handle).slice(0, params.n ?? 20);
  if (!params.fields || params.fields.length === 0) {
    return { results: raw, count: raw.length };
  }
  const projected = raw.map(doc => {
    const out: any = {};
    for (const f of params.fields!) {
      out[f] = getNestedValue(doc, f);
    }
    return out;
  });
  return { results: projected, count: projected.length };
}

// ── mergeByKey ────────────────────────────────────────────────────────────────
// Joins multiple docs handles on a shared key field, merging their fields.
// Useful when you have two parallel aggregations (e.g. _sum and _count from
// different sumGrouped calls on the same groups) and want one combined row.
export function mergeByKey(params: {
  handles: string[];
  keyField: string; // field to join on (usually '_key')
}, dataStore: DataStore): {
  handle: string; count: number; type: 'docs'; schema: Record<string, string>;
} {
  const mergedMap = new Map<string, any>();

  for (const h of params.handles) {
    const docs = dataStore.getDocs(h);
    for (const doc of docs) {
      const key = doc[params.keyField];
      if (!mergedMap.has(key)) mergedMap.set(key, { [params.keyField]: key });
      Object.assign(mergedMap.get(key), doc);
    }
  }

  const merged = Array.from(mergedMap.values());
  const handle = dataStore.put(merged, 'docs');
  return { handle, count: merged.length, type: 'docs', schema: inferSchema(merged) };
}