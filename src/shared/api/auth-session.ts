import type { AuthTokens, AuthUser } from "../contracts";
import { signApiRequest, syncServerTime } from "./requestSigner";

export type { AuthTokens, AuthUser };

import { getApiBaseUrl } from "./baseUrl";
 
const STORAGE_KEY = "liner_auth_session";

let session: AuthTokens | null = null;
let sessionInitialized = false;
let sessionGeneration = 0;
let sessionBoundaryGeneration = 0;
let refreshPromise: { generation: number; requestId: object; promise: Promise<AuthTokens | null> } | null = null;
const AUTH_REQUEST_TIMEOUT_MS = 15_000;

function load(): AuthTokens | null {
  if (typeof window === "undefined") return null;
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = value ? JSON.parse(value) : null;
    return isAuthTokens(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isAuthTokens(value: unknown): value is AuthTokens {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AuthTokens>;
  return typeof candidate.accessToken === "string" && candidate.accessToken.length > 0
    && typeof candidate.refreshToken === "string" && candidate.refreshToken.length > 0
    && typeof candidate.accessTokenExpiresAt === "string"
    && !!candidate.user && typeof candidate.user.id === "string";
}

type NativeAuthStorage = Pick<NonNullable<Window["linerElectron"]>, "loadAuthSession" | "saveAuthSession" | "clearAuthSession">;
let nativeAuthStorage: NativeAuthStorage | null = null;
let initializationPromise: Promise<void> | null = null;
let nativePersistenceQueue: Promise<void> = Promise.resolve();

function removeLegacySession(): void {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* In-memory auth remains authoritative. */ }
}

function queueNativePersistence(next: AuthTokens | null): Promise<boolean> {
  const bridge = nativeAuthStorage;
  if (!bridge) return Promise.resolve(false);
  const operation = nativePersistenceQueue.catch(() => undefined).then(async () => {
    try {
      if (next) return await bridge.saveAuthSession(next);
      return await bridge.clearAuthSession();
    } catch {
      // Persistence is best-effort; never surface token bytes through errors or logs.
      return false;
    }
  });
  nativePersistenceQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/** Hydrates protected Electron storage before the app renders; browser storage stays unchanged. */
export function initializeAuthSession(): Promise<void> {
  if (initializationPromise) return initializationPromise;
  // Preserve the legacy value in memory while the asynchronous native read is pending.
  getAuthSession();
  const bridge = typeof window !== "undefined" ? window.linerElectron : undefined;
  if (!bridge?.loadAuthSession || !bridge.saveAuthSession || !bridge.clearAuthSession) {
    sessionInitialized = true;
    initializationPromise = Promise.resolve();
    return initializationPromise;
  }

  nativeAuthStorage = bridge;
  const generationAtStart = sessionGeneration;
  const legacy = load();
  initializationPromise = (async () => {
    let protectedSession: unknown = null;
    try { protectedSession = await bridge.loadAuthSession(); } catch { /* Continue with memory-only migration. */ }
    if (sessionGeneration !== generationAtStart) return;

    const chosen = isAuthTokens(protectedSession) ? protectedSession : legacy;
    if (chosen && !isAuthTokens(protectedSession)) {
      await queueNativePersistence(chosen);
    }
    // Once a native in-memory session is selected, never retain tokens in renderer storage.
    removeLegacySession();
    if (sessionGeneration !== generationAtStart) return;

    session = chosen;
    sessionInitialized = true;
    sessionGeneration++;
    sessionBoundaryGeneration++;
    emit();
  })().catch(() => {
    // A native storage failure must not block application startup or expose its error.
    if (sessionGeneration === generationAtStart) {
      removeLegacySession();
      sessionInitialized = true;
    }
  });
  return initializationPromise;
}

function emit() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("auth:changed"));
  }
}

export function getAuthSession(): AuthTokens | null {
  if (!sessionInitialized) {
    session = load();
    sessionInitialized = true;
  }
  return session;
}

/** Changes whenever the locally active auth session is replaced or cleared. */
export function getAuthSessionGeneration(): number {
  return sessionGeneration;
}

/** Changes on login, logout, or account replacement, but not on token refresh. */
export function getAuthSessionBoundaryGeneration(): number {
  return sessionBoundaryGeneration;
}

/** Stable, non-secret account namespace used for caller-side request isolation. */
export function getAuthSessionIdentity(): string {
  const current = getAuthSession();
  if (!current?.accessToken) return "anonymous";
  return current.user?.id ? `user:${current.user.id}` : `session:${sessionBoundaryGeneration}`;
}

function updateAuthSession(next: AuthTokens | null, preserveIdentity: boolean): void {
  sessionGeneration++;
  if (!preserveIdentity) {
    sessionBoundaryGeneration++;
  }
  session = next;
  sessionInitialized = true;
  if (typeof window !== "undefined") {
    if (nativeAuthStorage) {
      removeLegacySession();
      queueNativePersistence(next);
    } else {
      try {
        if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        else localStorage.removeItem(STORAGE_KEY);
      } catch {
        // In-memory auth state remains authoritative when browser storage is unavailable.
      }
    }
  }
  emit();
}

export function setAuthSession(next: AuthTokens | null): void {
  updateAuthSession(next, false);
}

export function getAccessToken(): string | null {
  return getAuthSession()?.accessToken ?? null;
}

/**
 * Returns the timestamp in milliseconds when the access token expires,
 * or null if unknown.
 */
export function getSessionExpiryMs(s: AuthTokens | null): number | null {
  if (!s) return null;
  if (s.accessTokenExpiresAt) {
    const t =
      typeof s.accessTokenExpiresAt === "number"
        ? s.accessTokenExpiresAt
        : new Date(s.accessTokenExpiresAt).getTime();
    if (!isNaN(t) && t > 0) {
      // If t is in seconds (e.g. 10-digit unix timestamp), convert to ms
      return t < 10_000_000_000 ? t * 1000 : t;
    }
  }
  if (s.expiresAt) {
    const t =
      typeof s.expiresAt === "number"
        ? s.expiresAt < 10_000_000_000
          ? s.expiresAt * 1000
          : s.expiresAt
        : new Date(s.expiresAt).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  return null;
}

/**
 * Returns a valid access token. If a refresh is already in progress, awaits it.
 * If the current access token is about to expire (< 120s) or already expired,
 * proactively triggers a single atomic session refresh and returns the fresh access token.
 */
export async function getValidAccessToken(): Promise<string | null> {
  // If a refresh is ALREADY in flight, await it to prevent concurrent requests from using stale tokens
  const generation = getAuthSessionGeneration();
  const boundaryGeneration = getAuthSessionBoundaryGeneration();
  if (refreshPromise?.generation === generation) {
    const refreshed = await refreshPromise.promise;
    if (getAuthSessionBoundaryGeneration() !== boundaryGeneration) return null;
    if (refreshed?.accessToken) return refreshed.accessToken;
    if (getAuthSessionGeneration() !== generation) return null;
    return getAuthSession()?.accessToken ?? null;
  }

  const current = getAuthSession();
  if (!current?.accessToken) return null;

  const expiresAtMs = getSessionExpiryMs(current);
  // If token expiry is known and expires in less than 2 minutes (120s), proactively refresh
  if (expiresAtMs !== null && expiresAtMs - Date.now() < 120_000) {
    const refreshed = await refreshAuthSession();
    if (getAuthSessionBoundaryGeneration() !== boundaryGeneration) return null;
    if (refreshed?.accessToken) return refreshed.accessToken;
    if (getAuthSessionGeneration() !== generation) return null;
    // If refresh failed (e.g. transient network glitch), but token is still within validity window,
    // fallback to current token rather than failing immediately
    if (expiresAtMs > Date.now()) return current.accessToken;
    return null;
  }

  return current.accessToken;
}

/**
 * Performs a mutex-locked atomic refresh of the auth session.
 * Guaranteed to only initiate one in-flight refresh request across all parallel callers.
 */
export function refreshAuthSession(): Promise<AuthTokens | null> {
  const generation = getAuthSessionGeneration();
  if (refreshPromise?.generation === generation) return refreshPromise.promise;

  const current = getAuthSession();
  if (!current?.refreshToken) {
    return Promise.resolve(null);
  }

  // Synchronously assign the promise to immediately lock out any concurrent callers
  const requestId = {};
  const promise = (async () => {
    try {
      const body = JSON.stringify({ refreshToken: current.refreshToken });
      const signedHeaders = await signApiRequest("POST", "/v1/auth/refresh", body);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(`${getApiBaseUrl()}/v1/auth/refresh`, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            ...signedHeaders,
          },
          body,
        });
      } finally {
        clearTimeout(timeout);
      }

      const dateHeader = response.headers?.get?.("date");
      if (dateHeader) {
        syncServerTime(dateHeader);
      }

      if (!response.ok) {
        // If the server explicitly rejected the refresh token (401 / 403),
        // only clear the stored session if it hasn't already been rotated by another process
        if (response.status === 401 || response.status === 403) {
          const latest = getAuthSession();
          if (getAuthSessionGeneration() === generation && latest?.refreshToken === current.refreshToken) {
            setAuthSession(null);
          }
        }
        return null;
      }

      const next = (await response.json()) as AuthTokens;
      const latest = getAuthSession();
      if (getAuthSessionGeneration() !== generation || latest?.refreshToken !== current.refreshToken) {
        return null;
      }
      // Preserve existing user info and metadata
      const merged: AuthTokens = {
        ...current,
        ...next,
        user: next.user || current.user,
      };

      updateAuthSession(merged, true);
      return merged;
    } catch (err) {
      console.error("[Auth] refreshAuthSession request failed:", err);
      return null;
    } finally {
      if (refreshPromise?.requestId === requestId) refreshPromise = null;
    }
  })();

  refreshPromise = { generation, requestId, promise };
  return promise;
}

export async function clearAuthSession(): Promise<void> {
  const current = getAuthSession();
  setAuthSession(null);
  if (!current?.refreshToken) return;
  const body = JSON.stringify({ refreshToken: current.refreshToken });
  const signedHeaders = await signApiRequest("POST", "/v1/auth/logout", body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);
  const response = await fetch(`${getApiBaseUrl()}/v1/auth/logout`, {
    method: "POST",
    redirect: "error",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${current.accessToken}`,
      ...signedHeaders,
    },
    body,
  }).catch(() => undefined).finally(() => clearTimeout(timeout));
  if (response?.headers) {
    const logoutDate = response.headers?.get?.("date");
    if (logoutDate) syncServerTime(logoutDate);
  }
}
