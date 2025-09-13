// functions/src/cloudTasks.ts
import { v2 as cloudtasks } from "@google-cloud/tasks";
import type { protos as tasksProtos } from "@google-cloud/tasks";

const client = new cloudtasks.CloudTasksClient();

export interface CreateTaskPayload {
  shop: string;
  batchId: string;
  jobId: string;
  pickupName?: string | null;
  shippingMode?: string | null;
}

export interface CreateTaskOptions {
  /** Secret value that the processing endpoint will check in x-tasks-secret */
  tasksSecret?: string;
  /** Full URL of the Cloud Function that handles one job. */
  targetUrl?: string;
  /** Queue config overrides */
  projectId?: string;
  location?: string;
  queueName?: string;
  /** Optional delay in seconds */
  delaySeconds?: number;
  /** Additional headers to include */
  headers?: Record<string, string>;
}

/** Create a single HTTP task for processing one shipment job. */
export async function createTask(
  payload: CreateTaskPayload,
  opts: CreateTaskOptions = {},
): Promise<void> {
  const projectId = opts.projectId || process.env.GCLOUD_PROJECT || process.env.PROJECT_ID;
  const location = opts.location || process.env.LOCATION || "asia-south1";
  const queueName = opts.queueName || process.env.TASKS_QUEUE || "shipments-queue";
  const targetUrl =
    opts.targetUrl ||
    process.env.PROCESS_TASK_URL ||
    `https://${location}-${projectId}.cloudfunctions.net/processShipmentTask`;

  const parent = client.queuePath(projectId!, location, queueName);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.headers || {}),
  };
  const tasksSecret = opts.tasksSecret || process.env.TASKS_SECRET;
  if (tasksSecret) headers["x-tasks-secret"] = tasksSecret;

  // Use the top-level protos type (not v2.protos)
  const task: tasksProtos.google.cloud.tasks.v2.ITask = {
    httpRequest: {
      httpMethod: "POST",
      url: targetUrl,
      headers,
      body: Buffer.from(JSON.stringify(payload)),
      // If you later move to OIDC instead of header secrets:
      // oidcToken: { serviceAccountEmail: process.env.TASKS_SA_EMAIL! },
    },
  };

  if (opts.delaySeconds && opts.delaySeconds > 0) {
    task.scheduleTime = {
      seconds: Math.floor(Date.now() / 1000) + opts.delaySeconds,
    };
  }

  await client.createTask({ parent, task });
}
