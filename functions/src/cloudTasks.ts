// functions/src/cloudTasks.ts
import { v2 as cloudtasks } from "@google-cloud/tasks";

const client = new cloudtasks.CloudTasksClient();

export async function createTask(payload: any) {
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || (await client.getProjectId());
  const location = process.env.LOCATION!;
  const queue = process.env.QUEUE_NAME!;
  const url = process.env.TASK_TARGET_URL!;
  const parent = client.queuePath(project, location, queue);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Tasks-Secret": process.env.TASKS_SECRET!,
  };

  await client.createTask({
    parent,
    task: {
      httpRequest: {
        httpMethod: "POST",
        url,
        headers,
        body: Buffer.from(JSON.stringify(payload)),
      },
    },
  });
}
