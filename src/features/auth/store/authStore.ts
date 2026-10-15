import { create } from "zustand";
import { api, ApiError } from "@/shared/api";
import {
  clearAuthSession,
  getAuthSession,
  getAuthSessionIdentity,
  setAuthSession,
  refreshAuthSession,
  type AuthUser,
  type PublicUser,
  type UpdateProfileInput,
} from "@/shared/api";
import { usePlayerStore, playerRuntime } from "@/features/player";

export type AuthStatus = "initializing" | "authenticated" | "anonymous";
export type AuthState = {
  status: AuthStatus;
  user: AuthUser | null;
  initialize: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (
    email: string,
    password: string,
    username: string,
    displayName: string,
  ) => Promise<void>;
  updateProfile: (patch: UpdateProfileInput) => Promise<PublicUser>;
  logout: () => Promise<void>;
};

let authOperationGeneration = 0;

function isCurrentSessionOperation(
  generation: number,
  identity: string,
): boolean {
  return (
    generation === authOperationGeneration &&
    getAuthSessionIdentity() === identity
  );
}

export const useAuthStore = create<AuthState>((set) => ({
  status: "initializing",
  user: null,
  initialize: async () => {
    const generation = ++authOperationGeneration;
    const stored = getAuthSession();
    if (!stored) {
      if (generation === authOperationGeneration) {
        set({ status: "anonymous", user: null });
      }
      return;
    }
    const identity = getAuthSessionIdentity();
    // Optimistically authenticate if stored user is present
    if (stored.user && isCurrentSessionOperation(generation, identity)) {
      set({ status: "authenticated", user: stored.user });
    }
    try {
      const getMePromise = api.getMe();
      const timeoutPromise = new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Auth initialize timeout")), 6000),
      );
      const user = await Promise.race([getMePromise, timeoutPromise]);
      if (!isCurrentSessionOperation(generation, identity)) return;
      const current = getAuthSession();
      if (current) setAuthSession({ ...current, user: user ?? current.user });
      set({ status: "authenticated", user: user ?? current?.user ?? stored.user });
    } catch (err) {
      if (!isCurrentSessionOperation(generation, identity)) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        // Attempt refresh before clearing session in case access token expired between sessions
        const current = getAuthSession();
        if (current?.refreshToken) {
          try {
            const refreshed = await refreshAuthSession();
            if (!isCurrentSessionOperation(generation, identity)) return;
            if (refreshed) {
              const retryUser = await api.getMe().catch(() => null);
              if (!isCurrentSessionOperation(generation, identity)) return;
              const active = getAuthSession();
              if (active) setAuthSession({ ...active, user: retryUser ?? active.user });
              set({
                status: "authenticated",
                user: retryUser ?? refreshed.user ?? current.user ?? stored.user,
              });
              return;
            }
          } catch {
            // refresh failed
          }
        }
        setAuthSession(null);
        set({ status: "anonymous", user: null });
      } else {
        // If it's a network error, timeout, or transient 5xx, preserve authenticated state if we have a stored session
        if (stored.user || stored.accessToken) {
          set({ status: "authenticated", user: stored.user });
        } else {
          setAuthSession(null);
          set({ status: "anonymous", user: null });
        }
      }
    }
  },
  login: async (email, password) => {
    const generation = ++authOperationGeneration;
    const result = await api.login(email, password);
    if (generation !== authOperationGeneration) return;
    set({ status: "authenticated", user: result.user });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("library:changed"));
    }
  },
  register: async (email, password, username, displayName) => {
    const generation = ++authOperationGeneration;
    const result = await api.register(email, password, username, displayName);
    if (generation !== authOperationGeneration) return;
    set({ status: "authenticated", user: result.user });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("library:changed"));
    }
  },
  updateProfile: async (patch) => {
    const generation = authOperationGeneration;
    const before = getAuthSession();
    const identity = getAuthSessionIdentity();
    const updated = await api.updateProfile(patch);
    if (!before || !isCurrentSessionOperation(generation, identity)) {
      return updated;
    }
    const current = getAuthSession();
    if (current) {
      setAuthSession({ ...current, user: { ...current.user, ...updated } });
    }
    set((prev) => ({
      user: prev.user ? { ...prev.user, ...updated } : updated,
    }));
    return updated;
  },
  logout: async () => {
    const generation = ++authOperationGeneration;
    set({ status: "anonymous", user: null });
    const clearSession = clearAuthSession().catch(() => undefined);
    try {
      usePlayerStore.getState().dispatch({ type: "PAUSE_REQUESTED" });
      playerRuntime?.pause();
    } catch {}
    try {
      usePlayerStore.getState().setFullscreen(false);
    } catch {}
    try {
      window.linerElectron?.closeOverlay?.();
      window.linerElectron?.sendOverlayAction?.({ type: "closeOverlay" });
    } catch {}
    if (typeof window !== "undefined" && window.location.hash.includes("/player")) {
      window.location.hash = "#/";
    }
    await clearSession;
    if (generation === authOperationGeneration && typeof window !== "undefined") {
      window.dispatchEvent(new Event("library:changed"));
    }
  },
}));

export function getAuthErrorCode(error: unknown): string {
  if (!(error instanceof ApiError)) return "server_unavailable";
  if (error.code === "INVALID_CREDENTIALS") return "invalid_credentials";
  if (error.code === "EMAIL_ALREADY_USED") return "email_already_used";
  if (error.code === "USERNAME_TAKEN") return "username_taken";
  if (error.code === "INVALID_USERNAME") return "invalid_username";
  if (error.code === "INVALID_INPUT") return "invalid_input";
  return "unknown_error";
}

export function authErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Unable to reach the server.";
  if (error.code === "INVALID_CREDENTIALS")
    return "Email or password is incorrect.";
  if (error.code === "EMAIL_ALREADY_USED")
    return "This email is already in use.";
  if (error.code === "USERNAME_TAKEN")
    return "This username is already taken. Please choose another.";
  if (error.code === "INVALID_USERNAME")
    return "Username must be 3-30 lowercase characters (a-z, 0-9, _).";
  // unknown api errors stay generic, never surface raw bodies
  return "Something went wrong. Please try again.";
}
