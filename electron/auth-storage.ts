import fs from "node:fs/promises";
import path from "node:path";

export interface AuthStorageSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?(): string;
}

export interface AuthStorageOptions {
  userDataPath: string;
  platform: string;
  safeStorage: AuthStorageSafeStorage;
  files?: Pick<typeof fs, "mkdir" | "open" | "readFile" | "rename" | "unlink" | "lstat">;
}

const RECORD_NAME = "auth-session.bin";
const TEMP_NAME = "auth-session.tmp";
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAuthSessionPayload(value: unknown): value is {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  user: { id: string; [key: string]: unknown };
  expiresAt?: number;
} {
  if (!isRecord(value) || !isRecord(value.user)) return false;
  return typeof value.accessToken === "string" && value.accessToken.length > 0 && value.accessToken.length <= 8192
    && typeof value.refreshToken === "string" && value.refreshToken.length > 0 && value.refreshToken.length <= 8192
    && typeof value.accessTokenExpiresAt === "string" && value.accessTokenExpiresAt.length <= 128
    && typeof value.user.id === "string" && value.user.id.length <= 512
    && (value.expiresAt === undefined || (typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)));
}

/** Uses only Electron safeStorage encryption and fixed, app-owned filenames. */
export function createAuthSessionStorage(options: AuthStorageOptions) {
  const files = options.files ?? fs;
  const directory = path.resolve(options.userDataPath);
  const recordPath = path.join(directory, RECORD_NAME);
  const tempPath = path.join(directory, TEMP_NAME);
  let writeQueue: Promise<unknown> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const protectedBackendAvailable = async (): Promise<boolean> => {
    try {
      if (!await options.safeStorage.isAsyncEncryptionAvailable()) return false;
      if (options.platform === "linux") {
        // Electron's Linux async fallback has no public backend identity. Require the
        // synchronous API's explicit OS secret-store signal and fail closed otherwise.
        const backend = options.safeStorage.getSelectedStorageBackend?.();
        return backend === "gnome_libsecret" || backend === "kwallet" || backend === "kwallet5" || backend === "kwallet6";
      }
      return true;
    } catch {
      return false;
    }
  };

  const atomicWrite = async (bytes: Buffer): Promise<void> => {
    if (bytes.length === 0 || bytes.length > MAX_RECORD_BYTES) throw new Error("Invalid protected session record");
    await files.mkdir(directory, { recursive: true });
    try {
      const existing = await files.lstat(tempPath);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Invalid temporary session record");
      await files.unlink(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const handle = await files.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await files.rename(tempPath, recordPath);
  };

  const removeRecordFiles = async (): Promise<boolean> => {
    let succeeded = true;
    for (const target of [recordPath, tempPath]) {
      try { await files.unlink(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") succeeded = false;
      }
    }
    return succeeded;
  };

  return {
    load: (): Promise<unknown | null> => serialize(async () => {
      if (!await protectedBackendAvailable()) return null;
      try {
        const stat = await files.lstat(recordPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_RECORD_BYTES) return null;
        const encrypted = await files.readFile(recordPath);
        const decrypted = await options.safeStorage.decryptStringAsync(encrypted);
        const payload = Buffer.byteLength(decrypted.result, "utf8") <= MAX_PAYLOAD_BYTES
          ? JSON.parse(decrypted.result) as unknown
          : null;
        if (!isAuthSessionPayload(payload)) return null;
        if (decrypted.shouldReEncrypt) {
          const reEncrypted = await options.safeStorage.encryptStringAsync(JSON.stringify(payload));
          await atomicWrite(reEncrypted);
        }
        return payload;
      } catch {
        return null;
      }
    }),
    save: (payload: unknown): Promise<boolean> => serialize(async () => {
      if (!isAuthSessionPayload(payload)) return false;
      if (!await protectedBackendAvailable()) {
        await removeRecordFiles();
        return false;
      }
      try {
        const serialized = JSON.stringify(payload);
        if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
          await removeRecordFiles();
          return false;
        }
        const encrypted = await options.safeStorage.encryptStringAsync(serialized);
        await atomicWrite(encrypted);
        return true;
      } catch {
        await removeRecordFiles();
        return false;
      }
    }),
    clear: (): Promise<boolean> => serialize(removeRecordFiles),
    flush: (): Promise<unknown> => writeQueue,
  };
}
