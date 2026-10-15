import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthSessionStorage, type AuthStorageOptions } from "./auth-storage";

const fixture = {
  accessToken: "synthetic-access-fixture-8c4d",
  refreshToken: "synthetic-refresh-fixture-2a91",
  accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
  user: { id: "synthetic-user", email: "fixture@example.test" },
};

describe("protected native auth session storage", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function setup(overrides: Partial<AuthStorageOptions> = {}) {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "liner-auth-storage-"));
    roots.push(userDataPath);
    const safeStorage = {
      isAsyncEncryptionAvailable: vi.fn(async () => true),
      encryptStringAsync: vi.fn(async (plain: string) => Buffer.from(`encrypted:${Buffer.from(plain).toString("base64")}`)),
      decryptStringAsync: vi.fn(async (encrypted: Buffer) => ({
        result: Buffer.from(encrypted.toString().slice("encrypted:".length), "base64").toString(),
        shouldReEncrypt: false,
      })),
      getSelectedStorageBackend: vi.fn(() => "gnome_libsecret"),
    };
    const storage = createAuthSessionStorage({ userDataPath, platform: "win32", safeStorage, ...overrides });
    return { storage, safeStorage, userDataPath };
  }

  it("round-trips tokens through encrypted bytes without writing fixture plaintext", async () => {
    const { storage, userDataPath } = await setup();
    expect(await storage.save(fixture)).toBe(true);
    const record = await fs.readFile(path.join(userDataPath, "auth-session.bin"));
    expect(record.toString()).not.toContain(fixture.accessToken);
    expect(record.toString()).not.toContain(fixture.refreshToken);
    expect(await storage.load()).toEqual(fixture);
  });

  it("replaces the protected record with the newest session", async () => {
    const { storage } = await setup();
    const replacement = { ...fixture, accessToken: "synthetic-access-replacement", user: { id: "replacement-user" } };
    expect(await storage.save(fixture)).toBe(true);
    expect(await storage.save(replacement)).toBe(true);
    expect(await storage.load()).toEqual(replacement);
  });

  it("invalidates the previous account record if atomic replacement fails", async () => {
    const { storage, userDataPath } = await setup();
    expect(await storage.save(fixture)).toBe(true);
    const replacement = { ...fixture, accessToken: "synthetic-access-next" };
    const failingFiles = {
      mkdir: fs.mkdir,
      open: fs.open,
      readFile: fs.readFile,
      lstat: fs.lstat,
      unlink: fs.unlink,
      rename: vi.fn(async () => { throw new Error("disk failure"); }),
    } as unknown as AuthStorageOptions["files"];
    const failingStorage = createAuthSessionStorage({
      userDataPath,
      platform: "win32",
      safeStorage: {
        isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async (plain) => Buffer.from(`encrypted:${Buffer.from(plain).toString("base64")}`),
        decryptStringAsync: async (encrypted) => ({ result: Buffer.from(encrypted.toString().slice(10), "base64").toString(), shouldReEncrypt: false }),
      },
      files: failingFiles,
    });
    expect(await failingStorage.save(replacement)).toBe(false);
    expect(await storage.load()).toBeNull();
  });

  it("does not persist when protection is unavailable or Linux reports basic_text", async () => {
    const { safeStorage, userDataPath } = await setup();
    const linuxStorage = createAuthSessionStorage({
      userDataPath,
      platform: "linux",
      safeStorage: { ...safeStorage, getSelectedStorageBackend: () => "basic_text" },
    });
    expect(await linuxStorage.save(fixture)).toBe(false);
    expect(await fs.readdir(userDataPath)).toEqual([]);

    safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);
    expect(await linuxStorage.save(fixture)).toBe(false);
    expect(await fs.readdir(userDataPath)).toEqual([]);
  });

  it("clears an existing protected blob even after encryption becomes unavailable", async () => {
    const { storage, safeStorage, userDataPath } = await setup();
    expect(await storage.save(fixture)).toBe(true);
    safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);
    expect(await storage.clear()).toBe(true);
    await expect(fs.access(path.join(userDataPath, "auth-session.bin"))).rejects.toThrow();
  });

  it("removes an old account record when replacement protection becomes unavailable", async () => {
    const { storage, safeStorage } = await setup();
    expect(await storage.save(fixture)).toBe(true);
    safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);

    expect(await storage.save({ ...fixture, accessToken: "synthetic-account-b-access" })).toBe(false);
    safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(true);
    expect(await storage.load()).toBeNull();
  });

  it("removes an old account record when encryption itself fails", async () => {
    const { storage, safeStorage } = await setup();
    expect(await storage.save(fixture)).toBe(true);
    safeStorage.encryptStringAsync.mockRejectedValue(new Error("synthetic encryption failure"));

    expect(await storage.save({ ...fixture, accessToken: "synthetic-account-b-access" })).toBe(false);
    expect(await storage.load()).toBeNull();
  });

  it("serializes a pending save before logout clear so logout cannot be resurrected", async () => {
    let releaseEncryption!: () => void;
    const { storage, userDataPath, safeStorage } = await setup();
    safeStorage.encryptStringAsync.mockImplementationOnce((plain) => new Promise((resolve) => {
      releaseEncryption = () => resolve(Buffer.from(`encrypted:${Buffer.from(plain).toString("base64")}`));
    }));
    const save = storage.save(fixture);
    await vi.waitFor(() => expect(releaseEncryption).toBeTypeOf("function"));
    const clear = storage.clear();
    releaseEncryption();
    expect(await save).toBe(true);
    expect(await clear).toBe(true);
    expect(await storage.load()).toBeNull();
    expect(await fs.readdir(userDataPath)).toEqual([]);
  });
});
