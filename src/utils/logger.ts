import pino from "pino";
import { config } from "../config/index.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  hooks: {
    logMethod(args, method, level) {
      if (level >= 50) {
        void import("./error-alert.js")
          .then(({ reportBackendErrorFromLog }) => reportBackendErrorFromLog(args as unknown[], level))
          .catch(() => undefined);
      }
      return method.apply(this, args);
    },
  },
  transport: config.isDevelopment
    ? {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      }
    : undefined,
});
