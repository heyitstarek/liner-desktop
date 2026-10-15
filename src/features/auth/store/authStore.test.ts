// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: null as any,
  clearAuthSession: vi.fn(),
  api: {
    getMe: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    updateProfile: vi.fn(),
  },
  dispatch: vi.fn(),
}));

vi.mock("@/shared/api", () => ({
  api: mocks.api,
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(message: string, status = 500, code = "") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getAuthSession: () => mocks.session,
  getAuthSessionIdentity: () => mocks.session?.accessToken
    ? mocks.session.user?.id ? `user:${mocks.session.user.id}` : `token:${mocks.session.accessToken}`
    : "anonymous",
  setAuthSession: (session: unknown) => {
    mocks.session = session;
  },
  clearAuthSession: mocks.clearAuthSession,
  refreshAuthSession: vi.fn(),
}));

vi.mock("@/features/player", () => ({
  usePlayerStore: { getState: () => ({ dispatch: mocks.dispatch, setFullscreen: vi.fn() }) },
  playerRuntime: null,
}));

import { useAuthStore } from "./authStore";

describe("auth session lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.session = {
      accessToken: "access-a",
      refreshToken: "refresh-a",
      user: { id: "account-a", email: "a@example.com" },
    };
    mocks.clearAuthSession.mockImplementation(async () => {
      mocks.session = null;
    });
    useAuthStore.setState({ status: "initializing", user: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not restore the signed-out account when its bootstrap request finishes late", async () => {
    let resolveProfile!: (value: { id: string; email: string }) => void;
    mocks.api.getMe.mockReturnValue(
      new Promise((resolve) => {
        resolveProfile = resolve;
      }),
    );

    const bootstrap = useAuthStore.getState().initialize();
    await Promise.resolve();

    await useAuthStore.getState().logout();
    expect(useAuthStore.getState()).toMatchObject({ status: "anonymous", user: null });
    expect(mocks.session).toBeNull();

    resolveProfile({ id: "account-a", email: "a@example.com" });
    await bootstrap;

    expect(useAuthStore.getState()).toMatchObject({ status: "anonymous", user: null });
    expect(mocks.session).toBeNull();
  });

  it("does not apply a profile response from a session that logged out while it was pending", async () => {
    let resolveUpdate!: (value: { displayName: string }) => void;
    mocks.api.updateProfile.mockReturnValue(new Promise((resolve) => { resolveUpdate = resolve; }));
    useAuthStore.setState({ status: "authenticated", user: { id: "account-a", email: "a@example.com" } as any });

    const update = useAuthStore.getState().updateProfile({ displayName: "New name" } as any);
    await useAuthStore.getState().logout();
    resolveUpdate({ displayName: "New name" });
    await update;

    expect(useAuthStore.getState()).toMatchObject({ status: "anonymous", user: null });
    expect(mocks.session).toBeNull();
  });

  it("shows the local signed-out state before remote logout finishes and keeps it on network failure", async () => {
    useAuthStore.setState({ status: "authenticated", user: { id: "account-a", email: "a@example.com" } as any });
    let rejectRemote!: (reason?: unknown) => void;
    mocks.clearAuthSession.mockImplementation(() => {
      mocks.session = null;
      return new Promise((_, reject) => { rejectRemote = reject; });
    });

    const logout = useAuthStore.getState().logout();
    expect(useAuthStore.getState()).toMatchObject({ status: "anonymous", user: null });
    rejectRemote(new Error("offline"));
    await expect(logout).resolves.toBeUndefined();
    expect(useAuthStore.getState()).toMatchObject({ status: "anonymous", user: null });
  });

  it("does not let an older logout completion clear a newer login", async () => {
    let finishRemote!: () => void;
    mocks.clearAuthSession.mockImplementation(() => {
      mocks.session = null;
      return new Promise<void>((resolve) => { finishRemote = resolve; });
    });
    mocks.api.login.mockImplementation(async () => {
      mocks.session = {
        accessToken: "access-b",
        refreshToken: "refresh-b",
        user: { id: "account-b", email: "b@example.com" },
      };
      return { user: { id: "account-b", email: "b@example.com" } };
    });

    const logout = useAuthStore.getState().logout();
    const login = useAuthStore.getState().login("b@example.com", "password");
    await login;
    finishRemote();
    await logout;

    expect(useAuthStore.getState()).toMatchObject({ status: "authenticated", user: { id: "account-b" } });
    expect(mocks.session?.user.id).toBe("account-b");
  });
});
