import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const workerSource = readFileSync(
  "public/cover-sw.js",
  "utf8",
);

describe("cover service worker activation", () => {
  it("removes old cover caches while preserving caches owned by other features", async () => {
    const listeners = new Map<string, (event: any) => void>();
    const deleteCache = vi.fn(async () => true);
    const claimClients = vi.fn(async () => undefined);
    const self = {
      addEventListener: (type: string, listener: (event: any) => void) => {
        listeners.set(type, listener);
      },
      skipWaiting: vi.fn(async () => undefined),
      clients: { claim: claimClients },
    };
    const caches = {
      keys: vi.fn(async () => ["liner-covers-v1", "liner-covers-v2", "music-data-v1"]),
      delete: deleteCache,
      open: vi.fn(),
    };

    runInNewContext(workerSource, { self, caches, URL, fetch: vi.fn() });

    let activation: Promise<unknown> | undefined;
    listeners.get("activate")?.({ waitUntil: (promise: Promise<unknown>) => { activation = promise; } });
    await activation;

    expect(deleteCache).toHaveBeenCalledTimes(1);
    expect(deleteCache).toHaveBeenCalledWith("liner-covers-v1");
    expect(claimClients).toHaveBeenCalledTimes(1);
  });
});
