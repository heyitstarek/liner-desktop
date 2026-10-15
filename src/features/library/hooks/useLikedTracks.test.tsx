// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { act } from "react";
import { useLikedTracks, applyOptimisticLike, applyOptimisticUnlike } from "./useLikedTracks";
import { api } from "@/shared/api";

const mocks = vi.hoisted(() => ({ session: { accessToken: "test-token", user: { id: "u1" } } as any, boundary: 1 }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/shared/api", () => ({
  api: {
    listLikedTracks: vi.fn(),
  },
  getAuthSession: () => mocks.session,
  getAuthSessionIdentity: () => mocks.session?.accessToken
    ? mocks.session.user?.id ? `user:${mocks.session.user.id}` : `token:${mocks.session.accessToken}`
    : "anonymous",
  toClientTrack: (track: any) => ({
    id: track.id,
    title: track.title,
    artists: track.artists || "",
    coverUrl: track.coverUrl || "",
    durationMs: track.durationMs || 0,
    playCount: track.playCount || 0,
  }),
}));

vi.mock("@/shared/api/auth-session", () => ({
  getAuthSessionBoundaryGeneration: () => mocks.boundary,
}));

describe("useLikedTracks", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    mocks.boundary = 1;
    mocks.session = null;
    mocks.boundary++;
    window.dispatchEvent(new Event("auth:changed"));
    mocks.session = { accessToken: "test-token", user: { id: "u1" } };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.removeChild(container);
  });

  it("does not flip isLoading to true when library:changed event is dispatched after initial load", async () => {
    (api.listLikedTracks as any).mockResolvedValue({
      items: [
        {
          track: { id: "track-1", title: "Song 1", artists: "Artist 1" },
        },
      ],
      nextCursor: null,
    });

    let hookResult: ReturnType<typeof useLikedTracks> | undefined;

    function TestComponent() {
      hookResult = useLikedTracks();
      return <div>loaded: {(!hookResult.isLoading).toString()}</div>;
    }

    await act(async () => {
      root.render(<TestComponent />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(hookResult?.isLoading).toBe(false);
    expect(hookResult?.data.tracks).toHaveLength(1);

    // Apply optimistic like
    act(() => {
      applyOptimisticLike("track-2");
    });
    expect(hookResult?.data.tracks).toHaveLength(2);
    expect(hookResult?.isLoading).toBe(false);

    // Dispatch library:changed event to simulate background update after liking
    let backgroundPromiseResolve: (value: any) => void;
    const backgroundPromise = new Promise((resolve) => {
      backgroundPromiseResolve = resolve;
    });

    (api.listLikedTracks as any).mockImplementation(() => backgroundPromise);

    await act(async () => {
      window.dispatchEvent(new Event("library:changed"));
    });

    // isLoading MUST REMAIN FALSE during background refetch
    expect(hookResult?.isLoading).toBe(false);

    // Resolve background refetch
    await act(async () => {
      backgroundPromiseResolve!({
        items: [
          { track: { id: "track-1", title: "Song 1", artists: "Artist 1" } },
          { track: { id: "track-2", title: "Song 2", artists: "Artist 2" } },
        ],
        nextCursor: null,
      });
      await Promise.resolve();
    });

    expect(hookResult?.isLoading).toBe(false);
    expect(hookResult?.data.tracks).toHaveLength(2);
  });

  it("does not expose or cache account A likes after switching to account B", async () => {
    let resolveA!: (value: any) => void;
    (api.listLikedTracks as any).mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }));
    let hookResult: ReturnType<typeof useLikedTracks> | undefined;
    function TestComponent() { hookResult = useLikedTracks(); return null; }
    await act(async () => { root.render(<TestComponent />); });

    mocks.session = { accessToken: "token-b", user: { id: "u2" } };
    (api.listLikedTracks as any).mockResolvedValueOnce({ items: [{ track: { id: "b-track" } }], nextCursor: null });
    await act(async () => {
      window.dispatchEvent(new Event("auth:changed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hookResult?.data.tracks.map((track) => track.id)).toEqual(["b-track"]);

    await act(async () => {
      resolveA({ items: [{ track: { id: "a-private" } }], nextCursor: null });
      await Promise.resolve();
    });
    expect(hookResult?.data.tracks.map((track) => track.id)).toEqual(["b-track"]);
  });

  it("does not let an earlier same-track rollback undo a newer optimistic action", async () => {
    let hookResult: ReturnType<typeof useLikedTracks> | undefined;
    function TestComponent() { hookResult = useLikedTracks(); return null; }
    (api.listLikedTracks as any).mockResolvedValue({ items: [], nextCursor: null });
    await act(async () => { root.render(<TestComponent />); });
    let rollbackUnlike = () => {};
    let rollbackLike = () => {};
    act(() => {
      rollbackUnlike = applyOptimisticUnlike("same-track");
      rollbackLike = applyOptimisticLike("same-track");
    });
    expect(hookResult?.data.tracks.map((track) => track.id)).toContain("same-track");

    act(() => rollbackUnlike());
    expect(hookResult?.data.tracks.map((track) => track.id)).toContain("same-track");
    act(() => rollbackLike());
  });

  it("does not let account A's failed optimistic mutation remove account B's override", async () => {
    let hookResult: ReturnType<typeof useLikedTracks> | undefined;
    function TestComponent() { hookResult = useLikedTracks(); return null; }
    (api.listLikedTracks as any).mockResolvedValue({ items: [], nextCursor: null });
    await act(async () => { root.render(<TestComponent />); });
    let rollbackA = () => {};
    act(() => { rollbackA = applyOptimisticLike("same-track"); });

    mocks.session = { accessToken: "token-b", user: { id: "u2" } };
    mocks.boundary++;
    await act(async () => {
      window.dispatchEvent(new Event("auth:changed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => { applyOptimisticLike("same-track"); });
    act(() => rollbackA());
    expect(hookResult?.data.tracks.map((track) => track.id)).toContain("same-track");
  });
});
