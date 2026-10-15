// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSearchAll } from "./useSearchAll";
import { useSearchTracks } from "./useSearchTracks";
import { useSearchArtists } from "./useSearchArtists";
import { useSearchAlbums } from "./useSearchAlbums";
import { useSearchPlaylists } from "./useSearchPlaylists";

const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("@/shared/api", () => ({
  api: { search: mocks.search },
  toClientTrack: (track: any) => ({ ...track, artists: "Artist", coverUrl: "", durationMs: 0, playCount: 0 }),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => vi.resetAllMocks());

type HookResult = Record<string, any>;
const cases: Array<{ name: string; use: (query: string, options: any) => HookResult; key: string }> = [
  { name: "all", use: (query, options) => useSearchAll(query, options), key: "items" },
  { name: "tracks", use: (query, options) => useSearchTracks(query, options), key: "tracks" },
  { name: "artists", use: (query, options) => useSearchArtists(query, options), key: "artists" },
  { name: "albums", use: (query, options) => useSearchAlbums(query, options), key: "albums" },
  { name: "playlists", use: (query, options) => useSearchPlaylists(query, options), key: "playlists" },
];

describe.each(cases)("useSearch$", ({ use, key }) => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.resetAllMocks();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("invalidates the in-flight query when search is disabled", async () => {
    let resolveSearch!: (value: any) => void;
    mocks.search.mockReturnValue(new Promise((resolve) => { resolveSearch = resolve; }));
    let result!: HookResult;
    function TestComponent({ query, enabled }: { query: string; enabled: boolean }) {
      result = use(query, { enabled, debounceMs: 0 });
      return null;
    }

    await act(async () => { root.render(<TestComponent query="first" enabled />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mocks.search).toHaveBeenCalledTimes(1);

    await act(async () => { root.render(<TestComponent query="first" enabled={false} />); });
    resolveSearch({ items: [{ type: "track", id: "stale-row", title: "Stale" }] });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result[key]).toEqual([]);
    expect(result.loading).toBe(false);
    expect(result.hasLoaded).toBe(false);
  });
});

it("keeps the new query empty and loading when an older search completes", async () => {
  let resolveFirst!: (value: any) => void;
  mocks.search.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
  mocks.search.mockReturnValueOnce(new Promise(() => {}));
  let result!: HookResult;
  function TestComponent({ query }: { query: string }) {
    result = useSearchTracks(query, { debounceMs: 0 });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<TestComponent query="first" />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { root.render(<TestComponent query="second" />); });
    resolveFirst({ items: [{ type: "track", id: "stale-row", title: "Stale" }] });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.tracks).toEqual([]);
    expect(result.loading).toBe(true);
    expect(result.hasLoaded).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("clears completed results as soon as a different query becomes active", async () => {
  mocks.search.mockResolvedValueOnce({ items: [{ type: "track", id: "first-row", title: "First" }] });
  mocks.search.mockReturnValueOnce(new Promise(() => {}));
  let result!: ReturnType<typeof useSearchTracks>;
  function TestComponent({ query }: { query: string }) {
    result = useSearchTracks(query, { debounceMs: 0 });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<TestComponent query="first" />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(result.tracks.map((track) => track.id)).toEqual(["first-row"]);

    await act(async () => { root.render(<TestComponent query="second" />); });
    expect(result.tracks).toEqual([]);
    expect(result.loading).toBe(true);
    expect(result.hasLoaded).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("starts a fresh request when switching away from a cached query and back", async () => {
  mocks.search
    .mockResolvedValueOnce({ items: [{ type: "track", id: "first-row", title: "First" }] })
    .mockReturnValueOnce(new Promise(() => {}))
    .mockResolvedValueOnce({ items: [{ type: "track", id: "fresh-first-row", title: "Fresh first" }] });
  let result!: ReturnType<typeof useSearchTracks>;
  function TestComponent({ query }: { query: string }) {
    result = useSearchTracks(query, { debounceMs: 0 });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<TestComponent query="first" />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(result.tracks.map((track) => track.id)).toEqual(["first-row"]);

    await act(async () => { root.render(<TestComponent query="second" />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { root.render(<TestComponent query="first" />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(mocks.search).toHaveBeenCalledTimes(3);
    expect(mocks.search).toHaveBeenLastCalledWith("first", "track");
    expect(result.tracks.map((track) => track.id)).toEqual(["fresh-first-row"]);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
