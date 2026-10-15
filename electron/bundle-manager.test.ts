import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import * as tar from "tar";
import { BundleManager, type BundleManifest } from "./bundle-manager";

let userDataPath = "";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => userDataPath),
    getVersion: vi.fn(() => "1.0.0"),
  },
  BrowserWindow: vi.fn(),
}));

const keyPair = crypto.generateKeyPairSync("ed25519");
const publicKeyHex = keyPair.publicKey.export({ type: "spki", format: "der" }).toString("hex");
const roots: string[] = [];

async function makeSignedBundle(options: { includeIndex?: boolean; link?: boolean; unsafePath?: string; dotPaths?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "liner-bundle-fixture-"));
  roots.push(root);
  const content = path.join(root, "content");
  fs.mkdirSync(path.join(content, "dist"), { recursive: true });
  if (options.includeIndex !== false) {
    fs.writeFileSync(path.join(content, "dist", "index.html"), "<!doctype html><title>signed</title>");
  }
  const archivePath = path.join(root, "bundle.tar.gz");
  if (options.link || options.unsafePath || options.dotPaths) {
    const entries = [
      ...(options.dotPaths ? [tarEntry("./", "", "5"), tarEntry("./dist/", "", "5")] : []),
      tarEntry(options.dotPaths ? "./dist/index.html" : "dist/index.html", "<!doctype html><title>signed</title>"),
      ...(options.link ? [tarEntry("dist/alias.html", "", "2", "index.html")] : []),
      ...(options.unsafePath ? [tarEntry(options.unsafePath, "escaped")] : []),
    ];
    fs.writeFileSync(archivePath, zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
  } else {
    await tar.create({ gzip: true, file: archivePath, cwd: content }, ["dist"]);
  }
  const bytes = fs.readFileSync(archivePath);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const signature = crypto.sign(null, Buffer.from(sha256, "utf8"), keyPair.privateKey).toString("hex");
  const manifest: BundleManifest = {
    bundleVersion: "1.2.3-beta.1",
    minAppVersion: "1.0.0",
    channel: "stable",
    downloadUrl: "https://updates.tryliner.fun/updates/bundle.tar.gz",
    sha256,
    size: bytes.byteLength,
    signature,
    releasedAt: "2026-10-15T00:00:00.000Z",
  };
  return { bytes, manifest, root };
}

function tarEntry(name: string, contents: string, type = "0", linkName = "") {
  const data = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(linkName, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const paddedSize = Math.ceil(data.length / 512) * 512;
  return Buffer.concat([header, data, Buffer.alloc(paddedSize - data.length)]);
}

function manager() {
  const defaultDist = path.join(userDataPath, "default-dist");
  fs.mkdirSync(defaultDist, { recursive: true });
  fs.writeFileSync(path.join(defaultDist, "index.html"), "built-in");
  return new BundleManager({ defaultRendererDist: defaultDist, publicKeyHex });
}

function response(bytes: Buffer, headers: Record<string, string> = {}) {
  return new Response(Uint8Array.from(bytes), { status: 200, headers: { "content-length": String(bytes.length), ...headers } });
}

beforeEach(() => {
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "liner-bundle-user-data-"));
  roots.push(userDataPath);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("BundleManager signed bundle reliability", () => {
  it("rejects hostile manifests before network or filesystem mutation and remains retryable", async () => {
    const { bytes, manifest: validManifest } = await makeSignedBundle();
    const instance = manager();
    const manifest = { ...validManifest, bundleVersion: "../../../../victim" };
    const outside = path.join(os.tmpdir(), `victim-${manifest.sha256.slice(0, 8)}`);
    expect(path.relative(path.join(userDataPath, "bundles"), outside).startsWith("..")).toBe(true);
    if (fs.existsSync(outside)) throw new Error("Refusing to overwrite an existing traversal target");
    roots.push(outside);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "sentinel.txt"), "keep");

    vi.mocked(fetch).mockResolvedValueOnce(response(bytes));
    await expect(instance.downloadAndInstall(manifest)).resolves.toMatchObject({ success: false });
    expect(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8")).toBe("keep");
    expect(fetch).not.toHaveBeenCalled();
    await expect(instance.downloadAndInstall(manifest)).resolves.toMatchObject({ success: false });
  });

  it("validates a fetched manifest before reading fields or starting its download", async () => {
    const instance = manager();
    const manifestResponse = new Response(JSON.stringify({ bundleVersion: "../escape" }), { status: 200 });
    vi.mocked(fetch).mockResolvedValueOnce(manifestResponse);

    await expect(instance.checkForUpdates()).resolves.toMatchObject({ available: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(manifestResponse.body?.locked).toBe(false);
  });

  it("installs a valid signed archive and activates it after restart", async () => {
    const { bytes, manifest } = await makeSignedBundle();
    vi.mocked(fetch).mockResolvedValueOnce(response(bytes));
    const first = manager();

    await expect(first.downloadAndInstall(manifest)).resolves.toEqual({ success: true });
    expect(fs.readFileSync(first.getEffectiveIndexPath(), "utf8")).toContain("signed");
    expect(fs.existsSync(path.join(first.getActiveState()!.bundleDir, "archive.tar.gz"))).toBe(false);

    const restarted = manager();
    expect(restarted.getActiveVersion()).toBe(manifest.bundleVersion);
    expect(fs.readFileSync(restarted.getEffectiveIndexPath(), "utf8")).toContain("signed");
  });

  it("accepts a valid archive with harmless leading dot segments", async () => {
    const { bytes, manifest } = await makeSignedBundle({ dotPaths: true });
    vi.mocked(fetch).mockResolvedValueOnce(response(bytes));
    const instance = manager();

    await expect(instance.downloadAndInstall(manifest)).resolves.toEqual({ success: true });
    expect(fs.readFileSync(instance.getEffectiveIndexPath(), "utf8")).toContain("signed");
  });

  it.each([
    ["hash mismatch", { sha256: "b".repeat(64) }],
    ["signature mismatch", { signature: "0".repeat(128) }],
  ])("keeps the previous active bundle after a replacement %s", async (_label, overrides) => {
    const fixture = await makeSignedBundle();
    vi.mocked(fetch).mockResolvedValueOnce(response(fixture.bytes));
    const instance = manager();
    await expect(instance.downloadAndInstall(fixture.manifest)).resolves.toEqual({ success: true });
    const priorDir = instance.getActiveState()?.bundleDir;
    const priorContents = fs.readFileSync(instance.getEffectiveIndexPath(), "utf8");

    const replacement = { ...fixture.manifest, ...overrides };
    vi.mocked(fetch).mockResolvedValueOnce(response(fixture.bytes));
    await expect(instance.downloadAndInstall(replacement)).resolves.toMatchObject({ success: false });
    expect(instance.getActiveState()?.bundleDir).toBe(priorDir);
    expect(fs.readFileSync(instance.getEffectiveIndexPath(), "utf8")).toBe(priorContents);
  });

  it.each([
    ["truncated response", async (bytes: Buffer) => response(bytes.subarray(0, bytes.length - 1), { "content-length": String(bytes.length) })],
    ["oversized response", async (bytes: Buffer) => response(Buffer.concat([bytes, Buffer.alloc(1)]), { "content-length": String(bytes.length) })],
  ])("rejects a %s and permits a subsequent retry", async (_label, makeResponse) => {
    const { bytes, manifest } = await makeSignedBundle();
    vi.mocked(fetch).mockResolvedValueOnce(await makeResponse(bytes));
    const instance = manager();
    await expect(instance.downloadAndInstall(manifest)).resolves.toMatchObject({ success: false });

    vi.mocked(fetch).mockResolvedValueOnce(response(bytes));
    await expect(instance.downloadAndInstall(manifest)).resolves.toEqual({ success: true });
  });

  it.each([
    ["missing index", { includeIndex: false }],
    ["symbolic link", { link: true }],
    ["traversal entry", { unsafePath: "../outside.txt" }],
  ])("rejects an archive with a %s without replacing the prior bundle", async (_label, options) => {
    const good = await makeSignedBundle();
    vi.mocked(fetch).mockResolvedValueOnce(response(good.bytes));
    const instance = manager();
    await instance.downloadAndInstall(good.manifest);
    const priorPath = instance.getEffectiveIndexPath();
    const priorState = instance.getActiveState();

    const bad = await makeSignedBundle(options);
    vi.mocked(fetch).mockResolvedValueOnce(response(bad.bytes));
    await expect(instance.downloadAndInstall({ ...bad.manifest, bundleVersion: good.manifest.bundleVersion })).resolves.toMatchObject({ success: false });
    expect(instance.getActiveState()).toEqual(priorState);
    expect(instance.getEffectiveIndexPath()).toBe(priorPath);
  });

  it("ignores tampered active state that points outside the bundles root", () => {
    const defaultDist = path.join(userDataPath, "default-dist");
    fs.mkdirSync(defaultDist, { recursive: true });
    fs.writeFileSync(path.join(defaultDist, "index.html"), "built-in");
    fs.writeFileSync(path.join(userDataPath, "active_bundle.json"), JSON.stringify({
      bundleVersion: "1.2.3",
      bundleDir: path.resolve(userDataPath, "..", "outside"),
      installedAt: new Date().toISOString(),
      sha256: "a".repeat(64),
      minAppVersion: "1.0.0",
    }));

    const instance = new BundleManager({ defaultRendererDist: defaultDist, publicKeyHex });
    expect(instance.getActiveState()).toBeNull();
    expect(instance.getEffectiveIndexPath()).toBe(path.join(defaultDist, "index.html"));
  });

  it("rejects credential-bearing download URLs and oversized declarations before fetching", async () => {
    const instance = manager();
    const base = {
      bundleVersion: "1.2.3",
      minAppVersion: "1.0.0",
      channel: "stable",
      downloadUrl: "https://updates.tryliner.fun/updates/bundle.tar.gz",
      sha256: "a".repeat(64),
      size: 128,
      signature: "b".repeat(128),
      releasedAt: "2026-10-15T00:00:00.000Z",
    } as BundleManifest;
    await expect(instance.downloadAndInstall({ ...base, downloadUrl: "https://user:pass@updates.tryliner.fun/bundle.tar.gz" })).resolves.toMatchObject({ success: false });
    await expect(instance.downloadAndInstall({ ...base, size: 50 * 1024 * 1024 + 1 })).resolves.toMatchObject({ success: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("times out a stalled download, cleans staging, and allows retry", async () => {
    vi.useFakeTimers();
    try {
      const { bytes, manifest } = await makeSignedBundle();
      const instance = manager();
      vi.mocked(fetch).mockImplementationOnce(async (_input, init) => {
        const signal = init?.signal as AbortSignal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
          },
        });
        return new Response(body, { status: 200, headers: { "content-length": String(bytes.length) } });
      });
      const pending = instance.downloadAndInstall(manifest);
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(pending).resolves.toMatchObject({ success: false });

      vi.mocked(fetch).mockResolvedValueOnce(response(bytes));
      await expect(instance.downloadAndInstall(manifest)).resolves.toEqual({ success: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails promptly on a disk write error while the download body is stalled", async () => {
    const fixture = await makeSignedBundle();
    vi.mocked(fetch).mockResolvedValueOnce(response(fixture.bytes));
    const instance = manager();
    await expect(instance.downloadAndInstall(fixture.manifest)).resolves.toEqual({ success: true });
    const previousState = instance.getActiveState();
    const previousHtml = fs.readFileSync(instance.getEffectiveIndexPath(), "utf8");

    vi.useFakeTimers();
    let stalledController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const createWriteStream = vi.spyOn(fs, "createWriteStream").mockImplementation(() => {
      const failingStream = new Writable({
        write(_chunk, _encoding, callback) {
          queueMicrotask(() => callback(new Error("disk full")));
        },
      });
      // Keep this regression test process-safe on the broken implementation,
      // which had no listener while waiting for the next download chunk.
      failingStream.on("error", () => undefined);
      return failingStream as unknown as fs.WriteStream;
    });
    vi.mocked(fetch).mockImplementationOnce(async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stalledController = controller;
          controller.enqueue(Uint8Array.from(fixture.bytes));
          signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-length": String(fixture.bytes.length) } });
    });

    try {
      const pending = instance.downloadAndInstall(fixture.manifest);
      const verdict = Promise.race([
        pending.then((result) => result.success ? "installed" : "failed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 100)),
      ]);
      await vi.advanceTimersByTimeAsync(101);
      expect(await verdict).toBe("failed");
      expect(instance.getActiveState()).toEqual(previousState);
      expect(fs.readFileSync(instance.getEffectiveIndexPath(), "utf8")).toBe(previousHtml);
    } finally {
      createWriteStream.mockRestore();
      stalledController?.error(new Error("test cleanup"));
      await vi.advanceTimersByTimeAsync(31_000);
      vi.useRealTimers();
    }
  });

  it("rolls back an installed bundle to the built-in renderer", async () => {
    const { bytes, manifest } = await makeSignedBundle();
    vi.mocked(fetch).mockResolvedValueOnce(response(bytes));
    const instance = manager();
    await expect(instance.downloadAndInstall(manifest)).resolves.toEqual({ success: true });
    const installedDir = instance.getActiveState()?.bundleDir;
    expect(installedDir).toBeTruthy();

    expect(instance.rollback()).toBe(true);
    expect(instance.getActiveState()).toBeNull();
    expect(fs.existsSync(path.join(userDataPath, "active_bundle.json"))).toBe(false);
    expect(fs.existsSync(installedDir!)).toBe(false);
    expect(fs.readFileSync(instance.getEffectiveIndexPath(), "utf8")).toBe("built-in");
  });
});
