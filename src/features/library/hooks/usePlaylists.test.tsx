// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryCache } from "@/shared/cache/queryCache";
import { usePlaylist } from "./usePlaylists";

const mocks = vi.hoisted(() => ({
  session: { accessToken: "token-a", user: { id: "a" } } as any,
  getUserPlaylist: vi.fn(),
}));

vi.mock("@/shared/api", () => ({
  api: { getUserPlaylist: mocks.getUserPlaylist },
  getAuthSession: () => mocks.session,
  getAuthSessionIdentity: () => mocks.session?.accessToken
    ? mocks.session.user?.id ? `user:${mocks.session.user.id}` : `token:${mocks.session.accessToken}`
    : "anonymous",
  mediaUrl: (url: string) => url,
  toClientTrack: (track: any) => ({
    id: track.id,
    title: track.title || track.id,
    artists: "Artist",
    coverUrl: "",
    durationMs: 0,
    playCount: 0,
  }),
}));

describe("usePlaylist session isolation", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryCache.clear();
    vi.clearAllMocks();
    mocks.session = { accessToken: "token-a", user: { id: "a" } };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryCache.clear();
  });

  it("does not render or cache account A playlist details after switching to account B", async () => {
    let resolveA!: (value: any) => void;
    let resolveB!: (value: any) => void;
    mocks.getUserPlaylist
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));

    let result: ReturnType<typeof usePlaylist> | undefined;
    function TestComponent() { result = usePlaylist("same-id"); return null; }
    await act(async () => { root.render(<TestComponent />); });

    mocks.session = { accessToken: "token-b", user: { id: "b" } };
    await act(async () => { window.dispatchEvent(new Event("auth:changed")); });
    resolveB({ playlist: { id: "same-id", title: "B private playlist", revision: 1, updatedAt: "b" }, items: [{ id: "b-item", track: { id: "b-track" } }] });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result?.data?.title).toBe("B private playlist");

    resolveA({ playlist: { id: "same-id", title: "A private playlist", revision: 1, updatedAt: "a" }, items: [{ id: "a-item", track: { id: "a-track" } }] });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result?.data?.title).toBe("B private playlist");
    expect(queryCache.get("playlist:detail:user:a:same-id")).toBeUndefined();
    expect(queryCache.get("playlist:detail:user:b:same-id")).toMatchObject({ title: "B private playlist" });
  });

  it("does not request private playlist details without an authenticated session", async () => {
    mocks.session = null;
    let result: ReturnType<typeof usePlaylist> | undefined;
    function TestComponent() { result = usePlaylist("private-id"); return null; }
    await act(async () => { root.render(<TestComponent />); });
    expect(mocks.getUserPlaylist).not.toHaveBeenCalled();
    expect(result).toMatchObject({ data: null, isLoading: false });
  });
});
