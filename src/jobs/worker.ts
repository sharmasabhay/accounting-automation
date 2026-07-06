import { createWorkflowWorker, setupSchedulers } from "./queue.js";
import { logger } from "../utils/logger.js";
import { disconnectDb } from "../db/client.js";

async function main(): Promise<void> {
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
