// functions/src/cloudTasks.ts
import { v2 as cloudtasks } from "@google-cloud/tasks";
import type { protos as tasksProtos } from "@google-cloud/tasks";

const client = new cloudtasks.CloudTasksClient();

export interface CreateTaskPayload {
  shop: string;
  batchId: string;
  jobId: string;
  courier: string;
  pickupName: string;
  shippingMode: string;
}

export interface CreateTaskOptions {
  /** Pass the Tasks secret from the caller (mounted via defineSecret). */
  tasksSecret: string;

  /** Optional overrides for tests/local runs */
  url?: string;
  queue?: string;
  location?: string;

  /** Optional delay before dispatch (seconds) */
  delaySeconds?: number;
}

export async function createTask(
  payload: CreateTaskPayload,
  opts: CreateTaskOptions,
): Promise<void> {
  const project =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    (await client.getProjectId());

  const location = process.env.LOCATION;
  const queue = process.env.QUEUE_NAME;
  const url =
    payload.courier === "Delhivery" ? process.env.TASK_TARGET_URL : process.env.TASK_TARGET_URL_2;

  if (!location || !queue || !url) {
    throw new Error("Missing env: LOCATION / QUEUE_NAME / TASK_TARGET_URL");
  }
  if (!opts.tasksSecret) {
    throw new Error("Missing tasksSecret");
  }

  const parent = client.queuePath(project, location, queue);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Tasks-Secret": opts.tasksSecret,
  };

  // Use the top-level protos type (not v2.protos)
  const task: tasksProtos.google.cloud.tasks.v2.ITask = {
    httpRequest: {
      httpMethod: "POST",
      url,
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
