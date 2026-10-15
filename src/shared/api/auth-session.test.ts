import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getAuthSession,
  clearAuthSession,
  getAuthSessionIdentity,
  setAuthSession,
  getValidAccessToken,
  refreshAuthSession,
  getSessionExpiryMs,
  type AuthTokens,
} from "./auth-session";

describe("auth-session token system", () => {
  const originalFetch = globalThis.fetch;
  const storageMap = new Map<string, string>();

  const localStorageMock = {
    getItem: vi.fn((key: string) => storageMap.get(key) ?? null),
    setItem: vi.fn((key: string, val: string) => {
      storageMap.set(key, val);
    }),
    removeItem: vi.fn((key: string) => {
      storageMap.delete(key);
    }),
    clear: vi.fn(() => {
      storageMap.clear();
    }),
  };

  beforeEach(() => {
    storageMap.clear();
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorageMock,
      configurable: true,
      writable: true,
    });
    if (typeof window !== "undefined") {
      Object.defineProperty(window, "localStorage", {
        value: localStorageMock,
        configurable: true,
        writable: true,
      });
    }
    setAuthSession(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses an opaque identity for sessions without a user id", () => {
    const accessToken = "private-access-token-value";
    const refreshToken = "private-refresh-token-value";
    setAuthSession({ accessToken, refreshToken, accessTokenExpiresAt: "", user: { id: "", email: "opaque@example.com" } });

    const identity = getAuthSessionIdentity();
    expect(identity).toMatch(/^session:\d+$/);
    expect(identity).not.toContain(accessToken);
    expect(identity).not.toContain(refreshToken);
  });

  it("keeps logout cleared in memory if browser storage removal fails", () => {
    const persisted: AuthTokens = {
      accessToken: "persisted-access",
      refreshToken: "persisted-refresh",
      accessTokenExpiresAt: "",
      user: { id: "persisted-user" },
    };
    storageMap.set("liner_auth_session", JSON.stringify(persisted));
    setAuthSession(persisted);
    localStorageMock.removeItem.mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    const dispatch = vi.spyOn(window, "dispatchEvent");

    expect(() => setAuthSession(null)).not.toThrow();
    expect(getAuthSession()).toBeNull();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "auth:changed" }));
    expect(storageMap.has("liner_auth_session")).toBe(true);
  });

  it("keeps a new in-memory session if browser storage writes fail", () => {
    const next: AuthTokens = {
      accessToken: "memory-access",
      refreshToken: "memory-refresh",
      accessTokenExpiresAt: "",
      user: { id: "memory-user", email: "memory@example.com" },
    };
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });

    expect(() => setAuthSession(next)).not.toThrow();
    expect(getAuthSession()).toEqual(next);
  });

  it("calculates expiry timestamp correctly from ISO string or numeric epoch", () => {
    const session1: AuthTokens = {
      accessToken: "a1",
      refreshToken: "r1",
      accessTokenExpiresAt: "2026-09-02T19:00:00.000Z",
      user: { id: "u1", email: "test@liner.app" },
    };
    expect(getSessionExpiryMs(session1)).toBe(
      new Date("2026-09-02T19:00:00.000Z").getTime(),
    );

    const session2: AuthTokens = {
      accessToken: "a2",
      refreshToken: "r2",
      accessTokenExpiresAt: "",
      expiresAt: 1788370000,
      user: { id: "u2", email: "test2@liner.app" },
    };
    expect(getSessionExpiryMs(session2)).toBe(1788370000 * 1000);
  });

  it("deduplicates parallel refresh requests into a single network call", async () => {
    const initialSession: AuthTokens = {
      accessToken: "expired_token",
      refreshToken: "refresh_token_123",
      accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      user: { id: "u1", email: "user@example.com" },
    };
    setAuthSession(initialSession);

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      // Simulate network latency
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        ok: true,
        json: async () => ({
          accessToken: "new_token_456",
          refreshToken: "new_refresh_789",
          accessTokenExpiresAt: new Date(Date.now() + 1800_000).toISOString(),
        }),
      };
    }) as any;

    // Trigger 5 concurrent refresh requests
    const results = await Promise.all([
      refreshAuthSession(),
      refreshAuthSession(),
      refreshAuthSession(),
      refreshAuthSession(),
      refreshAuthSession(),
    ]);

    // Only 1 fetch call should have occurred
    expect(fetchCallCount).toBe(1);

    // All callers must receive the exact same refreshed tokens
    for (const res of results) {
      expect(res?.accessToken).toBe("new_token_456");
      expect(res?.refreshToken).toBe("new_refresh_789");
      // Must preserve the user object from the original session
      expect(res?.user.id).toBe("u1");
      expect(res?.user.email).toBe("user@example.com");
    }

    // Storage must be updated with merged session
    const stored = getAuthSession();
    expect(stored?.accessToken).toBe("new_token_456");
    expect(stored?.user.email).toBe("user@example.com");
  });

  it("does not let an older refresh restore a session after logout or account switch", async () => {
    const first: AuthTokens = {
      accessToken: "account-a-access",
      refreshToken: "account-a-refresh",
      accessTokenExpiresAt: "",
      user: { id: "account-a", email: "a@example.com" },
    };
    const second: AuthTokens = {
      accessToken: "account-b-access",
      refreshToken: "account-b-refresh",
      accessTokenExpiresAt: "",
      user: { id: "account-b", email: "b@example.com" },
    };
    setAuthSession(first);
    let resolveRefresh!: (response: any) => void;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { resolveRefresh = resolve; })) as any;

    const refresh = refreshAuthSession();
    await Promise.resolve();
    setAuthSession(second);
    resolveRefresh({ ok: true, json: async () => ({ accessToken: "a-rotated", refreshToken: "a-refresh-rotated" }) });

    expect(await refresh).toBeNull();
    expect(getAuthSession()).toEqual(second);
  });

  it("does not return a captured token after the session changes during refresh", async () => {
    const first: AuthTokens = {
      accessToken: "account-a-access",
      refreshToken: "account-a-refresh",
      accessTokenExpiresAt: new Date(Date.now() + 10_000).toISOString(),
      user: { id: "account-a", email: "a@example.com" },
    };
    const second: AuthTokens = {
      accessToken: "account-b-access",
      refreshToken: "account-b-refresh",
      accessTokenExpiresAt: "",
      user: { id: "account-b", email: "b@example.com" },
    };
    setAuthSession(first);
    let resolveRefresh!: (response: any) => void;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { resolveRefresh = resolve; })) as any;

    const tokenPromise = getValidAccessToken();
    await Promise.resolve();
    setAuthSession(second);
    resolveRefresh({ ok: false, status: 500 });

    expect(await tokenPromise).toBeNull();
    expect(getAuthSession()).toEqual(second);
  });

  it("does not return account A's rotated token when auth:changed installs account B", async () => {
    const first: AuthTokens = {
      accessToken: "account-a-access",
      refreshToken: "account-a-refresh",
      accessTokenExpiresAt: new Date(Date.now() + 10_000).toISOString(),
      user: { id: "account-a", email: "a@example.com" },
    };
    const second: AuthTokens = {
      accessToken: "account-b-access",
      refreshToken: "account-b-refresh",
      accessTokenExpiresAt: "",
      user: { id: "account-b", email: "b@example.com" },
    };
    setAuthSession(first);
    const replaceOnRefreshCommit = () => setAuthSession(second);
    window.addEventListener("auth:changed", replaceOnRefreshCommit, { once: true });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: "account-a-rotated", refreshToken: "account-a-refresh-rotated" }),
    }) as any;

    expect(await getValidAccessToken()).toBeNull();
    expect(getAuthSession()).toEqual(second);
  });

  it("clears local auth before waiting for an expired in-flight refresh", async () => {
    const expiring: AuthTokens = {
      accessToken: "account-a-access",
      refreshToken: "account-a-refresh",
      accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      user: { id: "account-a", email: "a@example.com" },
    };
    setAuthSession(expiring);
    let resolveRefresh!: (response: any) => void;
    globalThis.fetch = vi.fn((url: string) => url.endsWith("/v1/auth/refresh")
      ? new Promise((resolve) => { resolveRefresh = resolve; })
      : Promise.resolve(new Response(null, { status: 204 }))) as any;

    const refresh = refreshAuthSession();
    await Promise.resolve();
    const clearing = clearAuthSession();
    await Promise.resolve();
    expect(getAuthSession()).toBeNull();
    resolveRefresh({ ok: true, json: async () => ({ accessToken: "resurrected", refreshToken: "rotated" }) });
    await clearing;
    await refresh;
    expect(getAuthSession()).toBeNull();
  });

  it("proactively refreshes token in getValidAccessToken when close to expiry", async () => {
    // Expires in 10 seconds (< 45s threshold)
    const expiringSession: AuthTokens = {
      accessToken: "soon_expired_token",
      refreshToken: "rt_abc",
      accessTokenExpiresAt: new Date(Date.now() + 10_000).toISOString(),
      user: { id: "u1", email: "user@example.com" },
    };
    setAuthSession(expiringSession);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        accessToken: "refreshed_valid_token",
        refreshToken: "new_rt",
        accessTokenExpiresAt: new Date(Date.now() + 1800_000).toISOString(),
      }),
    }) as any;

    const token = await getValidAccessToken();
    expect(token).toBe("refreshed_valid_token");
    expect(getAuthSession()?.accessToken).toBe("refreshed_valid_token");
  });

  it("does not refresh in getValidAccessToken if token has ample lifetime remaining", async () => {
    // Expires in 25 minutes
    const validSession: AuthTokens = {
      accessToken: "currently_valid_token",
      refreshToken: "rt_abc",
      accessTokenExpiresAt: new Date(Date.now() + 1500_000).toISOString(),
      user: { id: "u1", email: "user@example.com" },
    };
    setAuthSession(validSession);

    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    const token = await getValidAccessToken();
    expect(token).toBe("currently_valid_token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("awaits active refreshPromise in getValidAccessToken to avoid using stale tokens", async () => {
    const session: AuthTokens = {
      accessToken: "stale_token",
      refreshToken: "rt_in_flight",
      accessTokenExpiresAt: new Date(Date.now() + 500_000).toISOString(),
      user: { id: "u1", email: "user@example.com" },
    };
    setAuthSession(session);

    let resolveFetch: (value: any) => void;
    const slowFetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });

    globalThis.fetch = vi.fn().mockImplementation(() => slowFetchPromise);

    // Start a refresh in the background (sets refreshPromise)
    const refreshOp = refreshAuthSession();

    // Call getValidAccessToken while refresh is still in flight
    const validTokenPromise = getValidAccessToken();

    // Complete the refresh
    resolveFetch!({
      ok: true,
      json: async () => ({
        accessToken: "new_token_from_race",
        refreshToken: "rt_race_new",
        accessTokenExpiresAt: new Date(Date.now() + 1800_000).toISOString(),
      }),
    });

    await refreshOp;
    const token = await validTokenPromise;
    expect(token).toBe("new_token_from_race");
  });

  it("proactively refreshes in getValidAccessToken when token expires in less than 2 minutes (120s)", async () => {
    // Expires in 90 seconds (< 120s threshold)
    const expiringSession: AuthTokens = {
      accessToken: "soon_expired_90s",
      refreshToken: "rt_90s",
      accessTokenExpiresAt: new Date(Date.now() + 90_000).toISOString(),
      user: { id: "u1", email: "user@example.com" },
    };
    setAuthSession(expiringSession);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        accessToken: "refreshed_fresh_token",
        refreshToken: "new_rt_fresh",
        accessTokenExpiresAt: new Date(Date.now() + 1800_000).toISOString(),
      }),
    }) as any;

    const token = await getValidAccessToken();
    expect(token).toBe("refreshed_fresh_token");
  });

  it("clears session on 401 refresh failure but preserves session on 500 failure", async () => {
    const session: AuthTokens = {
      accessToken: "old_token",
      refreshToken: "rt_1",
      accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      user: { id: "u1", email: "user@example.com" },
    };
    setAuthSession(session);

    // 1. Server 500 error: Session must NOT be wiped
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as any;

    const res500 = await refreshAuthSession();
    expect(res500).toBeNull();
    expect(getAuthSession()).not.toBeNull();
    expect(getAuthSession()?.refreshToken).toBe("rt_1");

    // 2. Server 401 error: Session MUST be wiped
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    }) as any;

    const res401 = await refreshAuthSession();
    expect(res401).toBeNull();
    expect(getAuthSession()).toBeNull();
  });
});
