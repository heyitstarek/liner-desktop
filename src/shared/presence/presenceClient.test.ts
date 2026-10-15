import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PresenceClient } from "./presenceClient";
import * as authSession from "../api/auth-session";
import { DEFAULT_PRIMARY_API, initApiEndpointProbe, resetEndpointProbe, setApiBaseUrl } from "../api/baseUrl";

describe("PresenceClient", () => {
  let mockSockets: any[] = [];

  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = MockWebSocket.OPEN;
    sentData: string[] = [];
    url: string;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: any) => void) | null = null;

    constructor(url: string) {
      this.url = url;
      mockSockets.push(this);
      setTimeout(() => {
        if (this.onopen) this.onopen();
      }, 0);
    }

    send(data: string) {
      this.sentData.push(data);
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
      if (this.onclose) this.onclose();
    }
  }

  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    mockSockets = [];
    (globalThis as any).WebSocket = MockWebSocket;
    vi.spyOn(authSession, "getValidAccessToken").mockResolvedValue("test-valid-jwt-token");
    vi.spyOn(authSession, "getAuthSession").mockReturnValue({
      accessToken: "test-valid-jwt-token",
      refreshToken: "test-refresh-token",
      accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      user: {
        id: "11111111-1111-1111-1111-111111111111",
        email: "alice@example.com",
        username: "alice",
        displayName: "Alice",
        avatarUrl: null,
      },
    });
  });

  afterEach(() => {
    authSession.setAuthSession(null);
    globalThis.WebSocket = originalWebSocket;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps presence credentials on WSS after a failed API health probe", async () => {
    setApiBaseUrl(DEFAULT_PRIMARY_API);
    resetEndpointProbe();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await initApiEndpointProbe();

    const client = new PresenceClient();
    try {
      client.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(mockSockets).toHaveLength(1);
      expect(mockSockets[0].url).toBe("wss://api.tryliner.fun/v1/ping/ws");
      expect(JSON.parse(mockSockets[0].sentData[0]).token).toBe("test-valid-jwt-token");
    } finally {
      client.stop();
    }
  });

  it("connects, sends init payload on open, and triggers periodic pings", async () => {
    const client = new PresenceClient(100);
    client.start();

    // wait for connect and open
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockSockets.length).toBe(1);
    const socket = mockSockets[0];
    expect(socket.url).toContain("/v1/ping/ws");
    expect(socket.sentData.length).toBe(1);

    const initData = JSON.parse(socket.sentData[0]);
    expect(initData.token).toBe("test-valid-jwt-token");
    expect(initData.userId).toBe("11111111-1111-1111-1111-111111111111");
    expect(initData.username).toBe("alice");

    // wait for ping interval
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(socket.sentData.slice(1)).toContain("p");

    client.stop();
  });

  it("does not connect if user is not authenticated", async () => {
    vi.spyOn(authSession, "getValidAccessToken").mockResolvedValue(null);
    vi.spyOn(authSession, "getAuthSession").mockReturnValue(null);

    const client = new PresenceClient(100);
    client.start();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockSockets.length).toBe(0);

    client.stop();
  });

  it("replaces an account A handshake with account B and never opens A's socket", async () => {
    const accountA = {
      accessToken: "account-a-token",
      refreshToken: "account-a-refresh",
      accessTokenExpiresAt: "",
      user: { id: "account-a", email: "a@example.com" },
    };
    const accountB = {
      accessToken: "account-b-token",
      refreshToken: "account-b-refresh",
      accessTokenExpiresAt: "",
      user: { id: "account-b", email: "b@example.com" },
    };
    let activeSession = accountA;
    authSession.setAuthSession(accountA);
    vi.spyOn(authSession, "getAuthSession").mockImplementation(() => activeSession);
    let resolveAccountA!: (token: string) => void;
    vi.spyOn(authSession, "getValidAccessToken")
      .mockImplementationOnce(() => new Promise((resolve) => { resolveAccountA = resolve; }))
      .mockResolvedValue("account-b-token");

    const client = new PresenceClient(100);
    client.start();
    await Promise.resolve();
    activeSession = accountB;
    authSession.setAuthSession(accountB);
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolveAccountA("account-a-token");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockSockets).toHaveLength(1);
    expect(JSON.parse(mockSockets[0].sentData[0]).token).toBe("account-b-token");
    expect(JSON.parse(mockSockets[0].sentData[0]).userId).toBe("account-b");
    client.stop();
  });

  it("ignores a late token result from a previous stop and restart cycle", async () => {
    const first = new Promise<string>((resolve) => setTimeout(() => resolve("old-token"), 15));
    const second = new Promise<string>((resolve) => setTimeout(() => resolve("current-token"), 0));
    vi.spyOn(authSession, "getValidAccessToken")
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const currentSession = {
      accessToken: "current-token",
      refreshToken: "current-refresh",
      accessTokenExpiresAt: "",
      user: { id: "current-user", email: "current@example.com" },
    };
    authSession.setAuthSession(currentSession);
    vi.spyOn(authSession, "getAuthSession").mockReturnValue(currentSession);
    const client = new PresenceClient(100);

    client.start();
    client.stop();
    client.start();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(authSession.getValidAccessToken).toHaveBeenCalledTimes(2);
    expect(mockSockets).toHaveLength(1);
    expect(JSON.parse(mockSockets[0].sentData[0]).token).toBe("current-token");
    client.stop();
  });

  it("keeps the active socket for routine same-user token refresh", async () => {
    const getSession = vi.spyOn(authSession, "getAuthSession");
    const firstSession = authSession.getAuthSession()!;
    authSession.setAuthSession(firstSession);
    const client = new PresenceClient(100);
    client.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const socket = mockSockets[0];

    const rotatedSession = {
      ...firstSession,
      accessToken: "rotated-same-user-token",
    };
    getSession.mockReturnValue(rotatedSession);
    authSession.setAuthSession(rotatedSession);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockSockets).toHaveLength(1);
    expect(client.getSocketState()).toBe(MockWebSocket.OPEN);
    expect(mockSockets[0]).toBe(socket);
    client.stop();
  });
});
