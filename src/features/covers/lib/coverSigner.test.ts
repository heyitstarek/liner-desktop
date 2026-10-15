// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { prepareCoverFallback } from "./coverSigner";

describe("cover proxy URL encoding", () => {
  it("encodes Unicode URL components as UTF-8 after URL normalization", async () => {
    const rawUrl = "https://i1.sndcdn.com/artworks/café.jpg?title=雪";
    const fallback = await prepareCoverFallback(rawUrl);

    expect(fallback).toMatch(/^https:\/\/covers\.tryliner\.fun\/c\/[A-Za-z0-9_-]+\?size=1024$/);
    const token = fallback!.split("/c/")[1].split("?")[0];
    const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))));
    expect(payload).toEqual({
      u: "https://i1.sndcdn.com/artworks/caf%C3%A9.jpg?title=%E9%9B%AA",
      s: 1024,
    });
  });
});
