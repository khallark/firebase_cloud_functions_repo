// services/cloudTasks/taskService.ts

import { CloudTasksClient } from "@google-cloud/tasks";
import { TASKS_SECRET } from "../../config";

const client = new CloudTasksClient();

export interface CloudTaskConfig {
  tasksSecret: string;
  url: string;
  queue: string;
  delaySeconds?: number;
}

/**
 * Creates a Cloud Task with the given payload
 *
 * @param payload - The data to send to the task handler
 * @param config - Cloud Task configuration (queue, URL, secret, delay)
 * @returns Task name
 */
export async function createTask(payload: any, config: CloudTaskConfig): Promise<string> {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  const location = process.env.CLOUD_TASKS_LOCATION || "asia-south1";

  if (!projectId) {
    throw new Error("GCLOUD_PROJECT or GCP_PROJECT environment variable not set");
  }

  const parent = client.queuePath(projectId, location, config.queue);

  const task: any = {
    httpRequest: {
      httpMethod: "POST",
      url: config.url,
      headers: {
        "Content-Type": "application/json",
        "X-Tasks-Secret": config.tasksSecret,
      },
      body: Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
  };

  // Add delay if specified
  if (config.delaySeconds && config.delaySeconds > 0) {
    const scheduleTime = new Date();
    scheduleTime.setSeconds(scheduleTime.getSeconds() + config.delaySeconds);
    task.scheduleTime = {
      seconds: Math.floor(scheduleTime.getTime() / 1000),
    };
  }

  const [response] = await client.createTask({ parent, task });

  console.log(`Created task ${response.name}`);

  return response.name || "";
}

/**
 * Creates multiple Cloud Tasks in parallel
 *
 * @param payloads - Array of payloads for each task
 * @param config - Cloud Task configuration (same for all tasks)
 * @returns Array of task names
 */
export async function createTasks(payloads: any[], config: CloudTaskConfig): Promise<string[]> {
  const tasks = payloads.map((payload) => createTask(payload, config));
  return Promise.all(tasks);
}

export const PROPAGATION_QUEUE = "propagation-queue";
export const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
export const LOCATION = process.env.CLOUD_TASKS_LOCATION || "asia-south1";

export async function enqueuePropogationTask(task: any, taskId?: string) {
  const queuePath = client.queuePath(PROJECT_ID!, LOCATION, PROPAGATION_QUEUE);

  const url = `https://${LOCATION}-${PROJECT_ID}.cloudfunctions.net/processPropagationTask`;

  const taskPayload = {
    httpRequest: {
      httpMethod: "POST" as const,
      url,
      headers: {
        "Content-Type": "application/json",
        "X-Tasks-Secret": TASKS_SECRET.value()!,
      },
      body: Buffer.from(JSON.stringify(task)).toString("base64"),
    },
    // Optional: Add task name for deduplication
    ...(taskId && { name: client.taskPath(PROJECT_ID!, LOCATION, PROPAGATION_QUEUE, taskId) }),
  };

  try {
    await client.createTask({ parent: queuePath, task: taskPayload });
  } catch (error: any) {
    // Task already exists (409) - that's OK for deduplication
    if (error.code !== 6) {
      // 6 = ALREADY_EXISTS
      throw error;
    }
  }
}
