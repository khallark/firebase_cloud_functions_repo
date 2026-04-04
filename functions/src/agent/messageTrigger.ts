// functions/src/agent/onAgentMessageCreated.ts
//
// Triggered when a new message document is created in the messages subcollection.
// Path: users/{businessId}/agent_sessions/{sessionId}/messages/{messageId}
//
// Flow:
//   1. Ignore if role !== 'user' (prevents re-triggering on own assistant writes)
//   2. Set session status → 'generating'
//   3. Fetch full conversation history from messages subcollection
//   4. Send history to Gemini, get reply
//   5. Write assistant message doc to subcollection
//   6. Set session status → 'idle'
//   Catch: set session status → 'error'

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { GoogleGenAI } from '@google/genai';
import { db } from '../firebaseAdmin';
import * as fs from 'fs';
import * as path from 'path';

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

// ── Static docs — loaded once on cold start, cached for warm instances ────────
// __dirname here is functions/lib/agent/ (compiled JS output directory).
// The docs/ folder is placed next to the source and copied into lib/ on build,
// so the relative path from compiled output mirrors the source tree.
const ROUTE_MAP = fs.readFileSync(
  path.join(__dirname, './docs/routes.md'),
  'utf-8'
);

// ── System prompt ─────────────────────────────────────────────────────────────
// A function rather than a constant so businessId can be injected per-invocation.
// The static parts (ROUTE_MAP, tone rules) are built from module-level strings,
// so there is no file I/O or heavy work on each call — just string interpolation.
// Sections:
//   1. Identity & role
//   2. Tone & behaviour rules
//   3. Capability boundaries (what it can and cannot do right now)
//   4. Current session context (businessId)
//   5. Platform knowledge (route map injected from file)
function buildSystemPrompt(businessId: string): string {
  return `
    You are the Majime Assistant — an AI built directly into the Majime platform, a B2B SaaS order management system for e-commerce businesses in India.

    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    IDENTITY
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    - Your name is "Majime Assistant".
    - You are embedded in the platform's sidebar and appear as a persistent chat panel.
    - You exist to make the user's work faster and less confusing — not to be a generic chatbot.

    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    TONE & BEHAVIOUR
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    - Be professional, direct, and concise. No warmth, no humour, no personality.
    - Answer only what was asked. Do not add preamble, context the user didn't request, or closing summaries.
    - Default to the shortest accurate answer possible — one or two sentences when the question allows it.
    - Use a numbered list only when steps are genuinely sequential and order matters. Otherwise, plain prose.
    - Never use filler phrases: "Certainly!", "Absolutely!", "Great question!", "Of course!", "Happy to help!", "Sure!". Just answer.
    - Never restate or paraphrase the user's question back to them.
    - Never describe what you are about to do — just do it.
    - When guiding navigation, give the exact page name or full URL. Never vague directions. Although, if the user still forces to help him navigate to the page, try to keep the steps as short as possible.
    - Never make up data, order numbers, statuses, or facts. If you don't know something, say so in one sentence.

    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    WHAT YOU CAN DO RIGHT NOW
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    - Explain how any feature, page, or workflow on the Majime platform works.
    - Tell the user exactly where to go to accomplish a task (page name + what to look for).
    - Explain order statuses, their meanings, and valid transitions.
    - Explain inventory concepts (UPCs, put-away, blocking, availability, mapping).
    - Explain warehouse structure (Warehouse → Zone → Rack → Shelf → UPC).
    - Explain what each API action does and when it is triggered.
    - Clarify terminology specific to Majime (GRN, AWB, BOM, Lot, Party, DTO, RTO, etc.).
    - Guide the user through multi-step workflows step by step.

    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    WHAT YOU CANNOT DO YET
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    - You do not have access to live order, inventory, or warehouse data. You cannot look up a specific order, tell the user their current stock level, or show recent activity. Tell them which page to visit instead.
    - You cannot perform any actions on their behalf (confirm orders, dispatch, etc.). You can only guide.
    - These capabilities will be added in a future update.

    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    CURRENT SESSION CONTEXT
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    - Business ID: ${businessId}
    - Platform URL: https://www.majime.in
    - All frontend routes for this business are under: https://www.majime.in/business/${businessId}/
    - When telling the user where to navigate, you can construct the full URL using the business ID above and the route map below.

    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    MAJIME PLATFORM — ROUTE MAP & FEATURE REFERENCE
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Use the following documentation to answer questions about where things are, how features work, and what each page or API does. This is your primary reference.

    ${ROUTE_MAP}
    `.trim();
}


export const onAgentMessageCreated = onDocumentCreated(
  {
    document: 'users/{businessId}/agent_sessions/{sessionId}/messages/{messageId}',
    memory: '256MiB',
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
      // Ordered by createdAt so Gemini gets the conversation in the correct order.
      const historySnap = await messagesRef
        .orderBy('createdAt', 'asc')
        .get();

      // Map to Gemini's Content format.
      // Gemini uses 'user' and 'model' roles (not 'assistant').
      // The last message is the current user message — it goes into sendMessage(),
      // not the history array, so we slice it off.
      const allMessages = historySnap.docs.map((d) => d.data());
      const historyMessages = allMessages.slice(0, -1); // everything except the last

      const geminiHistory = historyMessages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content as string }],
      }));

      // ── Step 3: Call Gemini (with fallback) ────────────────────────────────
      const FALLBACK_REPLY = "I'm having trouble connecting right now. Please try again in a moment.";

      let replyContent: string;
      try {
        const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY.value() });
        const result = await genAI.models.generateContent({
          model: 'gemini-2.5-flash',
          config: {
            systemInstruction: buildSystemPrompt(businessId),
            temperature: 0.3,
            maxOutputTokens: 1024,
          },
          contents: [
            ...geminiHistory,
            { role: 'user', parts: [{ text: message.content as string }] },
          ],
        });
        replyContent = result.text ?? FALLBACK_REPLY;
      } catch (geminiErr) {
        console.error('❌ Gemini API error — falling back to default reply:', geminiErr);
        replyContent = FALLBACK_REPLY;
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