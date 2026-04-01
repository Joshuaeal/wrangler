import { addJobEvent, getQueuedJob, updateJobStatus } from "./db.js";
import { ensureDirectories } from "./paths.js";
import { runJob } from "./copy.js";

ensureDirectories();

const pollIntervalMs = 3000;

async function loop(): Promise<void> {
  const job = getQueuedJob();
  if (!job) {
    setTimeout(loop, pollIntervalMs);
    return;
  }

  try {
    addJobEvent(job.id, "worker", "Worker started processing queued job.");
    await runJob(job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    if (message === "__JOB_CANCELLED__") {
      setTimeout(loop, 1000);
      return;
    }
    updateJobStatus(job.id, "failed", { error: message, summary: "Ingest failed." });
    addJobEvent(job.id, "failed", message);
  } finally {
    setTimeout(loop, 1000);
  }
}

void loop();
