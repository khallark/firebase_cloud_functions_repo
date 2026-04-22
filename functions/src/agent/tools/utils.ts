// functions/src/agent/tools/utils.ts
//
// Shared helpers used across queryFirestore and analyticalTools.

/** Get a value at a dot-notation path from an object. */
export function getNestedValue(obj: any, path: string): any {
  const parts = path.split('.');
  let val = obj;
  for (const part of parts) {
    if (val === null || val === undefined) return undefined;
    val = val[part];
  }
  return val;
}

/**
 * Infer a flat schema from the first doc in an array.
 * Traverses up to `maxDepth` levels deep and caps at `maxFields` entries.
 * Arrays are represented as "array(N)" with sub-schema from their first element.
 */
export function inferSchema(docs: any[], maxFields = 50, maxDepth = 3): Record<string, string> {
  if (docs.length === 0) return {};
  const schema: Record<string, string> = {};
  let fieldCount = 0;

  function traverse(obj: any, prefix: string, depth: number) {
    if (fieldCount >= maxFields || depth > maxDepth || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      schema[prefix] = `array(${obj.length})`;
      fieldCount++;
      if (obj.length > 0 && typeof obj[0] === 'object' && !Array.isArray(obj[0])) {
        traverse(obj[0], `${prefix}[]`, depth + 1);
      }
      return;
    }
    for (const key of Object.keys(obj)) {
      if (fieldCount >= maxFields) break;
      const fullKey = prefix ? `${prefix}.${key}` : key;
      const val = obj[key];
      if (val === null || val === undefined) {
        schema[fullKey] = 'null'; fieldCount++;
      } else if (Array.isArray(val)) {
        schema[fullKey] = `array(${val.length})`; fieldCount++;
        if (val.length > 0 && typeof val[0] === 'object') {
          traverse(val[0], `${fullKey}[]`, depth + 1);
        }
      } else if (typeof val === 'object') {
        traverse(val, fullKey, depth + 1);
      } else {
        schema[fullKey] = typeof val; fieldCount++;
      }
    }
  }

  traverse(docs[0], '', 0);
  return schema;
}

/**
 * Recursively serialize a Firestore document.
 * Converts Timestamps to ISO strings. Safe to JSON.stringify.
 */
export function serializeDoc(doc: any): any {
  if (doc === null || doc === undefined) return doc;
  if (typeof doc !== 'object') return doc;
  // Firestore admin SDK Timestamp
  if (doc.toDate && typeof doc.toDate === 'function') return doc.toDate().toISOString();
  // Raw _seconds/_nanoseconds form
  if (typeof doc._seconds === 'number' && typeof doc._nanoseconds === 'number') {
    return new Date(doc._seconds * 1000).toISOString();
  }
  if (Array.isArray(doc)) return doc.map(serializeDoc);
  const result: any = {};
  for (const key of Object.keys(doc)) {
    result[key] = serializeDoc(doc[key]);
  }
  return result;
}

/** Pick a subset of dot-notation fields from a doc. */
export function selectFields(doc: any, fields: string[]): any {
  const result: any = {};
  for (const field of fields) {
    const parts = field.split('.');
    const val = getNestedValue(doc, field);
    let target = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]]) target[parts[i]] = {};
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = val;
  }
  return result;
}