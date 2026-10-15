import { app, BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { finished } from "node:stream/promises";
import * as tar from "tar";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 250 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export interface BundleManifest {
  bundleVersion: string;
  minAppVersion: string;
  channel: string;
  downloadUrl: string;
  sha256: string;
  size: number;
  signature: string;
  releasedAt: string;
  releaseNotes?: string;
}

export interface ActiveBundleState {
  bundleVersion: string;
  bundleDir: string;
  installedAt: string;
  sha256: string;
  minAppVersion: string;
  isFallback?: boolean;
}

export interface BundleUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
}

export class BundleManager {
  private defaultRendererDist: string;
  private bundlesRoot: string;
  private stateFilePath: string;
  private activeState: ActiveBundleState | null = null;
  private updaterUrl: string;
  private publicKeyHex: string;
  private mainWindow: BrowserWindow | null = null;
  private isChecking = false;
  private isDownloading = false;

  constructor(options: {
    defaultRendererDist: string;
    updaterUrl?: string;
    publicKeyHex?: string;
  }) {
    this.defaultRendererDist = options.defaultRendererDist;
    this.updaterUrl =
      options.updaterUrl ||
      process.env.LINER_UPDATER_URL ||
      "https://updates.tryliner.fun";

    this.publicKeyHex =
      options.publicKeyHex ||
      process.env.LINER_UPDATER_PUBLIC_KEY ||
      "302a300506032b6570032100508b7c5d10171f046c1bfd28e01d651b99c6b29cd78f8dcda00c47893c51b8de";

    // userData/bundles
    const userData = app.getPath("userData");
    this.bundlesRoot = path.join(userData, "bundles");
    this.stateFilePath = path.join(userData, "active_bundle.json");

    if (!fs.existsSync(this.bundlesRoot)) {
      fs.mkdirSync(this.bundlesRoot, { recursive: true });
    }

    this.assertNoSymlink(this.bundlesRoot);

    this.loadActiveState();
  }

  public setMainWindow(win: BrowserWindow) {
    this.mainWindow = win;
  }

  /**
   * Reads active_bundle.json and validates files exist and are compatible
   */
  private loadActiveState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, "utf-8");
        const parsed = JSON.parse(raw) as ActiveBundleState;
        if (!this.isValidActiveState(parsed)) throw new Error("Invalid active bundle state");
        const indexHtml = path.join(parsed.bundleDir, "dist", "index.html");

        // Validate bundle exists on disk and is compatible with current appVersion
        if (
          fs.existsSync(indexHtml) &&
          this.isVersionCompatible(app.getVersion(), parsed.minAppVersion)
        ) {
          this.activeState = parsed;
          return;
        } else {
          console.warn(
            `\x1b[33m[BundleManager]\x1b[0m Cached bundle ${parsed.bundleVersion} is invalid or incompatible, reverting to built-in dist.`
          );
        }
      }
    } catch (err) {
      console.error("\x1b[31m[BundleManager]\x1b[0m Failed to read active bundle state:", err);
    }

    this.activeState = null;
  }

  /**
   * Returns path to current effective index.html (active OTA bundle OR built-in fallback)
   */
  public getEffectiveIndexPath(): string {
    if (this.activeState && this.isValidActiveState(this.activeState)) {
      const activeHtml = path.join(this.activeState.bundleDir, "dist", "index.html");
      if (fs.existsSync(activeHtml)) {
        return activeHtml;
      }
    }
    return path.join(this.defaultRendererDist, "index.html");
  }

  public getActiveVersion(): string {
    return this.activeState ? this.activeState.bundleVersion : app.getVersion();
  }

  public getActiveState(): ActiveBundleState | null {
    return this.activeState;
  }

  /**
   * Compares appVersion >= minAppVersion using semver comparison
   */
  public isVersionCompatible(appVersion: string, minAppVersion: string): boolean {
    if (!minAppVersion) return true;
    const cleanApp = appVersion.split("-")[0].split(".").map(Number);
    const cleanMin = minAppVersion.split("-")[0].split(".").map(Number);

    for (let i = 0; i < 3; i++) {
      const a = cleanApp[i] || 0;
      const m = cleanMin[i] || 0;
      if (a > m) return true;
      if (a < m) return false;
    }
    return true;
  }

  /**
   * Queries /updates/manifest.json for a new bundle
   */
  public async checkForUpdates(): Promise<{
    available: boolean;
    manifest?: BundleManifest;
    reason?: string;
  }> {
    if (this.isChecking) return { available: false, reason: "Already checking" };
    this.isChecking = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const baseUrl = this.parseUpdaterUrl();
      const manifestUrl = new URL("/updates/manifest.json", baseUrl);
      manifestUrl.searchParams.set("t", String(Date.now()));
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      const res = await fetch(manifestUrl, { cache: "no-store", signal: controller.signal, redirect: "error" });
      if (!res.ok) {
        return { available: false, reason: `Server returned ${res.status}` };
      }

      const contentLength = Number(res.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_MANIFEST_BYTES) {
        return { available: false, reason: "Manifest exceeds size limit" };
      }
      const manifestText = await this.readBoundedText(res, MAX_MANIFEST_BYTES);
      const manifestValue: unknown = JSON.parse(manifestText);
      if (!this.isValidManifest(manifestValue)) {
        return { available: false, reason: "Invalid bundle manifest" };
      }
      const manifest = manifestValue;

      // 1. Check compatibility
      if (!this.isVersionCompatible(app.getVersion(), manifest.minAppVersion)) {
        console.log(
          `\x1b[33m[BundleManager]\x1b[0m Bundle ${manifest.bundleVersion} requires app >= ${manifest.minAppVersion}, but running ${app.getVersion()}`
        );
        return { available: false, reason: "App version too old for bundle" };
      }

      // 2. Check if newer or different hash
      const isSameVersion = this.activeState?.bundleVersion === manifest.bundleVersion;
      const isSameHash = this.activeState?.sha256?.toLowerCase() === manifest.sha256.toLowerCase();

      if (isSameVersion && isSameHash) {
        return { available: false, reason: "Already up to date" };
      }

      console.log(`\x1b[32m[BundleManager]\x1b[0m New OTA bundle found: ${manifest.bundleVersion} (sha: ${manifest.sha256.slice(0, 8)}). Downloading silently in background...`);

      // Auto download & install in background completely silently (no UI alerts)
      this.downloadAndInstall(manifest).then((res) => {
        if (res.success) {
          console.log(`\x1b[32m[BundleManager]\x1b[0m Bundle ${manifest.bundleVersion} installed silently. Will activate on next launch.`);
        }
      });

      return { available: true, manifest };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`\x1b[33m[BundleManager]\x1b[0m Check update failed: ${message}`);
      return { available: false, reason: message };
    } finally {
      if (timeout) clearTimeout(timeout);
      this.isChecking = false;
    }
  }

  /**
   * Downloads, validates Ed25519 signature & sha256, and extracts bundle
   */
  public async downloadAndInstall(manifest: BundleManifest): Promise<{ success: boolean; error?: string }> {
    if (this.isDownloading) return { success: false, error: "Already downloading" };
    this.isDownloading = true;
    let stagingDir: string | undefined;
    let committedDir: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      if (!this.isValidManifest(manifest)) throw new Error("Invalid bundle manifest");
      const downloadUrl = new URL(manifest.downloadUrl);
      if (!this.isAllowedDownloadUrl(downloadUrl)) throw new Error("Bundle download URL is not allowed");
      const bundleDirName = `bundle-${manifest.bundleVersion}-${manifest.sha256.slice(0, 8)}-${crypto.randomBytes(8).toString("hex")}`;
      const bundleDir = this.resolveUnderBundles(bundleDirName);
      stagingDir = fs.mkdtempSync(this.resolveUnderBundles(".staging-"));
      this.assertNoSymlink(stagingDir);
      const tempArchive = path.join(stagingDir, "archive.tar.gz");
      this.resolveUnderBundles(path.relative(this.bundlesRoot, tempArchive));

      console.log(`\x1b[36m[BundleManager]\x1b[0m Downloading ${manifest.downloadUrl}...`);
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(downloadUrl, { signal: controller.signal, redirect: "error" });
      } catch (err) {
        clearTimeout(timeout);
        timeout = undefined;
        throw err;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`Download failed with status ${res.status}`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("Unable to read download response stream");
      let stream: fs.WriteStream | undefined;
      const hashState = crypto.createHash("sha256");
      let transferred = 0;
      const contentLength = res.headers.get("content-length");
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== manifest.size)) {
        clearTimeout(timeout);
        timeout = undefined;
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
        throw new Error("Bundle content length does not match manifest");
      }
      try {
        stream = fs.createWriteStream(tempArchive, { flags: "wx" });
        let rejectStreamFailure!: (error: Error) => void;
        const streamFailure = new Promise<never>((_resolve, reject) => {
          rejectStreamFailure = reject;
        });
        // This promise stays observed even if the stream fails between awaits.
        void streamFailure.catch(() => undefined);
        stream.on("error", rejectStreamFailure);
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), streamFailure]);
          if (done) break;
          if (!value?.byteLength) continue;
          transferred += value.byteLength;
          if (transferred > MAX_ARCHIVE_BYTES || transferred > manifest.size) {
            throw new Error("Bundle download exceeds size limit");
          }
          const chunk = Buffer.from(value);
          hashState.update(chunk);
          await Promise.race([
            new Promise<void>((resolve, reject) => {
              stream!.write(chunk, (error) => error ? reject(error) : resolve());
            }),
            streamFailure,
          ]);
        }
        clearTimeout(timeout);
        timeout = undefined;
        await Promise.race([new Promise<void>((resolve) => stream!.end(resolve)), streamFailure]);
        await Promise.race([finished(stream), streamFailure]);
      } catch (err) {
        clearTimeout(timeout);
        timeout = undefined;
        await reader.cancel().catch(() => undefined);
        stream?.destroy();
        if (stream) await finished(stream).catch(() => undefined);
        throw err;
      } finally {
        reader.releaseLock();
      }
      if (transferred !== manifest.size) throw new Error("Bundle download size does not match manifest");

      const hash = hashState.digest("hex");
      if (hash.toLowerCase() !== manifest.sha256.toLowerCase()) {
        throw new Error(`SHA256 mismatch! Expected ${manifest.sha256}, got ${hash}`);
      }

      // Verify Ed25519 signature
      const isValid = this.verifySignature(Buffer.from(hash, "utf-8"), manifest.signature);
      if (!isValid) {
        throw new Error("Ed25519 signature verification failed! Possible tampered bundle.");
      }

      this.validateArchive(tempArchive, stagingDir);
      tar.extract({
        sync: true,
        file: tempArchive,
        cwd: stagingDir,
      });
      fs.unlinkSync(tempArchive);

      // Verify that extracted files contain dist/index.html
      const indexHtml = path.join(stagingDir, "dist", "index.html");
      if (!this.isRegularFileWithoutLinks(indexHtml, stagingDir)) {
        throw new Error("Corrupted archive: dist/index.html missing after extraction");
      }

      this.assertNoSymlink(stagingDir);
      fs.renameSync(stagingDir, bundleDir);
      stagingDir = undefined;
      committedDir = bundleDir;

      // Save state
      const newState: ActiveBundleState = {
        bundleVersion: manifest.bundleVersion,
        bundleDir,
        installedAt: new Date().toISOString(),
        sha256: hash,
        minAppVersion: manifest.minAppVersion,
      };

      const stateTempPath = path.join(path.dirname(this.stateFilePath), `.active_bundle-${crypto.randomBytes(8).toString("hex")}.tmp`);
      try {
        fs.writeFileSync(stateTempPath, JSON.stringify(newState, null, 2), { encoding: "utf-8", flag: "wx" });
        fs.renameSync(stateTempPath, this.stateFilePath);
      } catch (err) {
        try { fs.rmSync(stateTempPath, { force: true }); } catch {}
        throw err;
      }
      this.activeState = newState;
      committedDir = undefined;

      console.log(`\x1b[32m[BundleManager]\x1b[0m Successfully installed bundle ${manifest.bundleVersion}`);
      try {
        this.mainWindow?.webContents.send("bundle:ready", newState);
      } catch (err) {
        console.warn("\x1b[33m[BundleManager]\x1b[0m Bundle installed but readiness notification failed:", err);
      }

      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("\x1b[31m[BundleManager]\x1b[0m Failed to install bundle:", message);
      try {
        if (stagingDir) this.removeOwnedDirectory(stagingDir);
        if (committedDir) this.removeOwnedDirectory(committedDir);
      } catch {}
      return { success: false, error: message };
    } finally {
      if (timeout) clearTimeout(timeout);
      this.isDownloading = false;
    }
  }

  /**
   * Applies the downloaded bundle immediately (Hot Swap)
   */
  public hotSwap(): boolean {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;
    const indexPath = this.getEffectiveIndexPath();
    console.log(`\x1b[35m[BundleManager]\x1b[0m Performing Hot Swap to: ${indexPath}`);
    this.mainWindow.loadFile(indexPath);
    return true;
  }

  /**
   * Failsafe Rollback: Reverts to built-in dist and deletes broken bundle
   */
  public rollback(): boolean {
    console.warn("\x1b[31m[BundleManager]\x1b[0m Triggering emergency rollback to built-in dist...");
    try {
      if (this.activeState) {
        const brokenDir = this.activeState.bundleDir;
        if (this.isValidActiveState(this.activeState) && fs.existsSync(brokenDir)) this.removeOwnedDirectory(brokenDir);
      }
      if (fs.existsSync(this.stateFilePath)) {
        fs.unlinkSync(this.stateFilePath);
      }
      this.activeState = null;

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        const fallbackPath = path.join(this.defaultRendererDist, "index.html");
        this.mainWindow.loadFile(fallbackPath);
      }
      return true;
    } catch (err) {
      console.error("\x1b[31m[BundleManager]\x1b[0m Rollback error:", err);
      return false;
    }
  }

  private verifySignature(data: Buffer, signatureHex: string): boolean {
    try {
      const publicKey = crypto.createPublicKey({
        key: Buffer.from(this.publicKeyHex, "hex"),
        format: "der",
        type: "spki",
      });
      return crypto.verify(null, data, publicKey, Buffer.from(signatureHex, "hex"));
    } catch {
      return false;
    }
  }

  private parseUpdaterUrl(): URL {
    const url = new URL(this.updaterUrl);
    if (url.protocol !== "https:" && !this.isLoopbackHttp(url)) {
      throw new Error("Updater URL must use HTTPS");
    }
    if (url.username || url.password) throw new Error("Updater URL must not contain credentials");
    return url;
  }

  private isAllowedDownloadUrl(url: URL): boolean {
    if (url.username || url.password || url.hash) return false;
    const base = this.parseUpdaterUrl();
    if (url.origin === base.origin && url.protocol === "https:") return true;
    return this.isLoopbackHttp(base) && this.isLoopbackHttp(url) && url.origin === base.origin;
  }

  private isLoopbackHttp(url: URL): boolean {
    return (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") &&
      url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  }

  private isValidManifest(value: unknown): value is BundleManifest {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const manifest = value as Record<string, unknown>;
    if (typeof manifest.bundleVersion !== "string" || !SAFE_VERSION.test(manifest.bundleVersion)) return false;
    if (typeof manifest.minAppVersion !== "string" || !SAFE_VERSION.test(manifest.minAppVersion)) return false;
    if (typeof manifest.channel !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(manifest.channel)) return false;
    if (typeof manifest.downloadUrl !== "string" || manifest.downloadUrl.length > 2048) return false;
    let url: URL;
    try { url = new URL(manifest.downloadUrl); } catch { return false; }
    if (!this.isAllowedDownloadUrl(url)) return false;
    if (typeof manifest.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(manifest.sha256)) return false;
    if (!Number.isSafeInteger(manifest.size) || (manifest.size as number) <= 0 || (manifest.size as number) > MAX_ARCHIVE_BYTES) return false;
    if (typeof manifest.signature !== "string" || !/^[a-fA-F0-9]{128}$/.test(manifest.signature)) return false;
    if (typeof manifest.releasedAt !== "string" || manifest.releasedAt.length > 64 || !Number.isFinite(Date.parse(manifest.releasedAt))) return false;
    if (manifest.releaseNotes !== undefined && (typeof manifest.releaseNotes !== "string" || manifest.releaseNotes.length > 16_384)) return false;
    return true;
  }

  private resolveUnderBundles(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath) || /%2f|%5c/i.test(relativePath)) {
      throw new Error("Invalid bundle path");
    }
    const resolved = path.resolve(this.bundlesRoot, relativePath);
    const relative = path.relative(this.bundlesRoot, resolved);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Bundle path escapes bundles directory");
    }
    return resolved;
  }

  private assertNoSymlink(target: string): void {
    const root = path.resolve(this.bundlesRoot);
    const resolved = path.resolve(target);
    const relative = path.relative(root, resolved);
    if (resolved !== root && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
      throw new Error("Bundle path escapes bundles directory");
    }
    let current = root;
    const rootStats = fs.lstatSync(current);
    if (rootStats.isSymbolicLink()) throw new Error("Bundles directory must not be a symbolic link");
    for (const segment of (resolved === root ? [] : relative.split(path.sep))) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Bundle path contains a symbolic link");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
        throw err;
      }
    }
  }

  private isValidActiveState(value: ActiveBundleState): boolean {
    if (!value || typeof value !== "object" || typeof value.bundleVersion !== "string" || !SAFE_VERSION.test(value.bundleVersion)) return false;
    if (typeof value.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(value.sha256)) return false;
    if (typeof value.minAppVersion !== "string" || !SAFE_VERSION.test(value.minAppVersion)) return false;
    if (typeof value.installedAt !== "string" || !Number.isFinite(Date.parse(value.installedAt))) return false;
    if (typeof value.bundleDir !== "string") return false;
    const root = path.resolve(this.bundlesRoot);
    const resolved = path.resolve(value.bundleDir);
    const relative = path.relative(root, resolved);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    try {
      this.assertNoSymlink(resolved);
      return this.isRegularFileWithoutLinks(path.join(resolved, "dist", "index.html"), root);
    } catch {
      return false;
    }
  }

  private isRegularFileWithoutLinks(filePath: string, root: string): boolean {
    const resolvedRoot = path.resolve(root);
    const resolvedFile = path.resolve(filePath);
    const relative = path.relative(resolvedRoot, resolvedFile);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    let current = resolvedRoot;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink()) return false;
      if (current === resolvedFile && !stats.isFile()) return false;
    }
    return true;
  }

  private validateArchive(archivePath: string, extractionRoot: string): void {
    let entries = 0;
    let totalBytes = 0;
    tar.list({ file: archivePath, sync: true, onReadEntry: (entry) => {
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES) throw new Error("Bundle contains too many archive entries");
      if (!["File", "OldFile", "ContiguousFile", "Directory"].includes(entry.type)) {
        throw new Error("Bundle archive contains an unsafe entry type");
      }
      if (typeof entry.path !== "string" || entry.path.includes("\\") || entry.path.includes("%") || entry.path.startsWith("/")) {
        throw new Error("Bundle archive contains an invalid path");
      }
      const pathSegments = entry.path.split("/");
      if (pathSegments[0] === ".") pathSegments.shift();
      if (pathSegments[pathSegments.length - 1] === "") pathSegments.pop();
      if (pathSegments.some((segment) => segment === "." || segment === ".." || segment === "")) {
        throw new Error("Bundle archive contains a path alias");
      }
      if (pathSegments.length === 0) {
        if (entry.type !== "Directory" || entry.size !== 0) throw new Error("Bundle archive contains an invalid root entry");
        return;
      }
      const destination = path.resolve(extractionRoot, ...pathSegments);
      const relative = path.relative(extractionRoot, destination);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Bundle archive entry escapes extraction directory");
      }
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("Bundle archive has invalid entry size");
      totalBytes += entry.size;
      if (totalBytes > MAX_EXTRACTED_BYTES) throw new Error("Bundle expands beyond size limit");
    } });
  }

  private removeOwnedDirectory(directory: string): void {
    const resolved = this.resolveUnderBundles(path.relative(this.bundlesRoot, directory));
    this.assertNoSymlink(resolved);
    if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
  }

  private async readBoundedText(response: Response, maxBytes: number): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Unable to read manifest response stream");
    const decoder = new TextDecoder();
    let total = 0;
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error("Manifest exceeds size limit");
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      throw err;
    } finally {
      reader.releaseLock();
    }
  }
}
