import path from "node:path";

export interface ShellPathFileSystem {
  existsSync(targetPath: string): boolean;
  statSync(targetPath: string): { isDirectory(): boolean };
}

export interface ShellPathActions {
  showItemInFolder(targetPath: string): void;
  openPath(targetPath: string): Promise<string>;
}

export async function openFolderOrReveal(
  targetPath: string | undefined,
  lastSavedExportPath: string | null,
  downloadsPath: string,
  fileSystem: ShellPathFileSystem,
  shell: ShellPathActions,
): Promise<boolean> {
  try {
    const target = targetPath || lastSavedExportPath;
    if (target && fileSystem.existsSync(target)) {
      shell.showItemInFolder(target);
      return true;
    }

    if (target) {
      const parent = path.dirname(target);
      if (fileSystem.existsSync(parent) && fileSystem.statSync(parent).isDirectory()) {
        await shell.openPath(parent);
        return true;
      }
    }

    if (!fileSystem.existsSync(downloadsPath) || !fileSystem.statSync(downloadsPath).isDirectory()) {
      return false;
    }
    await shell.openPath(downloadsPath);
    return true;
  } catch {
    return false;
  }
}
