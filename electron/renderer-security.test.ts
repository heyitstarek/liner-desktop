import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createGuardedIpc,
  isAllowedCorsDestination,
  isTrustedIpcSender,
  isTrustedRendererDocument,
  rendererCorsHeaders,
  RendererSecurity,
  type RendererDocumentPolicy,
} from "./renderer-security";

const builtInIndexPath = path.join(os.tmpdir(), "liner-security-test", "dist", "index.html");
const activeBundleIndexPath = path.join(os.tmpdir(), "liner-security-test", "bundles", "current", "dist", "index.html");
const builtInUrl = pathToFileURL(builtInIndexPath).href;
const activeBundleUrl = pathToFileURL(activeBundleIndexPath).href;
const policy: RendererDocumentPolicy = {
  builtInIndexPath,
  activeBundleIndexPath,
  devServerUrl: "http://localhost:5173/",
};

describe("renderer document policy", () => {
  it("trusts only the built-in or active index document and configured dev origin", () => {
    expect(isTrustedRendererDocument(`${builtInUrl}#/overlay`, policy)).toBe(true);
    expect(
      isTrustedRendererDocument(
        `${activeBundleUrl}#/settings`,
        policy,
      ),
    ).toBe(true);
    expect(isTrustedRendererDocument("http://localhost:5173/#/overlay", policy)).toBe(true);
    expect(isTrustedRendererDocument("http://localhost:5174/", policy)).toBe(false);
    expect(isTrustedRendererDocument(pathToFileURL(path.join(path.dirname(builtInIndexPath), "other.html")).href, policy)).toBe(false);
    expect(isTrustedRendererDocument("https://evil.example/", policy)).toBe(false);
    expect(isTrustedRendererDocument("javascript:alert(1)", policy)).toBe(false);
  });

  it("uses the current active-bundle index path without trusting sibling files", () => {
    let activePath: string | null = activeBundleIndexPath;
    const dynamicPolicy = { ...policy, activeBundleIndexPath: () => activePath };
    expect(isTrustedRendererDocument(`${activeBundleUrl}#/album/one`, dynamicPolicy)).toBe(true);
    activePath = path.join(os.tmpdir(), "liner-security-test", "bundles", "next", "dist", "index.html");
    expect(isTrustedRendererDocument(`${activeBundleUrl}#/album/one`, dynamicPolicy)).toBe(false);
    expect(isTrustedRendererDocument(`${builtInUrl}#/album/one`, dynamicPolicy)).toBe(true);
  });

  it("keeps the exact loaded bundle trusted until navigation while denying unrelated files", () => {
    let activePath: string | null = activeBundleIndexPath;
    const loadedPath = path.join(os.tmpdir(), "liner-security-test", "bundles", "current", "dist", "index.html");
    const nextPath = path.join(os.tmpdir(), "liner-security-test", "bundles", "next", "dist", "index.html");
    const foreignPath = path.join(os.tmpdir(), "liner-security-test", "bundles", "foreign", "dist", "index.html");
    const loadedUrl = pathToFileURL(loadedPath).href;
    const nextUrl = pathToFileURL(nextPath).href;
    const foreignUrl = pathToFileURL(foreignPath).href;
    const mainContents = {
      mainFrame: { url: loadedUrl },
    } as any;
    const dynamicPolicy = { ...policy, activeBundleIndexPath: () => activePath };
    const security = new RendererSecurity({
      ...dynamicPolicy,
      windows: { main: () => mainContents, overlay: () => null },
    });

    security.authorizeLoadedDocument(mainContents, loadedUrl);
    activePath = nextPath;

    expect(security.isTrustedIpcSender({ sender: mainContents, senderFrame: mainContents.mainFrame } as any, "main")).toBe(true);
    expect(security.trustedOriginForRequest(mainContents, mainContents.mainFrame)).toBe("null");
    mainContents.mainFrame.url = nextUrl;
    expect(security.isTrustedIpcSender({ sender: mainContents, senderFrame: mainContents.mainFrame } as any, "main")).toBe(true);
    mainContents.mainFrame.url = foreignUrl;
    expect(security.isTrustedIpcSender({ sender: mainContents, senderFrame: mainContents.mainFrame } as any, "main")).toBe(false);
    expect(security.trustedOriginForRequest(mainContents, mainContents.mainFrame)).toBeNull();
  });
});

describe("scoped cross-origin compatibility", () => {
  it("allows only HTTPS API/media destinations on explicit host boundaries", () => {
    expect(isAllowedCorsDestination("https://api.tryliner.fun/v1/search")).toBe(true);
    expect(isAllowedCorsDestination("https://rr3---sn.googlevideo.com/audio")).toBe(true);
    expect(isAllowedCorsDestination("https://lh3.googleusercontent.com/avatar")).toBe(true);
    expect(isAllowedCorsDestination("https://evilgooglevideo.com/audio")).toBe(false);
    expect(isAllowedCorsDestination("http://api.tryliner.fun/v1/search")).toBe(false);
    expect(isAllowedCorsDestination("https://api.tryliner.fun.evil.example/v1/search")).toBe(false);
    expect(isAllowedCorsDestination("https://custom.example:8443/v1", undefined, false, ["https://custom.example:8443"])).toBe(true);
    expect(isAllowedCorsDestination("https://custom.example:9443/v1", undefined, false, ["https://custom.example:8443"])).toBe(false);
    expect(isAllowedCorsDestination("http://localhost:1337/v1", undefined, false, ["http://localhost:1337"])).toBe(false);
    expect(isAllowedCorsDestination("http://localhost:1337/v1", undefined, true, ["http://localhost:1337"])).toBe(true);
    expect(isAllowedCorsDestination("http://[::1]:1337/v1", undefined, true, ["http://[::1]:1337"])).toBe(true);
  });

  it("returns explicit CORS methods and headers for a trusted renderer origin", () => {
    const headers = rendererCorsHeaders({}, "null", "POST");
    expect(headers).not.toBeNull();
    if (!headers) throw new Error("Expected CORS compatibility headers");
    expect(headers["access-control-allow-origin"]).toEqual(["null"]);
    expect(headers["access-control-allow-methods"]).toEqual([
      "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    ]);
    expect(headers["access-control-allow-headers"]).toEqual([
      "authorization, content-type, range, x-request-id, x-client-version, x-platform, x-user-id, x-user-name, x-session-id, x-liner-signature, x-liner-timestamp, x-liner-nonce",
    ]);
    expect(headers["access-control-expose-headers"]).toEqual([
      "Accept-Ranges, Content-Length, Content-Range, Content-Type, Date, X-Request-Id",
    ]);
    expect(headers["access-control-allow-origin"]).not.toEqual(["*"]);
    expect(rendererCorsHeaders({}, "null", "CONNECT")).toBeNull();
  });

  it("does not apply compatibility outside the explicitly configured fixture hosts", () => {
    expect(isAllowedCorsDestination("https://api.fixture.test/v1", { exact: ["api.fixture.test"] })).toBe(true);
    expect(isAllowedCorsDestination("https://other.fixture.test/v1", { exact: ["api.fixture.test"] })).toBe(false);
    expect(isAllowedCorsDestination("https://child.media.test/v1", { suffixes: ["media.test"] })).toBe(true);
    expect(isAllowedCorsDestination("https://badmedia.test/v1", { suffixes: ["media.test"] })).toBe(false);
  });
});

describe("privileged IPC sender policy", () => {
  const trustedMain = { mainFrame: { url: `${builtInUrl}#/` } } as any;
  const trustedOverlay = { mainFrame: { url: `${builtInUrl}#/overlay` } } as any;
  const windows = { main: () => trustedMain, overlay: () => trustedOverlay };

  it("accepts only intended windows and their trusted top-level frame", () => {
    expect(isTrustedIpcSender({ sender: trustedMain, senderFrame: trustedMain.mainFrame } as any, "main", windows, policy)).toBe(true);
    expect(isTrustedIpcSender({ sender: trustedOverlay, senderFrame: trustedOverlay.mainFrame } as any, "overlay", windows, policy)).toBe(true);
    expect(isTrustedIpcSender({ sender: trustedOverlay, senderFrame: trustedOverlay.mainFrame } as any, "main", windows, policy)).toBe(false);
    expect(isTrustedIpcSender({ sender: trustedMain, senderFrame: { url: trustedMain.mainFrame.url } } as any, "either", windows, policy)).toBe(false);
    const hostile = { mainFrame: { url: "https://evil.example/" } } as any;
    expect(isTrustedIpcSender({ sender: hostile, senderFrame: hostile.mainFrame } as any, "either", windows, policy)).toBe(false);
  });

  it("rewrites CORS only for an allowlisted destination requested by a trusted top frame", () => {
    let filter: any;
    let listener: any;
    const security = new RendererSecurity({
      builtInIndexPath,
      devServerUrl: "http://localhost:5173",
      windows: { main: () => trustedMain, overlay: () => trustedOverlay },
    });
    security.installCrossOriginCompatibility({
      webRequest: { onHeadersReceived: (value: any, callback: any) => { filter = value; listener = callback; } },
    } as any);
    expect(filter.urls).toContain("https://api.tryliner.fun/*");

    const callback = vi.fn();
    listener({
      url: "https://api.tryliner.fun/v1/search", method: "POST", responseHeaders: {},
      webContents: trustedMain, frame: trustedMain.mainFrame,
    }, callback);
    expect(callback.mock.calls[0][0].responseHeaders["access-control-allow-origin"]).toEqual(["null"]);

    const unlisted = vi.fn();
    listener({
      url: "https://evil.example/data", method: "GET", responseHeaders: { "content-type": ["text/plain"] },
      webContents: trustedMain, frame: trustedMain.mainFrame,
    }, unlisted);
    expect(unlisted.mock.calls[0][0].responseHeaders).toEqual({ "content-type": ["text/plain"] });

    const childFrame = vi.fn();
    listener({
      url: "https://api.tryliner.fun/v1/search", method: "POST", responseHeaders: {},
      webContents: trustedMain, frame: { url: trustedMain.mainFrame.url },
    }, childFrame);
    expect(childFrame.mock.calls[0][0].responseHeaders).toEqual({});
  });

  it("adds frame and object restrictions to existing OTA index response CSP", () => {
    let listener: any;
    const security = new RendererSecurity({
      builtInIndexPath,
      activeBundleIndexPath,
      windows: { main: () => trustedMain, overlay: () => trustedOverlay },
    });
    security.installCrossOriginCompatibility({
      webRequest: { onHeadersReceived: (_filter: any, callback: any) => { listener = callback; } },
    } as any);
    const callback = vi.fn();

    listener({
      url: activeBundleUrl,
      method: "GET",
      resourceType: "mainFrame",
      responseHeaders: { "Content-Security-Policy": ["default-src 'self'"] },
      webContents: trustedMain,
      frame: trustedMain.mainFrame,
    }, callback);

    expect(callback.mock.calls[0][0].responseHeaders["Content-Security-Policy"]).toEqual([
      "default-src 'self'",
      "frame-src 'none'; object-src 'none'",
    ]);
  });

  it("blocks foreign frame navigations and redirects while denying all popup windows", () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    let openHandler: ((details: { url: string }) => { action: string }) | undefined;
    const webContents = {
      on: (event: string, listener: (...args: any[]) => void) => listeners.set(event, listener),
      setWindowOpenHandler: (listener: typeof openHandler) => { openHandler = listener; },
    } as any;
    const openExternal = vi.fn();
    const security = new RendererSecurity({
      builtInIndexPath,
      devServerUrl: policy.devServerUrl,
      windows: { main: () => null, overlay: () => null },
    });
    security.installNavigationGuards(webContents, openExternal);

    let framePrevented = false;
    listeners.get("will-frame-navigate")!({ url: "https://evil.example/", isMainFrame: true, preventDefault: () => { framePrevented = true; } });
    let redirectPrevented = false;
    listeners.get("will-redirect")!({ preventDefault: () => { redirectPrevented = true; } }, "https://evil.example/", false, true);
    expect(framePrevented).toBe(true);
    expect(redirectPrevented).toBe(true);
    expect(openHandler!({ url: "https://example.com/path" })).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/path");
    expect(openHandler!({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledOnce();
  });
});

describe("guarded IPC registration", () => {
  it("rejects an unauthorized invoke before running its handler", async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const registrar = {
      handle: vi.fn((channel: string, listener: (...args: any[]) => any) => {
        handlers.set(channel, listener);
      }),
      on: vi.fn(),
    };
    const trusted = vi.fn(() => false);
    const ipc = createGuardedIpc(registrar, "main", trusted);
    const sideEffect = vi.fn(() => "secret");
    ipc.handle("native:action", sideEffect);

    await expect(handlers.get("native:action")!({ sender: {} })).rejects.toThrow(
      "Unauthorized IPC sender",
    );
    expect(trusted).toHaveBeenCalledWith({ sender: {} }, "main");
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it("ignores unauthorized one-way IPC before running its listener", () => {
    let registered: ((...args: any[]) => void) | undefined;
    const registrar = {
      handle: vi.fn(),
      on: vi.fn((_channel: string, listener: (...args: any[]) => void) => {
        registered = listener;
      }),
    };
    const ipc = createGuardedIpc(registrar, "overlay", () => false);
    const sideEffect = vi.fn();
    ipc.on("overlay:close", sideEffect);
    registered?.({ sender: {} });
    expect(sideEffect).not.toHaveBeenCalled();
  });
});
