// Remote API traffic must stay on HTTPS, including after connectivity failures.
export const DEFAULT_PRIMARY_API = "https://api.tryliner.fun";

const STORAGE_KEY = "liner_active_api_base";
const HEALTH_TIMEOUT_MS = 6000;

function normalizeApiBaseUrl(url: string): string {
  const parsed = new URL(url);
  const isLocalDevelopment =
    import.meta.env.DEV &&
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);

  if (
    (parsed.protocol !== "https:" && !isLocalDevelopment) ||
    parsed.username || parsed.password || parsed.search || parsed.hash
  ) {
    throw new Error("API URL must use HTTPS (HTTP loopback is allowed in development only) and contain no credentials, query, or fragment.");
  }

  return parsed.href.replace(/\/+$/, "");
}

function loadStoredBaseUrl(): string {
  const envUrl = import.meta.env.VITE_API_URL as string | undefined;
  return envUrl ? normalizeApiBaseUrl(envUrl) : DEFAULT_PRIMARY_API;
}

function persistBaseUrl(url: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, url);
  } catch {}
}

let currentBaseUrl = loadStoredBaseUrl();
let probePromise: Promise<string> | null = null;

export function getApiBaseUrl(): string {
  return currentBaseUrl;
}

export function setApiBaseUrl(url: string): void {
  currentBaseUrl = normalizeApiBaseUrl(url);
  persistBaseUrl(currentBaseUrl);
}

export function switchToPrimaryApi(): void {
  currentBaseUrl = DEFAULT_PRIMARY_API;
  persistBaseUrl(DEFAULT_PRIMARY_API);
}

// Probe connectivity without downgrading transport when the primary is unreachable.
export function initApiEndpointProbe(timeoutMs = HEALTH_TIMEOUT_MS): Promise<string> {
  if (probePromise) return probePromise;
  if (currentBaseUrl !== DEFAULT_PRIMARY_API) {
    return Promise.resolve(currentBaseUrl);
  }

  probePromise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch(`${DEFAULT_PRIMARY_API}/health`, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      // Keep the configured secure endpoint on network errors and timeouts.
    } finally {
      clearTimeout(timer);
    }

    persistBaseUrl(currentBaseUrl);
    return currentBaseUrl;
  })();

  return probePromise;
}

// reset probe promise (useful for tests and manual retry)
export function resetEndpointProbe(): void {
  probePromise = null;
}

// trigger health probe eagerly on startup in production/dev runtime
if (typeof window !== "undefined" && !import.meta.env.TEST) {
  initApiEndpointProbe().catch(() => {});
}
