import { afterEach, describe, expect, it, vi } from "vitest";
import { queryCache } from "./queryCache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("queryCache request lifecycle", () => {
  afterEach(() => queryCache.clear());

  it("does not repopulate data after clear while a foreground fetch is pending", async () => {
    const result = deferred<string>();
    const request = queryCache.fetchWithSwr("account-library", () => result.promise, { force: true });
    queryCache.clear();
    result.resolve("old account data");

    await expect(request).resolves.toEqual({ data: "old account data", fromCache: false });
    expect(queryCache.get("account-library")).toBeUndefined();
  });

  it("keeps a replacement foreground request registered when an older request settles", async () => {
    const previous = deferred<string>();
    const replacement = deferred<string>();
    const oldRequest = queryCache.fetchWithSwr("account-library", () => previous.promise, { force: true });
    queryCache.delete("account-library");
    const newRequest = queryCache.fetchWithSwr("account-library", () => replacement.promise, { force: true });

    previous.resolve("old account data");
    await oldRequest;
    replacement.resolve("new account data");
    await expect(newRequest).resolves.toEqual({ data: "new account data", fromCache: false });
    expect(queryCache.get("account-library")).toBe("new account data");
  });

  it("does not apply stale background revalidation after clear", async () => {
    const cacheKey = "stale-library";
    const result = deferred<string>();
    const fetcher = vi.fn(() => result.promise);
    queryCache.set(cacheKey, "cached", -1);
    const read = queryCache.fetchWithSwr(cacheKey, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    queryCache.clear();
    result.resolve("stale refresh");

    await expect(read).resolves.toEqual({ data: "cached", fromCache: true });
    await Promise.resolve();
    expect(queryCache.get(cacheKey)).toBeUndefined();
  });

  it("does not apply stale background revalidation after delete", async () => {
    const cacheKey = "deleted-stale-library";
    const result = deferred<string>();
    const fetcher = vi.fn(() => result.promise);
    queryCache.set(cacheKey, "cached", -1);
    const read = queryCache.fetchWithSwr(cacheKey, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    queryCache.delete(cacheKey);
    result.resolve("deleted refresh");

    await expect(read).resolves.toEqual({ data: "cached", fromCache: true });
    await Promise.resolve();
    expect(queryCache.get(cacheKey)).toBeUndefined();
  });
});
