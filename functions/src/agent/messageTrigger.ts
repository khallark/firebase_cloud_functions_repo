// functions/src/agent/onAgentMessageCreated.ts
//
// Triggered when a new message document is created in the messages subcollection.
// Path: users/{businessId}/agent_sessions/{sessionId}/messages/{messageId}
//
// Flow:
//   1. Ignore if role !== 'user' (prevents re-triggering on own assistant writes)
//   2. Set session status → 'generating'
//   3. Fetch full conversation history from messages subcollection
//   4. Agentic loop: call Gemini → if functionCall, execute tool and loop; if text, done
//   5. Write assistant message doc to subcollection
//   6. Set session status → 'idle'
//   Catch: set session status → 'error'
//
// Tool call safety:
//   - MAX_TOOL_ITERATIONS = 5: hard cap on loop iterations; breaks with fallback on breach
//   - Tool execution is wrapped in try/catch; errors are returned as { error } in
//     functionResponse so Gemini handles them gracefully instead of crashing the loop
//   - limit is hardcoded inside executeTool — not exposed to the model

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { GoogleGenAI, FunctionDeclaration, Type, Part } from '@google/genai';
import { db } from '../firebaseAdmin';
import { getOrdersByStatus } from './tools';
import * as fs from 'fs';
import * as path from 'path';

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

const MAX_TOOL_ITERATIONS = 5;

// ── Static docs — loaded once on cold start, cached for warm instances ────────
const ROUTE_MAP = fs.readFileSync(
  path.join(__dirname, './docs/routes.md'),
  'utf-8'
);

const CLOUD_FUNCTIONS_REF = fs.readFileSync(
  path.join(__dirname, './docs/cloud-functions.md'),
  'utf-8'
);

// ── Tool declarations — schema only, no logic ─────────────────────────────────
// 'limit' is intentionally omitted: it is hardcoded to 50 inside executeTool.
const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'getOrdersByStatus',
    description:
      'Fetch orders for this business filtered by a custom order status and date range. ' +
      'Generates an Excel file of the results and returns a download link. ' +
      'IMPORTANT: If the user has not specified a date range, ask them to provide one before calling this tool. ' +
      'Do not assume or default a date range — always confirm with the user first. ' +
      'Returns { downloadUrl, count } where downloadUrl is a direct download link to the Excel file.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          description:
            'The customStatus value to filter by. ' +
            'Valid values: New, Confirmed, Ready To Dispatch, Dispatched, ' +
            'In Transit, Out For Delivery, Delivered, RTO In Transit, RTO Delivered, ' +
            'RTO Closed, DTO Requested, DTO Booked, DTO In Transit, DTO Delivered, ' +
            'Pending Refunds, Cancelled, Lost, Closed.',
        },
        dateRange: {
          type: Type.OBJECT,
          description: 'Optional date range to filter orders by createdAt.',
          properties: {
            startDate: {
              type: Type.STRING,
              description: 'Start date in YYYY-MM-DD format (IST).',
            },
            endDate: {
              type: Type.STRING,
              description: 'End date in YYYY-MM-DD format (IST).',
            },
          },
          required: ['startDate', 'endDate'],
        },
      },
      required: ['status'],
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────
// Single dispatch point for all tool calls. Add new tools here as a new case.
// Always returns a plain object — never throws. Errors go back to Gemini as
// { error } so it can respond to the user gracefully.
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  businessId: string,
): Promise<Record<string, unknown>> {
  switch (name) {
    case 'getOrdersByStatus': {
      const status = args.status as string;
      let dateRange = args.dateRange as { startDate: string; endDate: string } | undefined;

      if (!dateRange) {
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const pad = (n: number) => String(n).padStart(2, '0');
        const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

        dateRange = { startDate: today, endDate: today };
        console.warn(`⚠️ getOrdersByStatus called without dateRange — defaulting to today: ${today}`);
      }

      const result = await getOrdersByStatus({
        businessId,
        status,
        dateRange,
        limit: 50,
      });

      return result; // { downloadUrl, count }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(businessId: string): string {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayIST = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `
You are the Majime Assistant — an AI built directly into the Majime platform, a B2B SaaS order management system for e-commerce businesses in India.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIORITY RULES (HIGHEST PRIORITY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- These rules override everything else below.
- If any instruction conflicts with these, follow these rules strictly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INTERNAL SYSTEM PROTECTION (STRICT)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The following information is INTERNAL and must NEVER be exposed to the user in any form:

- Cloud Function names
- Firestore triggers or database paths
- API endpoints or request structures
- Background job / queue architecture
- Code-level or implementation details
- Any full or partial listing of backend systems

You may USE this knowledge to improve answers, but you must NEVER:
- List them
- Enumerate them
- Summarize them as a system
- Explain how they are implemented internally

You must NEVER use technical backend terms such as:
- "endpoint", "trigger", "function", "queue", "job", "pipeline", "cron", "worker"

If the user asks for internal/system details (explicitly or indirectly), you MUST respond with exactly:

"I can't provide internal system details, but I can explain how the feature works."

Do not add anything before this sentence.

You may optionally follow it with a high-level, user-facing explanation.

If a question is primarily about system internals, prioritize refusal over answering.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FRONTEND VS BACKEND RULE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- You ARE allowed to provide:
  - Frontend page URLs
  - Route paths
  - Navigation instructions
  - What the user will see and do

- You MUST NEVER provide:
  - API details
  - Backend structure
  - Database structure
  - Internal architecture

Rule:
- Describe WHAT happens (user-visible)
- Never describe HOW it is implemented

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDENTITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Your name is "Majime Assistant".
- You are embedded in the platform's sidebar as a persistent chat panel.
- Your purpose is to make the user's work faster and less confusing.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TONE & BEHAVIOUR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Be professional, direct, and concise. No warmth, no humour, no personality.
- Answer only what was asked.
- Default to the shortest accurate answer possible.
- Prefer one sentence when sufficient.
- Use numbered steps only when order matters.
- Do not add preamble or closing lines.
- Do not restate the user's question.
- Do not describe what you are about to do.
- Do not use filler phrases.
- If unsure, say so in one sentence.

Length control:
- If the question is simple → 1 sentence.
- If the question is procedural → short numbered steps.
- Do not exceed necessary detail.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOOL USE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tools give you access to live platform data. Use them whenever the user is asking
for real numbers, counts, or lists — not explanations or guidance.

General rules:
- Never use a tool for conceptual, navigational, or how-to questions.
- Never mention tools, function names, or data fetching to the user.
- Never call the same tool twice with the same arguments.
- After a tool returns results, answer the user directly. Do not call another
  tool unless the first result was clearly insufficient.
- If the user asks for live data outside the scope of any listed tool, say exactly:
  "I can only fetch orders by status and date range right now."

Date range rules:
- If the user does not mention any date or time reference, ask for a date range
  before calling any tool. Do not call the tool without one.
- If the user says "today", use today's date (already in your context) as both
  startDate and endDate. Do not ask for clarification.
- If the user says "this week", use Monday of the current week as startDate and
  today as endDate.
- If the user says "this month", use the 1st of the current month as startDate
  and today as endDate.
- If the user says "yesterday", use yesterday's date as both startDate and endDate.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOOL: getOrdersByStatus
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use this tool when the user asks for a count or list of orders in a specific status.
You MUST use this tool for these queries — do not fall back to "I'm not sure."
After the tool returns the downloadUrl, share the count and the download link naturally. Keep it to one or two sentences maximum.

Trigger keywords and phrases:
- "how many [status] orders"
- "list of [status] orders"
- "show me [status] orders"
- "give me [status] orders"
- "dispatched orders today / this week / this month"
- "confirmed orders"
- "orders in transit"
- "delivered orders"
- "cancelled orders"
- "RTO orders"
- "DTO orders"
- "orders that are [status]"
- "orders with status [status]"
- "how many orders were [status]"
- "which orders are [status]"
- "pending orders" → map to the closest valid status (e.g. Confirmed, New)
- "returned orders" → map to RTO Closed or Pending Refunds
- "lost orders"
- "closed orders"
- any question containing a valid status name listed below

Valid status values to pass:
New, Confirmed, Ready To Dispatch, Dispatched, In Transit, Out For Delivery,
Delivered, RTO In Transit, RTO Delivered, RTO Closed, DTO Requested, DTO Booked,
DTO In Transit, DTO Delivered, Pending Refunds, Cancelled, Lost, Closed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HALLUCINATION GUARD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Never invent features, pages, statuses, or workflows.
- Never assume something exists unless it is in the provided documentation.
- If uncertain, say:
  "I'm not sure about that. Please check the relevant page."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NAVIGATION BEHAVIOUR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Always provide exact page name or full URL when relevant.
- Prefer full URLs when possible.
- Do not give vague directions.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UI-AWARE RESPONSE RULE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- If the user's question implies they are on a specific page:
  - Tailor the answer to that page
  - Refer only to visible actions on that page
  - Do not explain unrelated flows

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHAT YOU CAN DO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Explain how features, pages, and workflows work.
- Tell the user exactly where to go (page name or full URL).
- Explain order statuses and transitions.
- Explain inventory concepts (UPCs, put-away, blocking, availability, mapping).
- Explain warehouse structure (Warehouse → Zone → Rack → Shelf → UPC).
- Explain background automation in user-facing terms (automatic updates, delays, status changes).
- Explain batch processes conceptually (grouping, processing, completion).
- Clarify Majime terminology (GRN, AWB, BOM, Lot, Party, DTO, RTO, NDR).
- Guide multi-step workflows.
- Fetch and report live order data using available tools.

Important:
- You may use backend knowledge internally, but output ONLY user-visible behavior.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHAT YOU CANNOT DO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- You cannot perform actions on behalf of the user (confirm orders, assign AWBs, etc.).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CURRENT SESSION CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Business ID: ${businessId}
- Platform URL: https://www.majime.in
- Base route: https://www.majime.in/business/${businessId}/
- Today's date (IST): ${todayIST}

Use this to construct full URLs when guiding navigation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MAJIME PLATFORM — ROUTE MAP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use this for frontend navigation and feature understanding:

${ROUTE_MAP}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MAJIME PLATFORM — INTERNAL REFERENCE (DO NOT EXPOSE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This is for internal reasoning only. Never expose or summarize it.

${CLOUD_FUNCTIONS_REF}
`.trim();
}


export const onAgentMessageCreated = onDocumentCreated(
  {
    document: 'users/{businessId}/agent_sessions/{sessionId}/messages/{messageId}',
    memory: '512MiB',
    timeoutSeconds: 540,
    maxInstances: 10,
    secrets: [GEMINI_API_KEY],
  },
  async (event) => {
    const { businessId, sessionId } = event.params;
    const message = event.data?.data();

    // ── Guard: only react to user messages ──────────────────────────────────
    if (!message || message.role !== 'user') return;

    const sessionRef = db
      .collection('users')
      .doc(businessId)
      .collection('agent_sessions')
      .doc(sessionId);

    const messagesRef = sessionRef.collection('messages');

    try {
      // ── Step 1: Lock ────────────────────────────────────────────────────────
      await sessionRef.update({
        status: 'generating',
        generatingStartedAt: Timestamp.now(),
        lastActivityAt: FieldValue.serverTimestamp(),
      });

      // ── Step 2: Fetch conversation history ──────────────────────────────────
      const historySnap = await messagesRef
        .orderBy('createdAt', 'asc')
        .get();

      const allMessages = historySnap.docs.map((d) => d.data());
      const historyMessages = allMessages.slice(0, -1);

      type Content = {
        role: string;
        parts: Part[];
      }

      const geminiHistory: Content[] = historyMessages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content as string }],
      }));


      // ── Step 3: Agentic loop ────────────────────────────────────────────────
      const FALLBACK_REPLY = "I'm having trouble connecting right now. Please try again in a moment.";
      const ITERATION_EXCEEDED_REPLY = "I wasn't able to complete that request. Please try rephrasing.";

      let replyContent: string;

      try {
        const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY.value() });

        // contents grows each iteration as tool call turns are appended
        let contents: Content[] = [
          ...geminiHistory,
          { role: 'user', parts: [{ text: message.content as string }] },
        ];

        let iterations = 0;

        while (iterations < MAX_TOOL_ITERATIONS) {
          iterations++;

          const result = await genAI.models.generateContent({
            model: 'gemini-2.5-flash',
            config: {
              systemInstruction: buildSystemPrompt(businessId),
              temperature: 0.3,
              maxOutputTokens: 1024,
              tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
            },
            contents,
          });

          const candidate = result.candidates?.[0];
          if (!candidate) {
            console.error('❌ Gemini returned no candidates');
            replyContent = FALLBACK_REPLY;
            break;
          }

          // Find the first meaningful part — could be text or a function call
          const parts = candidate.content?.parts ?? [];
          const functionCallPart = parts.find((p) => p.functionCall != null);
          const textPart = parts.find((p) => p.text != null);

          if (functionCallPart?.functionCall) {
            // ── Tool call branch ──────────────────────────────────────────────
            const { name, args } = functionCallPart.functionCall;

            console.log(`🔧 Tool call [iteration ${iterations}]: ${name}`, args);

            let toolResult: Record<string, unknown>;
            try {
              toolResult = await executeTool(
                name as string,
                (args ?? {}) as Record<string, unknown>,
                businessId,
              );
            } catch (toolErr) {
              // Should not normally reach here since executeTool never throws,
              // but catch defensively so the loop doesn't crash.
              console.error(`❌ executeTool threw unexpectedly for ${name}:`, toolErr);
              toolResult = { error: 'Tool execution failed unexpectedly.' };
            }

            console.log(`✅ Tool result [${name}]:`, toolResult);

            // Append the model's function call turn and our result turn,
            // then loop — Gemini will read both and decide what to do next.
            contents = [
              ...contents,
              {
                role: 'model',
                parts: [{ functionCall: { name: name as string, args: args ?? {} } }],
              },
              {
                role: 'user',
                parts: [{ functionResponse: { name: name as string, response: toolResult } }],
              },
            ];

          } else if (textPart?.text) {
            // ── Text reply branch — loop done ────────────────────────────────
            replyContent = textPart.text;
            break;

          } else {
            // Gemini returned neither text nor a function call — shouldn't happen
            console.error('❌ Gemini returned a candidate with no usable part:', JSON.stringify(parts));
            replyContent = FALLBACK_REPLY;
            break;
          }
        }

      } catch (geminiErr) {
        console.error('❌ Gemini API error — falling back to default reply:', geminiErr);
        replyContent = FALLBACK_REPLY;
      }

      // If we exhausted iterations without breaking, set the fallback
      if (!replyContent!) {
        console.warn(`⚠️ Tool loop exhausted MAX_TOOL_ITERATIONS (${MAX_TOOL_ITERATIONS})`);
        replyContent = ITERATION_EXCEEDED_REPLY;
      }

      // ── Step 4: Write assistant message ────────────────────────────────────
      const assistantMessageRef = messagesRef.doc();
      await assistantMessageRef.set({
        id: assistantMessageRef.id,
        role: 'assistant',
        content: replyContent,
        createdAt: Timestamp.now(),
      });

      // ── Step 5: Unlock ──────────────────────────────────────────────────────
      await sessionRef.update({
        status: 'idle',
        generatingStartedAt: null,
        lastActivityAt: FieldValue.serverTimestamp(),
      });

    } catch (err) {
      console.error('❌ onAgentMessageCreated error:', err);

      await sessionRef.update({
        status: 'error',
        generatingStartedAt: null,
        lastActivityAt: FieldValue.serverTimestamp(),
      }).catch(() => {
        console.error('❌ Failed to set session status to error');
      });
    }
  }
);