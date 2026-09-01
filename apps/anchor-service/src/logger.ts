import { pino, type Logger } from "pino";

export function createLogger(level: string): Logger {
  return pino({
    level,
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : { target: "pino-pretty" },
  });
}
