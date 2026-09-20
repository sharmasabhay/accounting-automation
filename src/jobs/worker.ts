import { createWorkflowWorker, setupSchedulers } from "./queue.js";
import { logger } from "../utils/logger.js";
import { disconnectDb } from "../db/client.js";
import { installProcessErrorAlerts } from "../utils/error-alert.js";

async function main(): Promise<void> {
  installProcessErrorAlerts();
  logger.info("Starting Omakase workflow worker...");

  await setupSchedulers();
  const worker = createWorkflowWorker();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down worker");
    await worker.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("Worker ready — listening for jobs");
}

main().catch((error) => {
  logger.error({ error }, "Worker failed to start");
  process.exit(1);
});
