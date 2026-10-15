// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCoverRegistry, isCoverReady, preloadCoverArt } from "./coverArt";

class ControlledImage {
  static instances: ControlledImage[] = [];
  crossOrigin: string | null = null;
  decoding = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private source = "";
  constructor() { ControlledImage.instances.push(this); }
  get src() { return this.source; }
  set src(value: string) { this.source = value; }
}

describe("cover loading registry generations", () => {
  const originalImage = window.Image;
  const originalBridge = Object.getOwnPropertyDescriptor(window, "linerElectron");

  afterEach(() => {
    clearCoverRegistry();
    ControlledImage.instances = [];
    Object.defineProperty(window, "Image", { configurable: true, writable: true, value: originalImage });
    if (originalBridge) Object.defineProperty(window, "linerElectron", originalBridge);
    else delete (window as any).linerElectron;
    vi.restoreAllMocks();
  });

  it("ignores a cover load and fallback that belong to a registry entry cleared in flight", async () => {
    Object.defineProperty(window, "Image", { configurable: true, writable: true, value: ControlledImage });
    let resolveSignature!: (signature: string) => void;
    Object.defineProperty(window, "linerElectron", {
      configurable: true,
      value: { signCoverUrl: vi.fn(() => new Promise<string>((resolve) => { resolveSignature = resolve; })) },
    });
    const url = "https://i1.sndcdn.com/artworks/registry-generation.jpg";

    void preloadCoverArt(url);
    const oldImage = ControlledImage.instances[0];
    oldImage.onerror?.();
    clearCoverRegistry();
    void preloadCoverArt(url);
    const currentImage = ControlledImage.instances[1];

    resolveSignature("signed");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(oldImage.src).toBe(url);
    oldImage.onload?.();
    expect(isCoverReady(url)).toBe(false);

    currentImage.onload?.();
    expect(isCoverReady(url)).toBe(true);
  });
});
