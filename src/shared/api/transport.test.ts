import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { clearAuthSession, getAuthSession, refreshAuthSession, setAuthSession, type AuthTokens } from "./auth-session";
import { DEFAULT_PRIMARY_API, getApiBaseUrl, initApiEndpointProbe, resetEndpointProbe, setApiBaseUrl } from "./baseUrl";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// Keep UI/audio lifecycle out of request tests; exercise the real API and session code.
vi.mock("@/features/player/store/playerStore", () => ({
  usePlayerStore: { getState: () => ({ currentTrack: null }) },
}));
vi.mock("@/shared/ui/Toast", () => ({ showToast: vi.fn() }));
vi.mock("@/languages", () => ({
  createTranslatorSync: () => (key: string) => key,
  getStoredLocale: () => "en",
}));
vi.mock("@/shared/telemetry", () => ({ telemetry: { trackNetwork: vi.fn() } }));
vi.mock("@/features/connectivity", async () => ({
  ...await import("@/features/connectivity/lib/failureKind"),
  recordConnectivityFailure: vi.fn(),
}));

const session: AuthTokens = {
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  user: { id: "test-user", email: "user@example.com" },
};

beforeEach(() => {
  localStorage.clear();
  resetEndpointProbe();
  setApiBaseUrl(DEFAULT_PRIMARY_API);
  setAuthSession(null);
  // Exercise the actual renderer signer against the Electron IPC boundary.
  window.linerElectron = {
    signRequest: vi.fn().mockResolvedValue({ signature: "test-signature", timestamp: 123, nonce: "test-nonce" }),
  } as unknown as NonNullable<Window["linerElectron"]>;
});

afterEach(() => {
  setAuthSession(null);
  delete window.linerElectron;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("credential transport", () => {
  it("rejects an actual 307 redirect before resending the password body", async () => {
    let redirectedRequests = 0;
    let loginRequests = 0;
    const server = createServer((req, res) => {
      if (req.url === "/v1/auth/login") {
        loginRequests++;
        res.writeHead(307, { Location: "/credential-sink" });
      } else {
        redirectedRequests++;
        res.writeHead(200, { "Content-Type": "application/json" });
      }
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    setApiBaseUrl(`http://127.0.0.1:${port}`);

    // The existing custom-to-primary retry remains; keep that request offline.
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
      url.startsWith(DEFAULT_PRIMARY_API)
        ? Promise.reject(new TypeError("offline"))
        : nativeFetch(url, init),
    );
    try {
      await expect(api.login("user@example.com", "test-password")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      expect(loginRequests).toBe(1);
      expect(redirectedRequests).toBe(0);
    } finally {
      setApiBaseUrl(DEFAULT_PRIMARY_API);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it.each(["login", "register", "authenticated", "refresh", "lyrics"])("does not retry %s over plaintext after network failure", async (operation) => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setAuthSession(operation === "login" || operation === "register" ? null : session);

    if (operation === "login") await expect(api.login("user@example.com", "test-password")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    if (operation === "register") await expect(api.register("user@example.com", "test-password", "user", "User")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    if (operation === "authenticated") await expect(api.getMe()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    if (operation === "refresh") {
      expect(await refreshAuthSession()).toBeNull();
      expect(getAuthSession()).toEqual(session);
    }
    if (operation === "lyrics") await expect(api.streamLyrics("track").next()).rejects.toThrow("offline");

    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toMatch(/^https:\/\//);
    expect(getApiBaseUrl()).toBe(DEFAULT_PRIMARY_API);
  });

  it("keeps logout credentials on HTTPS following a failed startup probe", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await initApiEndpointProbe();
    setAuthSession(session);
    await clearAuthSession();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe(`${DEFAULT_PRIMARY_API}/v1/auth/logout`);
    expect(fetch.mock.calls[1][1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    expect(getAuthSession()).toBeNull();
  });

  it("preserves login, bearer requests, refresh, and streamed lyrics on HTTPS", async () => {
    const rotated = { ...session, accessToken: "rotated-token", refreshToken: "rotated-refresh" };
    const event = { type: "done" };
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json(session.user))
      .mockResolvedValueOnce(Response.json(rotated))
      .mockResolvedValueOnce(new Response(`data: ${JSON.stringify(event)}\n\n`));
    vi.stubGlobal("fetch", fetch);

    expect(await api.login("user@example.com", "test-password")).toEqual(session);
    expect(await api.getMe()).toEqual(session.user);
    expect(await refreshAuthSession()).toEqual(rotated);
    const events = [];
    for await (const item of api.streamLyrics("track")) events.push(item);
    expect(events).toEqual([event]);
    expect(getAuthSession()).toEqual(rotated);
    expect(fetch.mock.calls[0][1].body).toBe(JSON.stringify({ email: "user@example.com", password: "test-password" }));
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${session.accessToken}`);
    expect(fetch.mock.calls[3][1].headers.Authorization).toBe(`Bearer ${rotated.accessToken}`);
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\//);
      expect(init.redirect).toBe("error");
      expect(init.headers["x-liner-signature"]).toBe("test-signature");
    }
  });

  it("preserves the authorized retry after a 401 without following redirects", async () => {
    setAuthSession(session);
    const rotated = { ...session, accessToken: "rotated-token" };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json(rotated))
      .mockResolvedValueOnce(Response.json(session.user));
    vi.stubGlobal("fetch", fetch);
    expect(await api.getMe()).toEqual(session.user);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2][1].headers.Authorization).toBe("Bearer rotated-token");
    for (const [, init] of fetch.mock.calls) expect(init.redirect).toBe("error");
  });

  it("preserves recovery from a custom HTTPS endpoint to the primary HTTPS service", async () => {
    setApiBaseUrl("https://custom.example");
    setAuthSession(session);
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(Response.json(session.user));
    vi.stubGlobal("fetch", fetch);
    expect(await api.getMe()).toEqual(session.user);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://custom.example/v1/me", `${DEFAULT_PRIMARY_API}/v1/me`,
    ]);
    for (const [, init] of fetch.mock.calls) expect(init.redirect).toBe("error");
  });
});
