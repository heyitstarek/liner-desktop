import { log } from "./logger";
import { telemetry } from "@/shared/telemetry";

export interface GlobalErrorHandlerOptions {
  onError?: (event: ErrorEvent) => void;
  onUnhandledRejection?: (event: PromiseRejectionEvent) => void;
}

let isInitialized = false;
let cleanupFn: (() => void) | null = null;

function formatUnhandledReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;

  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(reason, (_key, value: unknown) => {
      if (typeof value === "bigint") return `${value}n`;
      if (value && typeof value === "object") {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
    if (serialized !== undefined) return serialized;
  } catch {
    // Some rejection values cannot be serialized, but logging must still proceed.
  }

  try {
    return String(reason);
  } catch {
    return "[Unserializable rejection reason]";
  }
}

/**
 * Initializes global error and unhandled rejection listeners for the renderer process.
 * Safely captures and logs uncaught exceptions and unhandled promise rejections.
 */
export function initGlobalErrorHandlers(
  options?: GlobalErrorHandlerOptions,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  if (isInitialized && cleanupFn) {
    return cleanupFn;
  }

  const handleError = (event: ErrorEvent) => {
    const errorObj = event.error;
    const message = event.message || errorObj?.message || "Unknown error";
    const filename = event.filename || "unknown file";
    const lineno = event.lineno || 0;
    const colno = event.colno || 0;

    log(
      "red",
      "UncaughtError",
      `${message} (${filename}:${lineno}:${colno})`,
      errorObj ?? event,
    );

    telemetry.reportError(errorObj ?? message, {
      source: "window.onerror",
      filename,
      lineno,
      colno,
    }).catch(() => {});

    options?.onError?.(event);
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message = formatUnhandledReason(reason);

    log(
      "red",
      "UnhandledRejection",
      `Unhandled Promise Rejection: ${message}`,
      reason,
    );

    telemetry.reportError(reason ?? "Unhandled Promise Rejection", {
      source: "window.unhandledrejection",
    }).catch(() => {});

    options?.onUnhandledRejection?.(event);
  };

  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);

  isInitialized = true;

  cleanupFn = () => {
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    isInitialized = false;
    cleanupFn = null;
  };

  return cleanupFn;
}
