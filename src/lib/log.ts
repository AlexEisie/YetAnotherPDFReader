/**
 * Front-end logger. Messages go to the dev-tools console and are forwarded (rate limited) to the
 * Rust log file so problems reported by users can be diagnosed from the log folder.
 */
import { api } from "./ipc";
import { toAppError } from "./errors";

type Level = "error" | "warn" | "info" | "debug";

const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let threshold: Level = import.meta.env.DEV ? "debug" : "info";
let forwardingEnabled = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Forwarding budget: at most N messages per window to avoid flooding the IPC channel. */
const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 50;
let windowStart = 0;
let sentInWindow = 0;

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function forward(level: Level, message: string) {
  if (!forwardingEnabled || ORDER[level] > ORDER.info) return;
  const now = Date.now();
  if (now - windowStart > WINDOW_MS) {
    windowStart = now;
    sentInWindow = 0;
  }
  if (++sentInWindow > MAX_PER_WINDOW) return;
  api.appLog(level, message).catch(() => {
    // Logging must never throw; give up forwarding if the bridge is gone.
    forwardingEnabled = false;
  });
}

function emit(level: Level, scope: string, args: unknown[]) {
  if (ORDER[level] > ORDER[threshold]) return;
  const message = `[${scope}] ${format(args)}`;
  const sink = level === "debug" ? console.debug : console[level];
  sink(message);
  forward(level, message);
}

export interface Logger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  return {
    error: (...a) => emit("error", scope, a),
    warn: (...a) => emit("warn", scope, a),
    info: (...a) => emit("info", scope, a),
    debug: (...a) => emit("debug", scope, a),
  };
}

export function setLogLevel(level: Level) {
  threshold = level;
}

/** Capture uncaught errors so they end up in the log file. */
export function installGlobalErrorHandlers(onFatal?: (message: string) => void) {
  const log = createLogger("global");
  window.addEventListener("error", (event) => {
    log.error("uncaught error:", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const err = toAppError(event.reason);
    if (err.isCancellation) return;
    log.error("unhandled rejection:", err.message, err.detail ?? "");
    onFatal?.(err.message);
  });
}
