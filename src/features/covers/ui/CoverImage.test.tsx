// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import CoverImage from "./CoverImage";
import { clearCoverRegistry } from "../lib/coverArt";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class ControlledImage {
  static instances: ControlledImage[] = [];
  crossOrigin: string | null = null;
  decoding = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";
  constructor() { ControlledImage.instances.push(this); }
}

describe("CoverImage async source changes", () => {
  const originalImage = window.Image;
  const originalBridge = Object.getOwnPropertyDescriptor(window, "linerElectron");
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    clearCoverRegistry();
    ControlledImage.instances = [];
    Object.defineProperty(window, "Image", { configurable: true, writable: true, value: originalImage });
    if (originalBridge) Object.defineProperty(window, "linerElectron", originalBridge);
    else delete (window as any).linerElectron;
  });

  it("does not apply an old cover fallback after the component switches sources", async () => {
    Object.defineProperty(window, "Image", { configurable: true, writable: true, value: ControlledImage });
    let resolveSignature!: (signature: string) => void;
    Object.defineProperty(window, "linerElectron", {
      configurable: true,
      value: { signCoverUrl: () => new Promise<string>((resolve) => { resolveSignature = resolve; }) },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const oldSrc = "https://i1.sndcdn.com/artworks/old-cover.jpg";
    const currentSrc = "https://example.com/current-cover.jpg";

    await act(async () => { root!.render(<CoverImage src={oldSrc} crossOrigin="" />); });
    const oldDomImage = container.querySelector("img")!;
    await act(async () => { oldDomImage.dispatchEvent(new Event("error")); });
    await act(async () => { root!.render(<CoverImage src={currentSrc} crossOrigin="" />); });

    resolveSignature("signed");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(currentSrc);
  });
});
