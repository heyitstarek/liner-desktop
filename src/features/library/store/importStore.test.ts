// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPlaylistImport: vi.fn(),
  getPlaylistImport: vi.fn(),
  addPlaylistTrack: vi.fn(),
  notifyLibraryChanged: vi.fn(),
  sessionIdentity: "user:a",
}));

vi.mock("@/shared/api", () => ({
  api: {
    createPlaylistImport: mocks.createPlaylistImport,
    getPlaylistImport: mocks.getPlaylistImport,
    addPlaylistTrack: mocks.addPlaylistTrack,
  },
  getAuthSessionIdentity: () => mocks.sessionIdentity,
}));
vi.mock("@/shared/api/auth-session", () => ({
  getAuthSessionIdentity: () => mocks.sessionIdentity,
}));
vi.mock("@/shared/ui", () => ({ showToast: vi.fn() }));
vi.mock("@/languages", () => ({
  createTranslatorSync: () => (key: string) => key,
  getStoredLocale: () => "en",
}));
vi.mock("../hooks/usePlaylists", () => ({ notifyLibraryChanged: mocks.notifyLibraryChanged }));

import { useImportStore } from "./importStore";

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-a",
    source: "spotify",
    sourceUrl: "https://open.spotify.com/playlist/example",
    status: "queued",
    requiresDecision: false,
    importToken: "secret-token",
    workerWsUrl: "wss://import.example/v1/ws",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

describe("playlist import lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionIdentity = "user:a";
    useImportStore.getState().reset();
  });

  afterEach(() => {
    useImportStore.getState().reset();
    vi.unstubAllGlobals();
  });

  it("does not attach a job returned after cancelPolling", async () => {
    let resolveCreate!: (value: any) => void;
    mocks.createPlaylistImport.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    const start = useImportStore.getState().startImport("https://open.spotify.com/playlist/example");

    useImportStore.getState().cancelPolling();
    resolveCreate(job());
    await start;

    expect(useImportStore.getState()).toMatchObject({ job: null, isPolling: false });
  });

  it("does not publish a poll response after reset", async () => {
    let resolvePoll!: (value: any) => void;
    mocks.getPlaylistImport.mockReturnValue(new Promise((resolve) => { resolvePoll = resolve; }));
    const poll = useImportStore.getState().pollJob("job-a");

    useImportStore.getState().reset();
    resolvePoll(job({ status: "completed", playlistId: "private-playlist" }));
    await poll;

    expect(useImportStore.getState()).toMatchObject({ job: null, isPolling: false, pendingTrack: null });
    expect(mocks.notifyLibraryChanged).not.toHaveBeenCalled();
  });

  it("invalidates import state and pending work when the authenticated identity changes", async () => {
    let resolveCreate!: (value: any) => void;
    mocks.createPlaylistImport.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    const start = useImportStore.getState().startImport("https://open.spotify.com/playlist/example");
    mocks.sessionIdentity = "user:b";
    window.dispatchEvent(new Event("auth:changed"));
    resolveCreate(job());
    await start;

    expect(useImportStore.getState()).toMatchObject({
      job: null,
      isPolling: false,
      pendingTrack: null,
      reviewItems: null,
      approvedTracks: null,
    });
  });

  it("ignores a worker message that was already queued when identity changes", async () => {
    class MockWebSocket {
      static instances: MockWebSocket[] = [];
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor(public url: string) { MockWebSocket.instances.push(this); }
      close() {}
    }
    vi.stubGlobal("WebSocket", MockWebSocket);
    useImportStore.getState().listenToWebSocketWorker(job());
    const queuedHandler = MockWebSocket.instances[0].onmessage;

    mocks.sessionIdentity = "user:b";
    window.dispatchEvent(new Event("auth:changed"));
    queuedHandler?.({ data: JSON.stringify({
      type: "job",
      id: "job-a",
      status: "completed",
      playlistId: "account-a-playlist",
    }) } as MessageEvent);

    expect(useImportStore.getState().job).toBeNull();
    expect(mocks.notifyLibraryChanged).not.toHaveBeenCalled();
  });

  it("does not connect to an insecure non-loopback worker URL", async () => {
    class MockWebSocket {
      static instances: MockWebSocket[] = [];
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor(public url: string) { MockWebSocket.instances.push(this); }
      close() {}
    }
    vi.stubGlobal("WebSocket", MockWebSocket);
    mocks.createPlaylistImport.mockResolvedValueOnce(job({ workerWsUrl: "http://worker.example/v1/ws" }));
    await useImportStore.getState().startImport("https://open.spotify.com/playlist/example");
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(useImportStore.getState().error).toBe("Failed to connect to import service");
  });

  it("sends the import token only over the secure worker socket", () => {
    class MockWebSocket {
      static instances: MockWebSocket[] = [];
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor(public url: string) { MockWebSocket.instances.push(this); }
      close() {}
    }
    vi.stubGlobal("WebSocket", MockWebSocket);
    useImportStore.getState().listenToWebSocketWorker(job({ workerWsUrl: "https://import.example/v1/ws?region=eu" }));

    expect(MockWebSocket.instances[0].url).toBe("wss://import.example/v1/ws?region=eu&token=secret-token");
  });

  it("does not publish a completed-job follow-up after cancellation", async () => {
    class MockWebSocket {
      static instances: MockWebSocket[] = [];
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor(public url: string) { MockWebSocket.instances.push(this); }
      close() {}
    }
    vi.stubGlobal("WebSocket", MockWebSocket);
    let resolveLookup!: (value: any) => void;
    mocks.getPlaylistImport.mockReturnValue(new Promise((resolve) => { resolveLookup = resolve; }));
    useImportStore.getState().listenToWebSocketWorker(job());
    const handler = MockWebSocket.instances[0].onmessage;
    handler?.({ data: JSON.stringify({ type: "job", id: "job-a", status: "completed" }) } as MessageEvent);
    await Promise.resolve();

    useImportStore.getState().cancelPolling();
    resolveLookup(job({ status: "completed", playlistId: "account-a-playlist" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(useImportStore.getState().job?.playlistId).toBeUndefined();
    expect(mocks.notifyLibraryChanged).not.toHaveBeenCalled();
  });
});
