/**
 * @recoveros/observability
 *
 * Structured logging surface. For the scaffold this is a dependency-free
 * JSON console logger. A production logger (e.g. pino) and correlation-id
 * propagation, metrics, and trace persistence will be introduced later
 * behind this same interface (see docs/ARCHITECTURE.md §14).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  name: string;
  level?: LogLevel;
  bindings?: Record<string, unknown>;
}

/** Create a minimal structured logger that emits one JSON object per line. */
export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? "info";
  const bindings = options.bindings ?? {};

  const emit = (lvl: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const line = JSON.stringify({
      level: lvl,
      name: options.name,
      time: new Date().toISOString(),
      message,
      ...bindings,
      ...meta,
    });
    console.log(line);
  };

  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
    child: (childBindings) =>
      createLogger({ ...options, bindings: { ...bindings, ...childBindings } }),
  };
}
