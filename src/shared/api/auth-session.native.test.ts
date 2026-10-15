import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthTokens } from "../contracts";

const legacy: AuthTokens = {
  accessToken: "synthetic-legacy-access",
  refreshToken: "synthetic-legacy-refresh",
  accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
  user: { id: "legacy-user", email: "legacy@example.test" },
};

const newer: AuthTokens = {
  accessToken: "synthetic-new-access",
  refreshToken: "synthetic-new-refresh",
  accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
  user: { id: "new-user", email: "new@example.test" },
};

describe("native auth session initialization", () => {
  const local = new Map<string, string>();

  beforeEach(() => {
    vi.resetModules();
    local.clear();
    const storage = {
      getItem: vi.fn((key: string) => local.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => local.set(key, value)),
      removeItem: vi.fn((key: string) => local.delete(key)),
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(window, "linerElectron", { configurable: true, writable: true, value: undefined });
  });

  function installBridge(overrides: Partial<NonNullable<Window["linerElectron"]>> = {}) {
    const calls: string[] = [];
    const bridge = {
      loadAuthSession: vi.fn(async () => null),
      saveAuthSession: vi.fn(async (value: unknown) => { calls.push(`save:${(value as AuthTokens).accessToken}`); return true; }),
      clearAuthSession: vi.fn(async () => { calls.push("clear"); return true; }),
      ...overrides,
    };
    Object.defineProperty(window, "linerElectron", { configurable: true, writable: true, value: bridge });
    return { bridge, calls };
  }

  it("migrates the legacy session into protected storage and removes renderer plaintext", async () => {
    local.set("liner_auth_session", JSON.stringify(legacy));
    const { bridge } = installBridge();
    const auth = await import("./auth-session");

    await auth.initializeAuthSession();

    expect(auth.getAuthSession()).toEqual(legacy);
    expect(bridge.saveAuthSession).toHaveBeenCalledWith(legacy);
    expect(local.has("liner_auth_session")).toBe(false);
  });

  it("does not let pending hydration replace an explicit logout", async () => {
    let resolveLoad!: (value: unknown) => void;
    const { bridge } = installBridge({
      loadAuthSession: vi.fn(() => new Promise((resolve) => { resolveLoad = resolve; })),
    });
    const auth = await import("./auth-session");

    const hydration = auth.initializeAuthSession();
    auth.setAuthSession(null);
    resolveLoad(legacy);
    await hydration;

    expect(auth.getAuthSession()).toBeNull();
    expect(bridge.clearAuthSession).toHaveBeenCalled();
  });

  it("does not let pending hydration replace a newer login", async () => {
    let resolveLoad!: (value: unknown) => void;
    installBridge({ loadAuthSession: vi.fn(() => new Promise((resolve) => { resolveLoad = resolve; })) });
    const auth = await import("./auth-session");

    const hydration = auth.initializeAuthSession();
    auth.setAuthSession(newer);
    resolveLoad(legacy);
    await hydration;

    expect(auth.getAuthSession()).toEqual(newer);
  });

  it("keeps migration save ordered before a login that arrives while migration is pending", async () => {
    local.set("liner_auth_session", JSON.stringify(legacy));
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    installBridge({
      saveAuthSession: vi.fn((value: unknown) => new Promise<boolean>((resolve) => {
        calls.push((value as AuthTokens).accessToken);
        releases.push(() => resolve(true));
      })),
    });
    const auth = await import("./auth-session");

    const hydration = auth.initializeAuthSession();
    await vi.waitFor(() => expect(calls).toEqual([legacy.accessToken]));
    auth.setAuthSession(newer);
    expect(calls).toEqual([legacy.accessToken]);
    releases[0]!();
    await vi.waitFor(() => expect(calls).toEqual([legacy.accessToken, newer.accessToken]));
    releases[1]!();
    await hydration;

    expect(auth.getAuthSession()).toEqual(newer);
  });

  it("serializes rapid account changes followed by logout", async () => {
    const { calls } = installBridge();
    const auth = await import("./auth-session");
    await auth.initializeAuthSession();

    auth.setAuthSession(legacy);
    auth.setAuthSession(newer);
    auth.setAuthSession(null);
    await vi.waitFor(() => expect(calls).toEqual(["save:synthetic-legacy-access", "save:synthetic-new-access", "clear"]));
    expect(auth.getAuthSession()).toBeNull();
  });

  it("keeps the in-memory login when native persistence rejects", async () => {
    installBridge({ saveAuthSession: vi.fn(async () => { throw new Error("synthetic IPC failure"); }) });
    const auth = await import("./auth-session");
    await auth.initializeAuthSession();

    expect(() => auth.setAuthSession(newer)).not.toThrow();
    expect(auth.getAuthSession()).toEqual(newer);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("keeps a migrated session in memory when native storage reports unavailable", async () => {
    local.set("liner_auth_session", JSON.stringify(legacy));
    const { bridge } = installBridge({ saveAuthSession: vi.fn(async () => false) });
    const auth = await import("./auth-session");

    await auth.initializeAuthSession();

    expect(auth.getAuthSession()).toEqual(legacy);
    expect(bridge.saveAuthSession).toHaveBeenCalledWith(legacy);
    expect(local.has("liner_auth_session")).toBe(false);
  });
});
