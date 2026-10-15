// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { getDailyMixArtists } from "./useDailyMixes";
import type { Track } from "@/shared/types";

const mocks = vi.hoisted(() => ({
  session: { accessToken: "token-a", user: { id: "a" } } as any,
  getDailyMixes: vi.fn(),
}));
vi.mock("@/shared/api", () => ({
  api: { getDailyMixes: mocks.getDailyMixes },
  getAuthSession: () => mocks.session,
  getAuthSessionIdentity: () => mocks.session?.accessToken
    ? mocks.session.user?.id ? `user:${mocks.session.user.id}` : `token:${mocks.session.accessToken}`
    : "anonymous",
  toClientTrack: (track: any) => ({ id: track.id, title: track.title || track.id, artists: "Artist", coverUrl: "", durationMs: 0, playCount: 0 }),
  mediaUrl: (url: string) => url,
}));
import { useDailyMixes } from "./useDailyMixes";

describe("getDailyMixArtists", () => {
  it("extracts 3-4 artists from cluster artists and tracks", () => {
    const clusterArtists = ["Rae Sremmurd"];
    const tracks: Track[] = [
      {
        id: "1",
        title: "No Type",
        artists: "Rae Sremmurd",
        coverUrl: "",
        durationMs: 200000,
        playCount: 10,
      },
      {
        id: "2",
        title: "For The Night",
        artists: "Pop Smoke, Lil Baby, DaBaby",
        artistList: [
          { id: "a1", name: "Pop Smoke" },
          { id: "a2", name: "Lil Baby" },
          { id: "a3", name: "DaBaby" },
        ],
        coverUrl: "",
        durationMs: 190000,
        playCount: 5,
      },
      {
        id: "3",
        title: "Hope",
        artists: "XXXTENTACION",
        coverUrl: "",
        durationMs: 110000,
        playCount: 20,
      },
    ];

    const result = getDailyMixArtists(clusterArtists, tracks, 4);
    expect(result).toEqual(["Rae Sremmurd", "Pop Smoke", "Lil Baby", "DaBaby"]);
  });

  it("deduplicates case-insensitively and handles missing cluster artists", () => {
    const tracks: Track[] = [
      {
        id: "1",
        title: "Track 1",
        artists: "Drake",
        coverUrl: "",
        durationMs: 200000,
        playCount: 10,
      },
      {
        id: "2",
        title: "Track 2",
        artists: "drake, 21 Savage",
        coverUrl: "",
        durationMs: 200000,
        playCount: 10,
      },
    ];

    const result = getDailyMixArtists([], tracks, 4);
    expect(result).toEqual(["Drake", "21 Savage"]);
  });
});

describe("useDailyMixes session isolation", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    mocks.session = { accessToken: "token-a", user: { id: "a" } };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not expose or cache account A mixes after switching to account B", async () => {
    let resolveA!: (value: any) => void;
    mocks.getDailyMixes.mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }));
    let result: ReturnType<typeof useDailyMixes> | undefined;
    function TestComponent() { result = useDailyMixes(); return null; }
    await act(async () => { root.render(<TestComponent />); });
    mocks.session = { accessToken: "token-b", user: { id: "b" } };
    mocks.getDailyMixes.mockResolvedValueOnce({ items: [{ id: "mix-b", title: "B mix", tracks: [{ id: "b-track" }] }] });
    await act(async () => { window.dispatchEvent(new Event("auth:changed")); await Promise.resolve(); await Promise.resolve(); });
    expect(result?.data.map((mix) => mix.id)).toEqual(["mix-b"]);

    await act(async () => { resolveA({ items: [{ id: "mix-a", title: "A mix", tracks: [{ id: "a-private" }] }] }); await Promise.resolve(); });
    expect(result?.data.map((mix) => mix.id)).toEqual(["mix-b"]);
  });

  it("does not request personalized mixes without an authenticated session", async () => {
    mocks.session = null;
    function TestComponent() { useDailyMixes(); return null; }
    await act(async () => { root.render(<TestComponent />); });
    expect(mocks.getDailyMixes).not.toHaveBeenCalled();
  });
});
