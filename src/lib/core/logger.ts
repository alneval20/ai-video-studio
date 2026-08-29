export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return (["debug", "info", "warn", "error"] as const).includes(raw as LogLevel)
    ? (raw as LogLevel)
    : "info";
}

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

export type LogSink = (entry: LogEntry) => void;

const sinks: LogSink[] = [];

/** Register an extra sink — the job store uses this to persist generation logs. */
export function addLogSink(sink: LogSink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}

function emit(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>) {
  const entry: LogEntry = { ts: new Date().toISOString(), level, scope, message, data };
  if (ORDER[level] >= ORDER[currentLevel()]) {
    const line = `[${entry.ts}] ${level.toUpperCase().padEnd(5)} ${scope} — ${message}`;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (data && Object.keys(data).length) fn(line, data);
    else fn(line);
  }
  for (const sink of sinks) {
    try {
      sink(entry);
    } catch {
      /* a broken sink must never break generation */
    }
  }
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(subScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, d) => emit("debug", scope, m, d),
    info: (m, d) => emit("info", scope, m, d),
    warn: (m, d) => emit("warn", scope, m, d),
    error: (m, d) => emit("error", scope, m, d),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
