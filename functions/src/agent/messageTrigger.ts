// // functions/src/agent/messageTrigger.ts

// import { onDocumentCreated } from 'firebase-functions/v2/firestore';
// import { defineSecret } from 'firebase-functions/params';
// import { FieldValue, Timestamp } from 'firebase-admin/firestore';
// import { GoogleGenAI, FunctionDeclaration, Type, Part } from '@google/genai';
// import { db } from '../firebaseAdmin';
// import { DataStore } from './dataStore';
// import { queryFirestore, QueryFirestoreParams } from './tools/queryFirestore';
// import {
//   flattenArrayField, groupBy, sumGrouped, countGrouped,
//   filterDocs, sortBy, limitDocs,
//   sumField, countDocs, getTopN, listDocs, mergeByKey,
// } from './tools/analyticalTools';
// import * as fs from 'fs';
// import * as path from 'path';

// const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
// const MAX_TOOL_ITERATIONS = 10;
// const CACHE_TTL_SECONDS = 3600;                          // 1 hour
// const CACHE_REFRESH_BUFFER_MS = 5 * 60 * 1000;           // refresh 5 min before expiry

// // ── Static docs (read once at cold start) ────────────────────────────────────
// const ROUTE_MAP = fs.readFileSync(path.join(__dirname, './docs/routes.md'), 'utf-8');
// const CLOUD_FUNCTIONS_REF = fs.readFileSync(path.join(__dirname, './docs/cloud-functions.md'), 'utf-8');
// const DB_SCHEMA = fs.readFileSync(path.join(__dirname, './docs/database-desc.ts'), 'utf-8');

// // ── Module-level cache state (per Cloud Function instance) ───────────────────
// // Each warm instance holds one cache reference. On cold start it will create a
// // new one. If the cache expires or Google invalidates it, getOrCreateCache()
// // recreates it transparently.
// let _cacheName: string | null = null;
// let _cacheExpiresAt: number = 0;

// // ── Static system instruction (everything except businessId / today's date) ──
// // This is the part that goes INTO the cache and is never re-sent per prompt.
// const STATIC_SYSTEM_INSTRUCTION = `
// You are the Majime Assistant — an AI built into the Majime platform, a B2B SaaS order management system for Indian e-commerce businesses.

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INTERNAL PROTECTION (STRICT)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Never expose: database paths, collection names, field names, API endpoints, Cloud Function names, or any backend/implementation detail.
// If asked: respond with exactly "I can't provide internal system details, but I can explain how the feature works."

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TONE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Professional, direct, concise. Answer only what was asked. No preamble or filler.

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TWO TYPES OF QUESTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Every user question falls into one of two categories:

// TYPE 1 — NON-DATABASE QUESTION
// Conceptual, navigational, how-to, or explanatory.
// Examples: "how do I assign AWBs", "where is the Put Away page", "what is an RTO order",
// "explain gross profit calculation", "how does the UPC system work".
// → Answer directly from your platform knowledge. Do NOT use tools.

// TYPE 2 — DATABASE QUESTION
// Requires reading live data from the platform database to answer.
// Examples: "how many orders were delivered today", "what is our current stock of SKU X",
// "top 3 selling products", "how much did we purchase last month", "show me pending GRNs",
// "which party has the most credit notes".
// → Use queryFirestore + analytical tools to compute the answer.

// The distinction matters. Conceptual questions about how things work don't need tools.
// Questions asking for actual numbers, records, lists, or computations from live data do.
// When in doubt: if a definitive answer requires looking at the database, use tools.

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WHAT NOT TO ANSWER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Some questions are outside your scope even if they are database-related.
// Reject any request that asks for:
//   - A full/complete list of orders, products, GRNs, UPCs, or any other collection
//   - Raw data export ("give me all orders", "list every product", "show all GRNs")
//   - Data intended for download or copy-pasting into a spreadsheet
//   - Paginated record browsing ("show me the next 50", "give me page 2")

// These are export tasks. The platform has dedicated export features for this.

// When you detect such a request, respond with exactly:
//   "This looks like a data export request. Please use the export/download
//    feature on the relevant page for complete record lists."

// VALID database questions stay analytical:
//   ✓ "how many orders were dispatched this month"
//   ✓ "what is our top selling product"
//   ✓ "total purchase value from supplier X"
//   ✓ "which SKUs are out of stock"
//   ✗ "give me all dispatched orders"
//   ✗ "list every order from this month"
//   ✗ "show me all products"

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DATABASE ACCESS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// You have full read access to the platform database via queryFirestore.
// The complete database schema is provided in the cached context you already have.
// Read it carefully — it documents every collection, every document type,
// every field, all relationships, and how data is connected across collections.

// When a database question arrives:
// 1. Identify which collection(s) contain the data needed.
// 2. Determine which fields to query and filter on.
// 3. Understand the relationships — e.g. orders contain line_items with variantId
//    which links to products via variantMappingDetails; GRNs link to POs via poId; etc.
// 4. Build the query chain using queryFirestore + analytical tools.
// 5. Use a TERMINAL tool (getTopN, listDocs, sumField, countDocs) to produce the final answer.

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HANDLE / SCHEMA SYSTEM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// queryFirestore and most analytical tools return:
//   { handle: "uuid", count: N, type: "docs"|"groups", schema: { field: type, ... } }

// - handle = opaque server-side reference to in-memory data. Never show handles to the user.
// - schema = field map of the docs in that handle. Use it to know what fields are available for subsequent tools.
// - type "docs" = flat array of plain objects.
// - type "groups" = array of { _groupKey, _count, _docs }. Use with sumGrouped or countGrouped.
// - Chain tools by passing the handle output of one as the handle input of the next.
// - TERMINAL tools (getTopN, listDocs, sumField, countDocs) return actual values — use those to formulate your answer.

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOL CHAINING PATTERN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Standard chain for aggregate analytical queries:
//   1. queryFirestore        → docs handle (fetch from DB)
//   2. flattenArrayField     → docs handle (if docs embed arrays like line_items or items[])
//   3. filterDocs            → docs handle (optional client-side narrowing)
//   4. groupBy               → groups handle
//   5. sumGrouped or countGrouped → docs handle { _key, _sum/_count }
//   6. getTopN / listDocs / sumField / countDocs → FINAL VALUES → answer

// Example — "Top 3 highest selling products in the last 30 days":
//   1. queryFirestore("users/{businessId}/inventory_snapshots",
//        filters=[date >= startDate, date <= endDate],
//        select=["productId", "dailySales"])
//   2. groupBy(h1, "productId")
//   3. sumGrouped(h2, "dailySales")
//   4. getTopN(h3, "_sum", 3, "desc")
// Do NOT use orders.raw.line_items for this unless the user specifically asks for order-level/store-level sales.

// Example — "Total value of GRNs received this month":
//   1. queryFirestore("users/{businessId}/grns", filters=[status==completed, receivedAt>=2025-05-01], select=["totalReceivedValue"])
//   2. sumField(h1, "totalReceivedValue") → present total

// Example — "How many Confirmed orders do we have right now":
//   1. queryFirestore("accounts/*/orders", filters=[customStatus==Confirmed], select=["id"])
//   2. countDocs(h1) → present count

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOL SELECTION GUIDE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// queryFirestore     → fetch documents from any collection for analysis
// flattenArrayField  → explode embedded array fields (line_items, items[], etc.)
// groupBy            → group docs by a field value
// sumGrouped         → sum a numeric field within each group → { _key, _sum }
// countGrouped       → count docs within each group → { _key, _count }
// filterDocs         → narrow docs client-side mid-chain
// sortBy             → sort docs by a field mid-chain
// limitDocs          → take first N docs mid-chain
// sumField     [T]   → single numeric total across all docs
// countDocs    [T]   → total doc count
// getTopN      [T]   → ranked top-N by numeric field, returns actual data
// listDocs     [T]   → return specific records to show user (use fields to project)
// mergeByKey         → combine two { _key, ... } aggregations on shared _key
// [T] = TERMINAL — returns actual values, not a handle

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// IMPORTANT CAVEATS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// - queryFirestore is capped at 3000 docs total. For "all time" queries, always note
//   "based on the last N records fetched" — results may not reflect complete history.
// - When a tool returns { note: "..." }, always include that note in your answer.
// - Multi-store paths (accounts/*/orders) automatically expand to all linked stores.
// - When a tool returns { error: "..." }, try a corrected approach or tell the user
//   honestly that you couldn't retrieve that data.

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DATE RESOLUTION (when tools are needed)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// today       → startDate = endDate = today's date
// this week   → startDate = Monday of current week, endDate = today
// this month  → startDate = 1st of current month, endDate = today
// yesterday   → startDate = endDate = yesterday
// No date mentioned → ask the user before calling any tool.

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HALLUCINATION GUARD
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Never invent platform features, order statuses, or field names.
// If uncertain about something non-database: "I'm not sure. Please check the relevant page."
// If a database query returns unexpected results, report what you found rather than guessing.
// `.trim();

// // ── Tool declarations ─────────────────────────────────────────────────────────

// const TOOL_DECLARATIONS: FunctionDeclaration[] = [
//   {
//     name: 'queryFirestore',
//     description:
//       'Fetch documents from any Firestore collection for analysis. ' +
//       'Returns { handle, count, type, schema } — NOT raw data. ' +
//       'Pass the handle to analytical tools to compute results.\n\n' +
//       'Path conventions:\n' +
//       '  "accounts/*/orders"           → all stores for this business (auto-expanded)\n' +
//       '  "users/{businessId}/products" → {businessId} auto-substituted\n' +
//       '  "users/{businessId}/grns"\n' +
//       '  "users/{businessId}/upcs"\n' +
//       '  "users/{businessId}/credit_notes"\n' +
//       '  "users/{businessId}/parties"\n' +
//       '  "users/{businessId}/purchaseOrders"\n' +
//       '  etc. — any collection documented in the database schema.',
//     parameters: {
//       type: Type.OBJECT,
//       properties: {
//         path: {
//           type: Type.STRING,
//           description: 'Collection path. Use accounts/*/orders for all stores. Use {businessId} for business collections.',
//         },
//         filters: {
//           type: Type.ARRAY,
//           description: 'Firestore where() filters.',
//           items: {
//             type: Type.OBJECT,
//             properties: {
//               field: { type: Type.STRING },
//               operator: { type: Type.STRING, description: '==, !=, <, <=, >, >=, in, array-contains, array-contains-any.' },
//               value: { type: Type.STRING, description: 'Filter value. Dates "YYYY-MM-DD" are auto-converted to Timestamps. For "in", pass a JSON array string e.g. "[\"Delivered\",\"Closed\"]".' },
//             },
//             required: ['field', 'operator', 'value'],
//           },
//         },
//         orderBy: {
//           type: Type.ARRAY,
//           items: {
//             type: Type.OBJECT,
//             properties: {
//               field: { type: Type.STRING },
//               direction: { type: Type.STRING, description: '"asc" or "desc".' },
//             },
//             required: ['field', 'direction'],
//           },
//         },
//         limit: {
//           type: Type.NUMBER,
//           description: 'Max total docs (hard cap: 3000). Omit for all-time aggregations.',
//         },
//         select: {
//           type: Type.ARRAY,
//           description: 'Field paths to keep. Always include only fields you will use analytically — reduces memory.',
//           items: { type: Type.STRING },
//         },
//       },
//       required: ['path'],
//     },
//   },

//   {
//     name: 'flattenArrayField',
//     description:
//       'Explode an array field so each element becomes its own doc. ' +
//       'Essential for aggregating across embedded arrays such as raw.line_items inside orders. ' +
//       'e.g. 100 orders × 5 items each → 500 item docs. Returns a docs handle.',
//     parameters: {
//       type: Type.OBJECT,
//       properties: {
//         handle: { type: Type.STRING },
//         arrayFieldPath: { type: Type.STRING, description: 'e.g. "raw.line_items", "items".' },
//         mergeParentFields: {
//           type: Type.ARRAY,
//           description: 'Parent field paths to copy onto each flattened item (prefixed with _parent_). e.g. ["id", "customStatus", "createdAt"].',
//           items: { type: Type.STRING },
//         },
//       },
//       required: ['handle', 'arrayFieldPath'],
//     },
//   },

//   {
//     name: 'groupBy',
//     description:
//       'Group docs by the distinct values at a field path. ' +
//       'Returns a groups handle with _groupKey, _count, _docs per group. ' +
//       'Follow with sumGrouped or countGrouped to aggregate.',
//     parameters: {
//       type: Type.OBJECT,
//       properties: {
//         handle: { type: Type.STRING },
//         fieldPath: { type: Type.STRING, description: 'e.g. "sku", "vendor", "customStatus", "productId".' },
//       },
//       required: ['handle', 'fieldPath'],
//     },
//   },

//   {
//     name: 'sumGrouped',
//     description:
//       'Sum a numeric field across all docs in each group. ' +
//       'Returns a docs handle of { _key, _count, _sum } per group.',
//     parameters: {
//       type: Type.OBJECT,
//       properties: {
//         handle: { type: Type.STRING, description: 'Groups handle from groupBy.' },
//         fieldPath: { type: Type.STRING, description: 'Numeric field inside each doc. e.g. "quantity", "price", "totalReceivedValue".' },
//       },
//       required: ['handle', 'fieldPath'],
//     },
//   },

//   {
//     name: 'countGrouped',
//     description: 'Convert a groups handle to a flat docs handle of { _key, _count }. Use when count per group is sufficient.',
//     parameters: {
//       type: Type.OBJECT,
//       properties: {
//         handle: { type: Type.STRING, description: 'Groups handle from groupBy.' },
//       },
//       required: ['handle'],
//     },
//   },

//   {
//     name: 'filterDocs',
//     description: 'Client-side filter on a docs handle. Use for conditions that could not be expressed in the Firestore query, or to narrow results mid-chain.',
//     parameters: {
//       type: Type.OBJECT,
//       properties: {
//         handle: { type: Type.STRING },
//         fieldPath: { type: Type.STRING },
//         operator: { type: Type.STRING, description: '==, !=, >, >=, <, <=, includes (string contains), startsWith, in (value is JSON array string).' },
//         value: { type: Type.STRING, description: 'For "in", pass a JSON array string.' },
//       },
//       required: ['handle', 'fieldPath', 'operator', 'value'],
//     },
//   },

//   {
//     name: 'sortBy',
//     description: 'Sort a docs handle by a field. Returns a new sorted docs handle.',
//     parameters: {
//       type: Type.OBJECT,
//       properties: {
//         handle: { type: Type.STRING },
//         fieldPath: { type: Type.STRING },
//         direction: { type: Type.STRING, description: '"asc" or "desc".' },
//       },
//       required: ['handle', 'fieldPath', 'direction'],
//     },
//   },

//   {
//     name: 'limitDocs',
//     description: 'Take the first N docs from a handle. Returns a new docs handle.',
//     parameters: {
//       type: Type.OBJECT,
//       properties: {
//         handle: { type: Type.STRING },
//         n: { type: Type.NUMBER },
//       },
//       required: ['handle', 'n'],
//     },
//   },

//   {
//     name: 'sumField',
//     description: 'TERMINAL. Sum a numeric field across all docs. Returns { total, docCount }. Use as the last step when you need a single total.',
//     parameters: {
//       type: Type.OBJECT,
//       properties: {
//         handle: { type: Type.STRING },
//         fieldPath: { type: Type.STRING, description: 'e.g. "totalReceivedValue", "_sum", "raw.total_price".' },
//       },
//       required: ['handle', 'fieldPath'],
//     },
//   },

//   {
//     name: 'countDocs',
//     description: 'TERMINAL. Count docs in a handle. Returns { count }.',
//     parameters: {
//       type: Type.OBJECT,
//       properties: {
//         handle: { type: Type.STRING },
//       },
//       required: ['handle'],
//     },
//   },

//   {
//     name: 'getTopN',
//     description: 'TERMINAL. Sort docs by a numeric field and return the top N as actual data. Returns { results, count }. Use as the final step in ranking queries.',
//     parameters: {
//       type: Type.OBJECT,
//       properties: {
//         handle: { type: Type.STRING },
//         sortFieldPath: { type: Type.STRING, description: 'Numeric field to rank by. e.g. "_sum", "_count".' },
//         n: { type: Type.NUMBER },
//         direction: { type: Type.STRING, description: '"desc" for highest first, "asc" for lowest first.' },
//       },
//       required: ['handle', 'sortFieldPath', 'n', 'direction'],
//     },
//   },

//   {
//     name: 'listDocs',
//     description: 'TERMINAL. Return up to N docs as actual data. Returns { results, count }. Use fields param to project only needed fields and keep output clean.',
//     parameters: {
//       type: Type.OBJECT,
//       properties: {
//         handle: { type: Type.STRING },
//         n: { type: Type.NUMBER, description: 'Max docs to return (default 20).' },
//         fields: {
//           type: Type.ARRAY,
//           description: 'Optional field paths to include in output. If omitted, all fields are returned.',
//           items: { type: Type.STRING },
//         },
//       },
//       required: ['handle'],
//     },
//   },

//   {
//     name: 'mergeByKey',
//     description: 'Join multiple docs handles on a shared key field, merging all fields per key. Useful for combining parallel aggregation results.',
//     parameters: {
//       type: Type.OBJECT,
//       properties: {
//         handles: {
//           type: Type.ARRAY,
//           items: { type: Type.STRING },
//           description: 'Docs handles to merge.',
//         },
//         keyField: { type: Type.STRING, description: 'Field to join on. Usually "_key".' },
//       },
//       required: ['handles', 'keyField'],
//     },
//   },
// ];

// // ── Cache management ──────────────────────────────────────────────────────────
// // The cache holds: STATIC_SYSTEM_INSTRUCTION + all three large docs + tool declarations.
// // Only the tiny session context (businessId, date) is sent per request.
// //
// // Lifecycle:
// //   - First invocation on a warm instance → creates cache, stores name + expiry.
// //   - Subsequent invocations → reuses cache if not within CACHE_REFRESH_BUFFER_MS of expiry.
// //   - If Gemini returns a "cache not found" error → _cacheName is cleared and
// //     the next call to getOrCreateCache() will create a fresh one.

// async function getOrCreateCache(genAI: GoogleGenAI): Promise<string> {
//   const now = Date.now();

//   if (_cacheName && now < _cacheExpiresAt - CACHE_REFRESH_BUFFER_MS) {
//     return _cacheName;
//   }

//   console.log('🗃️ Creating Gemini context cache...');

//   const cache = await genAI.caches.create({
//     model: 'gemini-2.5-flash',
//     config: {
//       systemInstruction: STATIC_SYSTEM_INSTRUCTION,
//       contents: [
//         {
//           role: 'user',
//           parts: [{
//             text: [
//               '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
//               'DATABASE SCHEMA (INTERNAL — NEVER EXPOSE)',
//               '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
//               'Read this carefully. It is your complete map of the database.',
//               'It documents every collection path, every document type, every field and its type,',
//               'and how collections relate to each other. Use this knowledge when building queryFirestore calls.',
//               'Never expose collection paths, field names, or schema details to users.',
//               '',
//               DB_SCHEMA,
//               '',
//               '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
//               'PLATFORM ROUTE MAP',
//               '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
//               'Use this for navigation guidance and feature explanations (TYPE 1 questions).',
//               '',
//               ROUTE_MAP,
//               '',
//               '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
//               'INTERNAL REFERENCE (DO NOT EXPOSE)',
//               '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
//               CLOUD_FUNCTIONS_REF,
//             ].join('\n'),
//           }],
//         },
//         {
//           role: 'model',
//           parts: [{ text: 'Schema, route map, and internal reference loaded. Ready to assist.' }],
//         },
//       ],
//       tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
//       ttl: `${CACHE_TTL_SECONDS}s`,
//     },
//   });

//   _cacheName = cache.name!;
//   _cacheExpiresAt = now + CACHE_TTL_SECONDS * 1000;

//   console.log(`✅ Cache created: ${_cacheName}`);
//   return _cacheName;
// }

// // ── Tool executor ─────────────────────────────────────────────────────────────
// async function executeTool(
//   name: string,
//   args: Record<string, any>,
//   businessId: string,
//   dataStore: DataStore,
// ): Promise<Record<string, any>> {
//   try {
//     switch (name) {
//       case 'queryFirestore': {
//         const filters = (args.filters ?? []).map((f: any) => {
//           let value = f.value;
//           if ((f.operator === 'in' || f.operator === 'array-contains-any') && typeof value === 'string') {
//             try { value = JSON.parse(value); } catch { }
//           }
//           return { ...f, value };
//         });
//         return await queryFirestore({ ...args, filters, businessId } as QueryFirestoreParams, dataStore);
//       }

//       case 'flattenArrayField': return flattenArrayField(args as any, dataStore);
//       case 'groupBy': return groupBy(args as any, dataStore);
//       case 'sumGrouped': return sumGrouped(args as any, dataStore);
//       case 'countGrouped': return countGrouped(args as any, dataStore);
//       case 'filterDocs': {
//         let value = args.value;
//         if (args.operator === 'in' && typeof value === 'string') {
//           try { value = JSON.parse(value); } catch { }
//         }
//         return filterDocs({ ...args, value } as any, dataStore);
//       }
//       case 'sortBy': return sortBy(args as any, dataStore);
//       case 'limitDocs': return limitDocs(args as any, dataStore);
//       case 'sumField': return sumField(args as any, dataStore);
//       case 'countDocs': return countDocs(args as any, dataStore);
//       case 'getTopN': return getTopN(args as any, dataStore);
//       case 'listDocs': {
//         const cappedParams = {
//           ...args,
//           n: Math.min(args.n ?? 25, 25),
//         };
//         return listDocs(cappedParams as any, dataStore);
//       }
//       case 'mergeByKey': return mergeByKey(args as any, dataStore);

//       default: return { error: `Unknown tool: "${name}"` };
//     }
//   } catch (err) {
//     const msg = err instanceof Error ? err.message : String(err);
//     console.error(`❌ executeTool("${name}") error:`, msg);
//     return { error: msg };
//   }
// }

// // ── Session context (tiny — sent per request, not cached) ────────────────────
// // Only businessId and today's date change per invocation. Everything else is cached.
// function buildSessionContext(businessId: string): string {
//   const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
//   const pad = (n: number) => String(n).padStart(2, '0');
//   const todayIST = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

//   return [
//     '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
//     'CURRENT SESSION',
//     '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
//     `Business ID:  ${businessId}`,
//     `Platform URL: https://www.majime.in/business/${businessId}/`,
//     `Today (IST):  ${todayIST}`,
//   ].join('\n');
// }

// // ── Main trigger ──────────────────────────────────────────────────────────────
// export const onAgentMessageCreated = onDocumentCreated(
//   {
//     document: 'users/{businessId}/agent_sessions/{sessionId}/messages/{messageId}',
//     memory: '512MiB',
//     timeoutSeconds: 540,
//     maxInstances: 10,
//     secrets: [GEMINI_API_KEY],
//   },
//   async (event) => {
//     const { businessId, sessionId } = event.params;
//     const message = event.data?.data();
//     if (!message || message.role !== 'user') return;

//     const sessionRef = db.collection('users').doc(businessId)
//       .collection('agent_sessions').doc(sessionId);
//     const messagesRef = sessionRef.collection('messages');

//     // DataStore scoped to this invocation — never at module level
//     const dataStore = new DataStore();

//     const FALLBACK = "I'm having trouble connecting right now. Please try again in a moment.";
//     const EXHAUSTED = "I wasn't able to complete that in the allowed steps. Please try rephrasing.";

//     try {
//       await sessionRef.update({
//         status: 'generating',
//         generatingStartedAt: Timestamp.now(),
//         lastActivityAt: FieldValue.serverTimestamp(),
//       });

//       const historySnap = await messagesRef.orderBy('createdAt', 'asc').get();
//       const allMessages = historySnap.docs.map(d => d.data());
//       const historyMessages = allMessages.slice(0, -1);

//       type Content = { role: string; parts: Part[] };

//       const geminiHistory: Content[] = historyMessages.map(m => ({
//         role: m.role === 'assistant' ? 'model' : 'user',
//         parts: [{ text: m.content as string }],
//       }));

//       // Session context pair — prepended to every conversation.
//       // Tiny (< 100 tokens) so it's fine to send per request.
//       const sessionCtx: Content[] = [
//         { role: 'user', parts: [{ text: buildSessionContext(businessId) }] },
//         { role: 'model', parts: [{ text: 'Understood.' }] },
//       ];

//       let replyContent = '';

//       try {
//         const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY.value() });

//         // Get or create the cache. On a cache-miss error we clear the name
//         // and retry once so the next request creates a fresh cache.
//         let cacheName: string;
//         try {
//           cacheName = await getOrCreateCache(genAI);
//         } catch (cacheErr) {
//           console.warn('⚠️ Cache creation failed, falling back to uncached prompt:', cacheErr);
//           cacheName = '';
//         }

//         let contents: Content[] = [
//           ...sessionCtx,
//           ...geminiHistory,
//           { role: 'user', parts: [{ text: message.content as string }] },
//         ];

//         for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
//           const requestConfig: Record<string, any> = {
//             temperature: 0.3,
//             maxOutputTokens: 2048,
//           };

//           if (cacheName) {
//             // Cached path — schema, routes, tools, and static system instruction
//             // are all read from the cache. Only session context + conversation
//             // are sent over the wire.
//             requestConfig.cachedContent = cacheName;
//           } else {
//             // Fallback uncached path (e.g. cache creation failed).
//             // Reconstruct the full prompt so the request still works.
//             requestConfig.systemInstruction = [
//               STATIC_SYSTEM_INSTRUCTION,
//               '',
//               buildSessionContext(businessId),
//               '',
//               '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
//               'DATABASE SCHEMA (INTERNAL — NEVER EXPOSE)',
//               '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
//               DB_SCHEMA,
//               '',
//               '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
//               'PLATFORM ROUTE MAP',
//               '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
//               ROUTE_MAP,
//               '',
//               '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
//               'INTERNAL REFERENCE (DO NOT EXPOSE)',
//               '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
//               CLOUD_FUNCTIONS_REF,
//             ].join('\n');
//             requestConfig.tools = [{ functionDeclarations: TOOL_DECLARATIONS }];
//           }

//           const result = await genAI.models.generateContent({
//             model: 'gemini-2.5-flash',
//             config: requestConfig,
//             contents,
//           });

//           // If Gemini signals the cache is gone, clear our reference so
//           // the next invocation on this instance recreates it.
//           const finishReason = result.candidates?.[0]?.finishReason;
//           if (typeof finishReason === 'string' && finishReason.includes('CACHE')) {
//             console.warn('⚠️ Cache invalidated by Gemini — will recreate on next invocation.');
//             _cacheName = null;
//           }

//           const candidate = result.candidates?.[0];
//           if (!candidate) { replyContent = FALLBACK; break; }

//           const parts = candidate.content?.parts ?? [];
//           const fnPart = parts.find(p => p.functionCall != null);
//           const txtPart = parts.find(p => p.text != null);

//           if (fnPart?.functionCall) {
//             const { name, args } = fnPart.functionCall;
//             console.log(`🔧 Tool [${i + 1}/${MAX_TOOL_ITERATIONS}]: ${name}`);

//             const toolResult = await executeTool(
//               name as string,
//               (args ?? {}) as Record<string, any>,
//               businessId,
//               dataStore,
//             );

//             const resultPreview = (toolResult as any).count
//               ?? (toolResult as any).total
//               ?? (toolResult as any).results?.length
//               ?? (toolResult as any).error
//               ?? '?';
//             console.log(`✅ [${name}] → ${resultPreview}`);

//             contents = [
//               ...contents,
//               { role: 'model', parts: [{ functionCall: { name: name as string, args: args ?? {} } }] },
//               { role: 'user', parts: [{ functionResponse: { name: name as string, response: toolResult } }] },
//             ];

//           } else if (txtPart?.text) {
//             replyContent = txtPart.text;
//             break;
//           } else {
//             replyContent = FALLBACK;
//             break;
//           }
//         }

//         if (!replyContent) {
//           console.warn(`⚠️ Exhausted ${MAX_TOOL_ITERATIONS} iterations`);
//           replyContent = EXHAUSTED;
//         }

//       } catch (geminiErr) {
//         console.error('❌ Gemini API error:', geminiErr);
//         replyContent = FALLBACK;
//       }

//       const assistantRef = messagesRef.doc();
//       await assistantRef.set({
//         id: assistantRef.id,
//         role: 'assistant',
//         content: replyContent,
//         createdAt: Timestamp.now(),
//       });

//       await sessionRef.update({
//         status: 'idle',
//         generatingStartedAt: null,
//         lastActivityAt: FieldValue.serverTimestamp(),
//       });

//     } catch (err) {
//       console.error('❌ onAgentMessageCreated error:', err);
//       await sessionRef.update({
//         status: 'error',
//         generatingStartedAt: null,
//         lastActivityAt: FieldValue.serverTimestamp(),
//       }).catch(() => { });
//     }
//   },
// );