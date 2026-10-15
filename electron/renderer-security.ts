import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain,
  Session,
} from "electron";

export type RendererRole = "main" | "overlay" | "either";

export interface RendererDocumentPolicy {
  builtInIndexPath: string;
  activeBundleIndexPath?: string | null | (() => string | null | undefined);
  devServerUrl?: string | null;
}

export interface RendererWindows {
  main: () => WebContents | null;
  overlay: () => WebContents | null;
}

export type IpcSecurityEvent = IpcMainEvent | IpcMainInvokeEvent;

export interface IpcMainRegistrar {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
  ): void;
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void;
}

export interface GuardedIpc {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
  ): void;
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void;
}

export const CORS_COMPATIBILITY_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

export const CORS_COMPATIBILITY_HEADERS = [
  "authorization",
  "content-type",
  "range",
  "x-request-id",
  "x-client-version",
  "x-platform",
  "x-user-id",
  "x-user-name",
  "x-session-id",
  "x-liner-signature",
  "x-liner-timestamp",
  "x-liner-nonce",
] as const;

const EXACT_CORS_HOSTS = new Set([
  "api.tryliner.fun",
  "covers.tryliner.fun",
  "monitor.tryliner.fun",
  "import.tryliner.fun",
  "i.pinimg.com",
  "images.genius.com",
  "yandex-images.clstorage.net",
]);

const CORS_HOST_SUFFIXES = [
  "googlevideo.com",
  "googleusercontent.com",
  "ggpht.com",
  "ytimg.com",
  "sndcdn.com",
  "i.pinimg.com",
  "images.genius.com",
  "yandex-images.clstorage.net",
] as const;

export const CORS_COMPATIBILITY_URL_FILTER = [
  ...[...EXACT_CORS_HOSTS].map((host) => `https://${host}/*`),
  ...CORS_HOST_SUFFIXES.flatMap((suffix) => [
    `https://${suffix}/*`,
    `https://*.${suffix}/*`,
  ]),
];

function getUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function normalizeFilesystemPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function rendererFilePath(rawUrl: string): string | null {
  const url = getUrl(rawUrl);
  if (!url || url.protocol !== "file:" || url.search) return null;
  try {
    return normalizeFilesystemPath(fileURLToPath(url));
  } catch {
    return null;
  }
}

function devOrigin(devServerUrl: string | null | undefined): string | null {
  if (!devServerUrl) return null;
  const url = getUrl(devServerUrl);
  if (!url || !["http:", "https:"].includes(url.protocol)) return null;
  return url.origin;
}

export function isTrustedRendererDocument(
  rawUrl: string,
  policy: RendererDocumentPolicy,
): boolean {
  const url = getUrl(rawUrl);
  if (!url) return false;

  if (url.protocol === "file:") {
    if (url.search) return false;
    const actualPath = rendererFilePath(rawUrl);
    if (!actualPath) return false;
    const activeBundleIndexPath = typeof policy.activeBundleIndexPath === "function"
      ? policy.activeBundleIndexPath()
      : policy.activeBundleIndexPath;
    return [policy.builtInIndexPath, activeBundleIndexPath]
      .filter((candidate): candidate is string => Boolean(candidate))
      .some((candidate) => {
        try {
          return actualPath ===
            normalizeFilesystemPath(fileURLToPath(pathToFileURL(path.resolve(candidate))));
        } catch {
          return false;
        }
      });
  }

  const configuredOrigin = devOrigin(policy.devServerUrl);
  return Boolean(configuredOrigin && url.origin === configuredOrigin);
}

export function trustedRendererOrigin(rawUrl: string): string | null {
  const url = getUrl(rawUrl);
  if (!url) return null;
  if (url.protocol === "file:") return "null";
  if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  return null;
}

export function isTrustedIpcSender(
  event: IpcSecurityEvent,
  role: RendererRole,
  windows: RendererWindows,
  policy: RendererDocumentPolicy,
): boolean {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;

  const expectedWindows = role === "main"
    ? [windows.main()]
    : role === "overlay"
      ? [windows.overlay()]
      : [windows.main(), windows.overlay()];
  return expectedWindows.some(
    (expected) => expected === event.sender &&
      isTrustedRendererDocument(frame.url, policy),
  );
}

export function createGuardedIpc(
  ipcMain: IpcMainRegistrar,
  role: RendererRole,
  isAuthorized: (event: IpcSecurityEvent, role: RendererRole) => boolean,
): GuardedIpc {
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, async (event, ...args) => {
        if (!isAuthorized(event, role)) {
          throw new Error("Unauthorized IPC sender");
        }
        return listener(event, ...args);
      });
    },
    on(channel, listener) {
      ipcMain.on(channel, (event, ...args) => {
        if (isAuthorized(event, role)) listener(event, ...args);
      });
    },
  };
}

export function isAllowedCorsDestination(
  rawUrl: string,
  hosts?: { exact?: readonly string[]; suffixes?: readonly string[]; origins?: readonly string[] },
  allowLoopbackHttpFixtures = false,
  origins: readonly string[] = [],
  allowConfiguredLoopbackHttp = false,
): boolean {
  const url = getUrl(rawUrl);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  const exactHosts = hosts?.exact ?? [...EXACT_CORS_HOSTS];
  const suffixes = hosts?.suffixes ?? CORS_HOST_SUFFIXES;
  const allowedOrigins = [...(hosts?.origins ?? []), ...origins];
  if (allowedOrigins.includes(url.origin)) {
    if (url.protocol === "https:") return true;
    if ((allowLoopbackHttpFixtures || allowConfiguredLoopbackHttp) && url.protocol === "http:") {
      return isLoopbackHost(host);
    }
  }
  if ((allowLoopbackHttpFixtures || allowConfiguredLoopbackHttp) && url.protocol === "http:" && exactHosts.includes(host)) {
    return isLoopbackHost(host);
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) return false;
  return exactHosts.includes(host) || suffixes.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

export function rendererCorsHeaders(
  responseHeaders: Record<string, string[]> | undefined,
  origin: string,
  method: string,
): Record<string, string[]> | null {
  if (!CORS_COMPATIBILITY_METHODS.includes(method.toUpperCase() as any)) return null;

  const headers = { ...(responseHeaders ?? {}) };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith("access-control-allow-") || key.toLowerCase() === "access-control-expose-headers") {
      delete headers[key];
    }
  }
  headers["access-control-allow-origin"] = [origin];
  headers["access-control-allow-methods"] = [CORS_COMPATIBILITY_METHODS.join(", ")];
  headers["access-control-allow-headers"] = [CORS_COMPATIBILITY_HEADERS.join(", ")];
  headers["access-control-expose-headers"] = [
    "Accept-Ranges, Content-Length, Content-Range, Content-Type, Date, X-Request-Id",
  ];

  const varyKey = Object.keys(headers).find((key) => key.toLowerCase() === "vary") ?? "vary";
  const varyValues = (headers[varyKey] ?? []).flatMap((value) => value.split(","));
  if (!varyValues.some((value) => value.trim().toLowerCase() === "origin")) {
    varyValues.push("Origin");
  }
  headers[varyKey] = [varyValues.map((value) => value.trim()).filter(Boolean).join(", ")];
  return headers;
}

export interface RendererSecurityOptions extends RendererDocumentPolicy {
  windows: RendererWindows;
  corsHosts?: { exact?: readonly string[]; suffixes?: readonly string[]; origins?: readonly string[] };
  corsOrigins?: readonly string[];
  /** Loopback-only opt-in for isolated native fixtures; production leaves this unset. */
  allowLoopbackHttpFixtures?: boolean;
  /** Allows only exact configured HTTP loopback origins during development. */
  allowConfiguredLoopbackHttp?: boolean;
}

function corsUrlFilter(
  hosts?: RendererSecurityOptions["corsHosts"],
  origins: readonly string[] = [],
  devServerUrl?: string | null,
): string[] {
  const exactHosts = hosts?.exact ?? [...EXACT_CORS_HOSTS];
  const suffixes = hosts?.suffixes ?? CORS_HOST_SUFFIXES;
  return [
    ...exactHosts.map((host) => `https://${host}/*`),
    ...suffixes.flatMap((suffix) => [`https://${suffix}/*`, `https://*.${suffix}/*`]),
    ...(hosts?.origins ?? []).map((origin) => `${origin}/*`),
    ...origins.map((origin) => `${origin}/*`),
    ...(hosts?.exact ?? []).flatMap((host) => isLoopbackHost(host)
      ? [`http://${host}/*`]
      : []),
    "file://*/*",
    ...(devServerUrl && devOrigin(devServerUrl) ? [`${devOrigin(devServerUrl)}/*`] : []),
  ];
}

export class RendererSecurity {
  private readonly loadedFileDocuments = new WeakMap<WebContents, string>();

  constructor(private readonly options: RendererSecurityOptions) {}

  public isTrustedDocument(url: string): boolean {
    const policy = {
      builtInIndexPath: this.options.builtInIndexPath,
      activeBundleIndexPath: this.options.activeBundleIndexPath,
      devServerUrl: this.options.devServerUrl,
    };
    return isTrustedRendererDocument(url, policy);
  }

  public isTrustedIpcSender(event: IpcSecurityEvent, role: RendererRole): boolean {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame) return false;
    const expectedWindows = role === "main"
      ? [this.options.windows.main()]
      : role === "overlay"
        ? [this.options.windows.overlay()]
        : [this.options.windows.main(), this.options.windows.overlay()];
    return expectedWindows.some((expected) => expected === event.sender) &&
      this.isTrustedDocumentForWebContents(event.sender, frame.url);
  }

  /** Records an exact trusted file document loaded through an app-controlled navigation. */
  public authorizeLoadedDocument(webContents: WebContents, url: string): void {
    if (!this.isExpectedWebContents(webContents) || !this.isTrustedDocument(url)) return;
    const filePath = rendererFilePath(url);
    if (filePath) this.loadedFileDocuments.set(webContents, filePath);
  }

  private isTrustedDocumentForWebContents(webContents: WebContents, url: string): boolean {
    if (this.isTrustedDocument(url)) return true;
    const filePath = rendererFilePath(url);
    return Boolean(filePath && this.loadedFileDocuments.get(webContents) === filePath);
  }

  public trustedOriginForRequest(
    webContents: WebContents | undefined,
    frame: WebFrameMain | null | undefined,
  ): string | null {
    if (!webContents || !frame || frame !== webContents.mainFrame) return null;
    const isExpectedWindow = this.isExpectedWebContents(webContents);
    if (!isExpectedWindow || !this.isTrustedDocumentForWebContents(webContents, frame.url)) return null;
    return trustedRendererOrigin(frame.url);
  }

  private isExpectedWebContents(webContents: WebContents): boolean {
    return webContents === this.options.windows.main() || webContents === this.options.windows.overlay();
  }

  public installNavigationGuards(
    webContents: WebContents,
    openExternal: (url: string) => Promise<unknown> | unknown,
  ): void {
    webContents.on("did-navigate", (_event, url) => {
      if (!this.isExpectedWebContents(webContents)) return;
      if (!this.isTrustedDocumentForWebContents(webContents, url)) {
        this.loadedFileDocuments.delete(webContents);
        return;
      }
      const filePath = rendererFilePath(url);
      if (filePath) this.loadedFileDocuments.set(webContents, filePath);
      else this.loadedFileDocuments.delete(webContents);
    });
    webContents.on("will-frame-navigate", (details) => {
      if (!details.isMainFrame || !this.isTrustedDocumentForWebContents(webContents, details.url)) details.preventDefault();
    });
    webContents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame || !this.isTrustedDocumentForWebContents(webContents, url)) event.preventDefault();
    });
    webContents.on("will-navigate", (event, url) => {
      if (!this.isTrustedDocumentForWebContents(webContents, url)) event.preventDefault();
    });
    webContents.setWindowOpenHandler(({ url }) => {
      const parsed = getUrl(url);
      if (parsed && (parsed.protocol === "https:" || parsed.protocol === "http:")) {
        void Promise.resolve(openExternal(parsed.href)).catch(() => {});
      }
      return { action: "deny" };
    });
  }

  public installCrossOriginCompatibility(electronSession: Session): void {
    electronSession.webRequest.onHeadersReceived(
      { urls: corsUrlFilter(this.options.corsHosts, this.options.corsOrigins, this.options.devServerUrl) },
      (details, callback) => {
        const origin = this.trustedOriginForRequest(details.webContents, details.frame);
        const baseResponseHeaders = { ...(details.responseHeaders ?? {}) };
        if (
          details.resourceType === "mainFrame" && details.webContents &&
          this.isExpectedWebContents(details.webContents) && this.isTrustedDocument(details.url)
        ) {
          const cspKey = Object.keys(baseResponseHeaders).find((key) => key.toLowerCase() === "content-security-policy")
            ?? "content-security-policy";
          baseResponseHeaders[cspKey] = [
            ...(baseResponseHeaders[cspKey] ?? []),
            "frame-src 'none'; object-src 'none'",
          ];
        }
        const corsHeaders = origin && isAllowedCorsDestination(
          details.url,
          this.options.corsHosts,
          this.options.allowLoopbackHttpFixtures || this.options.allowConfiguredLoopbackHttp,
          this.options.corsOrigins,
        )
          ? rendererCorsHeaders(baseResponseHeaders, origin, details.method)
          : null;
        callback({ responseHeaders: corsHeaders ?? baseResponseHeaders });
      },
    );
  }
}
