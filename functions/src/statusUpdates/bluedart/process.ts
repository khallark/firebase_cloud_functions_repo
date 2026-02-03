import { onRequest } from "firebase-functions/v2/https";
import { TASKS_SECRET } from "../../config";
import { maybeCompleteBatch, requireHeaderSecret } from "../../helpers";
import { FieldValue, Transaction } from "firebase-admin/firestore";
import { getBlueDartToken, handleJobError, queueNextChunk } from "../helpers";
import { processBlueDartOrderChunk } from "./processChunk";
import { db } from "../../firebaseAdmin";

export const updateBlueDartStatusesJob = onRequest(
  { cors: true, timeoutSeconds: 540, secrets: [TASKS_SECRET], memory: "512MiB" },
  async (req, res) => {
    try {
      requireHeaderSecret(req, "x-tasks-secret", TASKS_SECRET.value() || "");

      if (req.method !== "POST") {
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }

      const {
        accountId,
        businessId,
        batchId,
        jobId,
        cursor = null,
        chunkIndex = 0,
      } = req.body as {
        accountId?: string;
        businessId?: string;
        batchId?: string;
        jobId?: string;
        cursor?: string | null;
        chunkIndex?: number;
      };

      if (!accountId || !businessId || !batchId || !jobId) {
        res.status(400).json({ error: "missing_required_params" });
        return;
      }

      const batchRef = db.collection("status_update_batches").doc(batchId);
      const jobRef = batchRef.collection("jobs").doc(jobId);

      // Idempotency check
      const jSnap = await jobRef.get();
      if (jSnap.exists && jSnap.data()?.status === "success") {
        res.json({ ok: true, dedup: true });
        return;
      }

      // Initialize job on first chunk
      if (chunkIndex === 0) {
        await db.runTransaction(async (tx: Transaction) => {
          const snap = await tx.get(jobRef);
          const data = snap.data() || {};
          const prevAttempts = Number(data.attempts || 0);
          const firstAttempt = prevAttempts === 0 || data.status === "queued";

          tx.set(
            jobRef,
            {
              status: "processing",
              attempts: (prevAttempts || 0) + 1,
              lastAttemptAt: FieldValue.serverTimestamp(),
              accountId,
              businessId,
              processedOrders: 0,
              updatedOrders: 0,
              totalChunks: 0,
            },
            { merge: true },
          );

          const inc: any = { processing: FieldValue.increment(1) };
          if (firstAttempt) inc.queued = FieldValue.increment(-1);
          tx.update(batchRef, inc);
        });
      }

      // ── Verify business exists ──────────────────────────────────────────────
      const businessDoc = await db.collection("users").doc(businessId).get();
      if (!businessDoc.exists) throw new Error("ACCOUNT_NOT_FOUND");

      // ── Extract & validate Blue Dart credentials ────────────────────────────
      // loginId          → embedded in the tracking GET URL
      // trackingLicenceKey → embedded in the tracking GET URL (distinct from
      //                      licenceKey used during shipment creation)
      // appApiKey        → sent as ClientID header to the token endpoint
      // appApiSecret     → sent as clientSecret header to the token endpoint
      const blueDartConfig = businessDoc.data()?.integrations?.couriers?.bluedart;
      const loginId          = blueDartConfig?.loginId;
      const trackingLicenceKey = blueDartConfig?.trackingLicenceKey;
      const appApiKey        = blueDartConfig?.appApiKey;
      const appApiSecret     = blueDartConfig?.appApiSecret;

      if (!loginId || !trackingLicenceKey || !appApiKey || !appApiSecret) {
        throw new Error("BLUEDART_CREDENTIALS_MISSING");
      }

      // ── Generate JWT token for this invocation ──────────────────────────────
      // Token is generated fresh each time because Cloud Tasks are stateless —
      // there is no shared memory between chunk invocations.
      const jwtToken = await getBlueDartToken(appApiKey, appApiSecret);

      // ── Process one chunk of orders ──────────────────────────────────────────
      const result = await processBlueDartOrderChunk(
        accountId,
        jwtToken,
        loginId,
        trackingLicenceKey,
        cursor,
      );

      // Update job progress
      await jobRef.update({
        processedOrders: FieldValue.increment(result.processed),
        updatedOrders: FieldValue.increment(result.updated),
        totalChunks: FieldValue.increment(1),
        lastChunkAt: FieldValue.serverTimestamp(),
        lastCursor: result.nextCursor || FieldValue.delete(),
      });

      // If more work remains, queue next chunk
      if (result.hasMore && result.nextCursor) {
        await queueNextChunk(
          TASKS_SECRET.value() || "",
          process.env.BLUEDART_UPDATE_STATUS_TASK_JOB_TARGET_URL!,
          {
            accountId,
            businessId,
            batchId,
            jobId,
            chunkIndex: chunkIndex + 1,
            cursor: result.nextCursor,
          },
        );

        res.json({
          ok: true,
          status: "chunk_completed",
          chunkIndex,
          processed: result.processed,
          updated: result.updated,
          hasMore: true,
        });
        return;
      }

      // Job complete
      const jobData = (await jobRef.get()).data() || {};
      await Promise.all([
        jobRef.update({
          status: "success",
          message: "status_update_completed",
          completedAt: FieldValue.serverTimestamp(),
        }),
        batchRef.update({
          processing: FieldValue.increment(-1),
          success: FieldValue.increment(1),
        }),
      ]);

      await maybeCompleteBatch(batchRef);

      res.json({
        ok: true,
        status: "job_completed",
        totalProcessed: jobData.processedOrders || 0,
        totalUpdated: jobData.updatedOrders || 0,
        totalChunks: jobData.totalChunks || 0,
      });
    } catch (error: any) {
      await handleJobError(error, req.body);
      const msg = error.message || String(error);
      const code = msg.split(/\s/)[0];

      const NON_RETRYABLE = [
        "ACCOUNT_NOT_FOUND",
        "BLUEDART_CREDENTIALS_MISSING",
        "BLUEDART_AUTH_FAILED",
        "BLUEDART_AUTH_TOKEN_MISSING",
        "NO_VALID_USERS_FOR_ACCOUNT",
      ];
      const isRetryable = !NON_RETRYABLE.includes(code);

      res.status(isRetryable ? 503 : 200).json({
        ok: false,
        error: isRetryable ? "job_failed_transient" : "job_failed_permanent",
        code,
        message: msg,
      });
    }
  },
);