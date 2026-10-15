import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("API endpoint transport policy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_API_URL", "");
    vi.stubEnv("DEV", true);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(["network", "status", "timeout"])("keeps HTTPS after a %s health failure", async (failure) => {
    const { DEFAULT_PRIMARY_API, getApiBaseUrl, initApiEndpointProbe } = await import("./baseUrl");
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      if (failure === "network") return Promise.reject(new TypeError("offline"));
      if (failure === "status") return Promise.resolve({ ok: false, status: 503 });
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }));

    const probe = initApiEndpointProbe(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await probe).toBe(DEFAULT_PRIMARY_API);
    expect(getApiBaseUrl()).toBe(DEFAULT_PRIMARY_API);
    expect(localStorage.getItem("liner_active_api_base")).toBe(DEFAULT_PRIMARY_API);
  });

  it("preserves HTTPS and shares successful concurrent health probes", async () => {
    const { DEFAULT_PRIMARY_API, initApiEndpointProbe } = await import("./baseUrl");
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const probe = initApiEndpointProbe();
    expect(initApiEndpointProbe()).toBe(probe);
    expect(await probe).toBe(DEFAULT_PRIMARY_API);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(`${DEFAULT_PRIMARY_API}/health`, expect.objectContaining({ redirect: "error" }));
  });

  it("ignores a previously persisted insecure relay", async () => {
    localStorage.setItem("liner_active_api_base", "http://edge.tryliner.fun:10518");
    const { DEFAULT_PRIMARY_API, getApiBaseUrl } = await import("./baseUrl");
    expect(getApiBaseUrl()).toBe(DEFAULT_PRIMARY_API);
  });

  it.each([
    "http://edge.tryliner.fun:10518",
    "HTTP://example.com/",
    "http://localhost.example.com:1337",
    "http://localhost@evil.example",
    "//api.tryliner.fun",
    "javascript:alert(1)",
    "not a URL",
    "https://user:password@example.com",
    "https://example.com?target=other",
    "https://example.com#fragment",
  ])("rejects an unsafe runtime endpoint: %s", async (url) => {
    const { DEFAULT_PRIMARY_API, getApiBaseUrl, setApiBaseUrl } = await import("./baseUrl");
    expect(() => setApiBaseUrl(url)).toThrow();
    expect(getApiBaseUrl()).toBe(DEFAULT_PRIMARY_API);
    expect(localStorage.getItem("liner_active_api_base")).toBeNull();
  });

  it.each(["http://example.com", "http://edge.tryliner.fun:10518"])("rejects insecure build configuration: %s", async (url) => {
    vi.stubEnv("VITE_API_URL", url);
    await expect(import("./baseUrl")).rejects.toThrow();
  });

  it.each(["http://localhost:1337", "http://127.0.0.1:1337", "http://[::1]:1337"])("allows local HTTP development only: %s", async (url) => {
    vi.stubEnv("VITE_API_URL", url);
    const { getApiBaseUrl, setApiBaseUrl, initApiEndpointProbe } = await import("./baseUrl");
    expect(getApiBaseUrl()).toBe(url);
    setApiBaseUrl(url);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await initApiEndpointProbe()).toBe(url);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["http://localhost:1337", "http://127.0.0.1:1337", "http://[::1]:1337"])("rejects HTTP loopback in production: %s", async (url) => {
    vi.stubEnv("DEV", false);
    const { setApiBaseUrl } = await import("./baseUrl");
    expect(() => setApiBaseUrl(url)).toThrow();
    vi.resetModules();
    vi.stubEnv("VITE_API_URL", url);
    await expect(import("./baseUrl")).rejects.toThrow();
  });

  it("preserves a custom HTTPS API path without probing the official service", async () => {
    vi.stubEnv("VITE_API_URL", "https://custom.example/api///");
    const { getApiBaseUrl, setApiBaseUrl, initApiEndpointProbe } = await import("./baseUrl");
    expect(getApiBaseUrl()).toBe("https://custom.example/api");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await initApiEndpointProbe()).toBe("https://custom.example/api");
    expect(fetch).not.toHaveBeenCalled();
    setApiBaseUrl("https://other.example/");
    expect(getApiBaseUrl()).toBe("https://other.example");
  });
});
