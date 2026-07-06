import pino from "pino";
import { config } from "../config/index.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  transport: config.isDevelopment
    ? {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      }
    : undefined,
});
