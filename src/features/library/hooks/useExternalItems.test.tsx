// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExternalItems } from "./useExternalItems";

const mocks = vi.hoisted(() => ({
  sessionIdentity: "user:a",
  listSavedCollections: vi.fn(),
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/shared/api", () => ({
  api: { listSavedCollections: mocks.listSavedCollections },
  getAuthSessionIdentity: () => mocks.sessionIdentity,
  mediaUrl: (url: string) => url,
  toMaxQualityAvatarUrl: (url: string) => url,
}));

describe("useExternalItems identity and request lifetime", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    mocks.sessionIdentity = "user:a";
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps the new account collection when the previous account request resolves late", async () => {
    let resolveA!: (value: any) => void;
    let resolveB!: (value: any) => void;
    mocks.listSavedCollections
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));

    let result!: ReturnType<typeof useExternalItems>;
    function TestComponent() { result = useExternalItems("playlist"); return null; }
    await act(async () => { root.render(<TestComponent />); });

    mocks.sessionIdentity = "user:b";
    await act(async () => { window.dispatchEvent(new Event("auth:changed")); });
    expect(result.data).toEqual([]);
    resolveB({ items: [{ playlist: { id: "b-list", title: "B private list" }, savedAt: "now" }] });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.data.map((item) => item.id)).toEqual(["b-list"]);

    resolveA({ items: [{ playlist: { id: "a-list", title: "A private list" }, savedAt: "now" }] });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.data.map((item) => item.id)).toEqual(["b-list"]);
  });
});
