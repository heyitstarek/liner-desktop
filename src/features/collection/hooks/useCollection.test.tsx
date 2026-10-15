// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryCache } from "@/shared/cache/queryCache";
import { getDailyMixesCollectionCacheKey } from "@/features/home/hooks/useDailyMixes";
import { useCollection } from "./useCollection";

const mocks = vi.hoisted(() => ({
  session: { accessToken: "token-a", user: { id: "a" } } as any,
  getDailyMixes: vi.fn(),
}));

vi.mock("@/shared/api", () => ({
  api: { getDailyMixes: mocks.getDailyMixes, getPlaylist: vi.fn(), getAlbum: vi.fn() },
  getAuthSession: () => mocks.session,
  getAuthSessionIdentity: () => mocks.session?.accessToken
    ? mocks.session.user?.id ? `user:${mocks.session.user.id}` : `token:${mocks.session.accessToken}`
    : "anonymous",
  toClientTrack: (track: any) => ({ id: track.id, title: track.title || track.id, artists: "Artist", coverUrl: "", durationMs: 0, playCount: 0 }),
  mediaUrl: (url: string) => url,
}));

describe("useCollection daily mix session cache", () => {
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

  it("uses a per-account cache and rejects a late daily mix response from the old account", async () => {
    let resolveA!: (value: any) => void;
    mocks.getDailyMixes
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockResolvedValueOnce({ items: [{ id: "mix-daily-mix-1", title: "B mix", tracks: [{ id: "b-track" }] }] });

    let result: ReturnType<typeof useCollection> | undefined;
    function TestComponent() { result = useCollection("playlist", "mix-daily-mix-1"); return null; }
    await act(async () => { root.render(<TestComponent />); });
    mocks.session = { accessToken: "token-b", user: { id: "b" } };
    await act(async () => { window.dispatchEvent(new Event("auth:changed")); await Promise.resolve(); await Promise.resolve(); });
    expect(result?.data?.title).toBe("B mix");

    resolveA({ items: [{ id: "mix-daily-mix-1", title: "A private mix", tracks: [{ id: "a-track" }] }] });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result?.data?.title).toBe("B mix");
    expect(queryCache.get(getDailyMixesCollectionCacheKey("user:a", "mix-daily-mix-1"))).toMatchObject({ title: "A private mix" });
    expect(queryCache.get(getDailyMixesCollectionCacheKey("user:b", "mix-daily-mix-1"))).toMatchObject({ title: "B mix" });
  });
});
