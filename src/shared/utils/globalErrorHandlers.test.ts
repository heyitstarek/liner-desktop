import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initGlobalErrorHandlers } from "./globalErrorHandlers";

const { reportError } = vi.hoisted(() => ({
  reportError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./logger", () => ({ log: vi.fn() }));
vi.mock("@/shared/telemetry", () => ({
  telemetry: { reportError },
}));

describe("initGlobalErrorHandlers", () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    reportError.mockClear();
  });

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  it("handles and logs window error events", () => {
    const onErrorMock = vi.fn();
    cleanup = initGlobalErrorHandlers({ onError: onErrorMock });

    const errorEvent = new ErrorEvent("error", {
      message: "Test unhandled script error",
      filename: "test.js",
      lineno: 42,
      colno: 10,
      error: new Error("Test unhandled script error"),
    });

    window.dispatchEvent(errorEvent);

    expect(onErrorMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledWith(errorEvent);
  });

  it("handles and logs window unhandledrejection events", () => {
    const onUnhandledRejectionMock = vi.fn();
    cleanup = initGlobalErrorHandlers({
      onUnhandledRejection: onUnhandledRejectionMock,
    });

    const rejectionEvent = new CustomEvent("unhandledrejection", {
      detail: { reason: new Error("Async promise failed") },
    }) as any;
    rejectionEvent.reason = new Error("Async promise failed");

    window.dispatchEvent(rejectionEvent);

    expect(onUnhandledRejectionMock).toHaveBeenCalledTimes(1);
    expect(onUnhandledRejectionMock).toHaveBeenCalledWith(rejectionEvent);
  });

  it.each([
    ["cyclic objects", (() => { const value: Record<string, unknown> = {}; value.self = value; return value; })()],
    ["BigInt values", 1n],
  ])("reports unhandled rejection reasons containing %s", (_label, reason) => {
    const onUnhandledRejectionMock = vi.fn();
    cleanup = initGlobalErrorHandlers({ onUnhandledRejection: onUnhandledRejectionMock });
    const rejectionEvent = new CustomEvent("unhandledrejection", { detail: { reason } }) as any;
    rejectionEvent.reason = reason;

    expect(() => window.dispatchEvent(rejectionEvent)).not.toThrow();
    expect(onUnhandledRejectionMock).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("cleans up listeners when cleanup function is invoked", () => {
    const onErrorMock = vi.fn();
    cleanup = initGlobalErrorHandlers({ onError: onErrorMock });

    cleanup();
    cleanup = null;

    const errorEvent = new ErrorEvent("error", {
      message: "Another error after cleanup",
    });
    window.dispatchEvent(errorEvent);

    expect(onErrorMock).not.toHaveBeenCalled();
  });
});
