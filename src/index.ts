import { startServer } from "./api/server.js";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { ensureStorageDirs } from "./utils/storage.js";
import { disconnectDb } from "./db/client.js";

async function main(): Promise<void> {
  logger.info(
    {
      env: config.NODE_ENV,
      dryRun: config.DRY_RUN,
      host: config.HOST,
    },
    "Bootstrapping Omakase Accounting"
  );

  await ensureStorageDirs();
  const app = await startServer();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await app.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error({ error }, "Failed to start application");
  process.exit(1);
});
