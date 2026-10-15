import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/shared/ui/Toast", () => ({ showToast: vi.fn() }));
vi.mock("@/shared/ui", () => ({ showToast: vi.fn() }));
import { api } from "@/shared/api";
import { playerEngine, usePlayerStore } from "./playerEngine";
import { playerRuntime } from "./playerRuntime";
import { lyricsCache, useLyricsStore } from "@/features/lyrics";
import { linerDb, type CachedLyricsRecord } from "@/shared/storage";
import { clearStorageCategories } from "@/shared/utils/cacheManager";
import type { Track } from "@/shared/types";
import type { LyricsCandidate } from "@/shared/contracts/lyrics";

const track = (id: string): Track => ({
  id,
  title: `Track ${id}`,
  artists: "Test artist",
  durationMs: 120_000,
  coverUrl: "",
  playCount: 0,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("player queue clear", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not restore similar tracks returned after the user clears upcoming tracks", async () => {
    vi.useFakeTimers();
    const current = track("current");
    const similar = track("similar");
    const radioResponse = deferred<{ items: Track[] }>();
    vi.spyOn(playerRuntime!, "loadAndPlay").mockResolvedValue();
    vi.spyOn(playerRuntime!, "preloadTrack").mockResolvedValue();
    vi.spyOn(api, "getRadio").mockReturnValue(radioResponse.promise as never);
    vi.spyOn(api, "streamLyrics").mockImplementation(async function* () {});

    usePlayerStore.setState({
      status: "idle",
      queue: [],
      currentIndex: -1,
      currentTrack: null,
      positionMs: 0,
      durationMs: 0,
      autoplaySimilar: true,
    });

    await playerEngine.playTrack(current, [current]);
    await vi.advanceTimersByTimeAsync(400);
    expect(api.getRadio).toHaveBeenCalledTimes(1);

    playerEngine.clearQueue();
    radioResponse.resolve({ items: [similar] });
    await Promise.resolve();
    await Promise.resolve();

    expect(usePlayerStore.getState().queue.map((item) => item.id)).toEqual([
      "current",
    ]);
  });

  it("restores a station's original order when shuffle is turned off", async () => {
    const prior = track("prior");
    const station = track("station");
    const first = track("radio-first");
    const second = track("radio-second");
    const third = track("radio-third");
    const response = deferred<{ items: Track[] }>();
    vi.spyOn(playerRuntime!, "loadAndPlay").mockResolvedValue();
    vi.spyOn(api, "getRadio").mockReturnValue(response.promise as never);
    vi.spyOn(Math, "random").mockReturnValue(0);

    usePlayerStore.setState({
      status: "idle",
      queue: [],
      currentIndex: -1,
      currentTrack: null,
      positionMs: 0,
      durationMs: 0,
      autoplaySimilar: false,
      shuffle: false,
    });

    await playerEngine.playTrack(prior, [prior, track("prior-next")]);
    const stationLoad = playerEngine.startRadioStation(station);
    playerEngine.setShuffle(true);
    response.resolve({ items: [first, second, third] });
    await stationLoad;

    expect(usePlayerStore.getState().queue.map((item) => item.id)).not.toEqual([
      station.id,
      first.id,
      second.id,
      third.id,
    ]);

    playerEngine.setShuffle(false);
    expect(usePlayerStore.getState().queue.map((item) => item.id)).toEqual([
      station.id,
      first.id,
      second.id,
      third.id,
    ]);
  });
});

describe("track-scoped lyrics reads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not restore cached lyrics after the selected track is cleared", async () => {
    const selected = track("stale-lyrics-track");
    const cached: CachedLyricsRecord = {
      trackId: selected.id,
      syncLevel: "line_level",
      quality: 80,
      activeProvider: "lrclib",
      availableProviders: [],
      rawLyrics: "[00:01.00] Stale line",
      rawFormat: "lrc",
      candidate: {
        provider: "lrclib",
        contentKind: "line_synced",
        syncLevel: "line_level",
        quality: {
          total: 80,
          match: 25,
          content: 25,
          sync: 30,
          source: 0,
          reasons: [],
        },
        lyrics: { format: "lrc", content: "[00:01.00] Stale line" },
      },
      lastCheckedAt: Date.now(),
      updatedAt: Date.now(),
    };
    const pendingRead = deferred<CachedLyricsRecord | null>();
    vi.spyOn(linerDb, "getLyrics").mockReturnValue(pendingRead.promise);
    vi.spyOn(playerRuntime!, "loadAndPlay").mockResolvedValue();
    vi.spyOn(playerRuntime!, "pause").mockImplementation(() => {});

    useLyricsStore.getState().reset();
    await playerEngine.playTrack(selected, [selected]);
    await playerEngine.skipNext();
    expect(usePlayerStore.getState().currentTrack).toBeNull();

    pendingRead.resolve(cached);
    await Promise.resolve();
    await Promise.resolve();

    expect(useLyricsStore.getState().currentLyricsTrackId).toBeNull();
    expect(useLyricsStore.getState().rawLyrics).toBeNull();
  });

  it("does not let a late cached read for track A replace selected track B lyrics", async () => {
    const selectedA = track("lyrics-track-a");
    const selectedB = track("lyrics-track-b");
    const cachedA = makeCachedLyrics(selectedA.id, "Cached A lyrics");
    const cachedB = makeCachedLyrics(selectedB.id, "Cached B lyrics");
    const pendingA = deferred<CachedLyricsRecord | null>();
    const pendingB = deferred<CachedLyricsRecord | null>();
    vi.spyOn(linerDb, "getLyrics").mockImplementation((trackId) =>
      (trackId === selectedA.id ? pendingA.promise : pendingB.promise),
    );
    vi.spyOn(playerRuntime!, "loadAndPlay").mockResolvedValue();

    useLyricsStore.getState().reset();
    await playerEngine.playTrack(selectedA, [selectedA]);
    await playerEngine.playTrack(selectedB, [selectedB]);

    pendingB.resolve(cachedB);
    await Promise.resolve();
    pendingA.resolve(cachedA);
    await Promise.resolve();
    await Promise.resolve();

    expect(useLyricsStore.getState().currentLyricsTrackId).toBe(selectedB.id);
    expect(useLyricsStore.getState().rawLyrics).toBe("[00:01.00] Cached B lyrics");
  });

  it("keeps an in-flight prefetch from restoring lyrics after the cache is cleared", async () => {
    const current = track("lyrics-clear-current");
    const next = track("lyrics-clear-next");
    const releaseStream = deferred<void>();
    let finishStream!: () => void;
    const streamFinished = new Promise<void>((resolve) => {
      finishStream = resolve;
    });
    const candidate = {
      provider: "lrclib",
      contentKind: "line_synced",
      syncLevel: "line_level",
      quality: {
        total: 80,
        match: 25,
        content: 25,
        sync: 30,
        source: 0,
        reasons: [],
      },
      lyrics: { format: "lrc", content: "[00:01.00] Prefetched line" },
    } as const;

    vi.spyOn(linerDb, "getLyrics").mockResolvedValue(null);
    vi.spyOn(playerRuntime!, "loadAndPlay").mockResolvedValue();
    vi.spyOn(playerRuntime!, "preloadTrack").mockResolvedValue();
    vi.spyOn(api, "streamLyrics").mockImplementation((trackId) => {
      if (trackId !== next.id) {
        return (async function* () {})() as never;
      }
      return (async function* () {
        try {
          await releaseStream.promise;
          yield { type: "provider", status: "found", candidate } as never;
          yield { type: "done", best: candidate } as never;
        } finally {
          finishStream();
        }
      })() as never;
    });

    lyricsCache.clear();
    await linerDb.clearStore("lyrics");
    usePlayerStore.setState({
      status: "idle",
      queue: [],
      currentIndex: -1,
      currentTrack: null,
      positionMs: 0,
      durationMs: 0,
      autoplaySimilar: false,
    });

    await playerEngine.playTrack(current, [current, next]);
    await vi.waitFor(() => expect(api.streamLyrics).toHaveBeenCalledWith(next.id, expect.anything()));

    await clearStorageCategories(["lyrics"]);
    releaseStream.resolve();
    await streamFinished;
    await Promise.resolve();
    await Promise.resolve();

    expect(lyricsCache.has(next.id)).toBe(false);
    expect(await linerDb.getLyrics(next.id)).toBeNull();
  });
});

function makeCachedLyrics(trackId: string, content: string): CachedLyricsRecord {
  const candidate = {
    provider: "lrclib",
    contentKind: "line_synced",
    syncLevel: "line_level",
    quality: {
      total: 80,
      match: 25,
      content: 25,
      sync: 30,
      source: 0,
      reasons: [],
    },
    lyrics: { format: "lrc", content: `[00:01.00] ${content}` },
  } as LyricsCandidate;
  return {
    trackId,
    syncLevel: candidate.syncLevel,
    quality: candidate.quality.total,
    activeProvider: candidate.provider,
    availableProviders: [],
    rawLyrics: candidate.lyrics.content,
    rawFormat: "lrc",
    candidate,
    lastCheckedAt: Date.now(),
    updatedAt: Date.now(),
  };
}
