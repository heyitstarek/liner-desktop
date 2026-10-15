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

  it("fails closed after a custom HTTPS endpoint fails", async () => {
    setApiBaseUrl("https://custom.example");
    setAuthSession(session);
    const fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetch);
    await expect(api.getMe()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("https://custom.example/v1/me");
    expect(fetch.mock.calls[0][1].redirect).toBe("error");
    expect(getApiBaseUrl()).toBe("https://custom.example");
  });

  it.each(["api", "refresh", "lyrics"])("does not move %s credentials from a custom endpoint", async (operation) => {
    const customApi = "https://private-tenant.example";
    setApiBaseUrl(customApi);
    setAuthSession(session);
    const fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "error").mockImplementation(() => {});

    if (operation === "api") await expect(api.getMe()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    if (operation === "refresh") expect(await refreshAuthSession()).toBeNull();
    if (operation === "lyrics") await expect(api.streamLyrics("track").next()).rejects.toThrow("offline");

    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toMatch(/^https:\/\/private-tenant\.example\//);
    expect(getApiBaseUrl()).toBe(customApi);
  });

  it("does not coalesce identical GETs across account sessions", async () => {
    const accountA: AuthTokens = { ...session, accessToken: "account-a-token", refreshToken: "account-a-refresh", user: { id: "account-a", email: "a@example.com" } };
    const accountB: AuthTokens = { ...session, accessToken: "account-b-token", refreshToken: "account-b-refresh", user: { id: "account-b", email: "b@example.com" } };
    setAuthSession(accountA);
    const pending: Array<(response: Response) => void> = [];
    const fetch = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", fetch);

    const requestA = api.getMe();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    setAuthSession(accountB);
    const requestB = api.getMe();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    pending[1](Response.json(accountB.user));
    pending[0](Response.json(accountA.user));

    await expect(requestA).resolves.toEqual(accountA.user);
    await expect(requestB).resolves.toEqual(accountB.user);
    expect(fetch.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)?.Authorization)).toEqual([
      "Bearer account-a-token", "Bearer account-b-token",
    ]);
  });

  it("does not replay an account A mutation with account B credentials after a late 401", async () => {
    const accountA: AuthTokens = { ...session, accessToken: "account-a-token", refreshToken: "account-a-refresh", user: { id: "account-a", email: "a@example.com" } };
    const accountB: AuthTokens = { ...session, accessToken: "account-b-token", refreshToken: "account-b-refresh", user: { id: "account-b", email: "b@example.com" } };
    setAuthSession(accountA);
    let rejectFirst!: (response: Response) => void;
    const fetch = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>((resolve) => { rejectFirst = resolve; }));
    vi.stubGlobal("fetch", fetch);

    const mutation = api.likeTrack("track-1");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    setAuthSession(accountB);
    rejectFirst(new Response(null, { status: 401 }));

    await expect(mutation).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(fetch).toHaveBeenCalledOnce();
    expect((fetch.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer account-a-token");
  });

  it("checks the account boundary after retry signing before sending the refreshed mutation", async () => {
    const accountA: AuthTokens = { ...session, accessToken: "account-a-token", refreshToken: "account-a-refresh", user: { id: "account-a", email: "a@example.com" } };
    const accountB: AuthTokens = { ...session, accessToken: "account-b-token", refreshToken: "account-b-refresh", user: { id: "account-b", email: "b@example.com" } };
    setAuthSession(accountA);
    let signerCalls = 0;
    let releaseRetrySigner!: () => void;
    window.linerElectron!.signRequest = vi.fn(() => {
      signerCalls += 1;
      if (signerCalls === 3) {
        return new Promise((resolve) => {
          releaseRetrySigner = () => resolve({ signature: "retry-signature", timestamp: 123, nonce: "retry-nonce" });
        });
      }
      return Promise.resolve({ signature: "test-signature", timestamp: 123, nonce: "test-nonce" });
    }) as NonNullable<Window["linerElectron"]>["signRequest"];
    let apiAttempts = 0;
    const fetch = vi.fn((url: string) => {
      if (url.endsWith("/v1/auth/refresh")) {
        return Promise.resolve(Response.json({
          accessToken: "account-a-rotated",
          refreshToken: "account-a-refresh-rotated",
          accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }));
      }
      apiAttempts += 1;
      return Promise.resolve(new Response(null, { status: 401 }));
    });
    vi.stubGlobal("fetch", fetch);

    const mutation = api.likeTrack("track-1");
    await vi.waitFor(() => expect(signerCalls).toBe(3));
    setAuthSession(accountB);
    releaseRetrySigner();

    await expect(mutation).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(apiAttempts).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not commit a pending login response after another session replaces it", async () => {
    const accountB: AuthTokens = { ...session, accessToken: "account-b-token", refreshToken: "account-b-refresh", user: { id: "account-b", email: "b@example.com" } };
    let resolveLogin!: (response: Response) => void;
    const fetch = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>((resolve) => { resolveLogin = resolve; }));
    vi.stubGlobal("fetch", fetch);

    const login = api.login("a@example.com", "password");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    setAuthSession(accountB);
    resolveLogin(Response.json(session));

    await expect(login).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(getAuthSession()).toEqual(accountB);
  });

  it("parses complete SSE frames across CRLF chunks and keeps draining after comments", async () => {
    const chunks = [
      ": heartbeat\r",
      "\n\r",
      "\n",
      "data: malformed-json\r\r",
      "data: {\"type\":\"one\"}\r",
      "\rdata: {\"type\":\"two\",\"text\":\"猫\"}\r\n\r\n",
      "data: {\"type\":\"unterminated\"}",
    ];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));

    const events = [];
    for await (const event of api.streamLyrics("track")) events.push(event);
    expect(events).toEqual([
      { type: "one" },
      { type: "two", text: "猫" },
    ]);
  });

  it("cancels the network reader when a consumer stops after one lyric event", async () => {
    let wasCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {\"type\":\"one\"}\n\n"));
      },
      cancel() {
        wasCancelled = true;
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));

    for await (const event of api.streamLyrics("track")) {
      expect(event).toEqual({ type: "one" });
      break;
    }

    expect(wasCancelled).toBe(true);
  });

  it("decodes a UTF-8 character split across streamed chunks", async () => {
    const bytes = new TextEncoder().encode("data: {\"type\":\"line\",\"text\":\"猫\"}\n\n");
    const catStart = bytes.findIndex((byte) => byte === 0xe7);
    const chunks = [bytes.slice(0, catStart + 1), bytes.slice(catStart + 1)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));

    const events = [];
    for await (const event of api.streamLyrics("track")) events.push(event);
    expect(events).toEqual([{ type: "line", text: "猫" }]);
  });

  it("cancels an open network reader when its signal is aborted", async () => {
    const controller = new AbortController();
    let wasCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("data: {\"type\":\"one\"}\n\n"));
      },
      cancel() {
        wasCancelled = true;
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    const iterator = api.streamLyrics("track", controller.signal);

    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "one" } });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(wasCancelled).toBe(true);
  });
});
