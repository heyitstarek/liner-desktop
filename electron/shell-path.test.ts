import { describe, expect, it, vi } from "vitest";
import { openFolderOrReveal } from "./shell-path";

describe("shell path actions", () => {
  it("does not open a regular file as a directory for a missing child path", async () => {
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") };
    const fs = {
      existsSync: (target: string) => ["C:/tools/app.exe", "C:/Users/test/Downloads"].includes(target),
      statSync: (target: string) => ({ isDirectory: () => target === "C:/Users/test/Downloads" }),
    };

    const opened = await openFolderOrReveal(
      "C:/tools/app.exe/missing.txt",
      null,
      "C:/Users/test/Downloads",
      fs,
      shell,
    );

    expect(opened).toBe(true);
    expect(shell.openPath).toHaveBeenCalledOnce();
    expect(shell.openPath).toHaveBeenCalledWith("C:/Users/test/Downloads");
  });

  it("reveals an existing target and only opens verified directories", async () => {
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") };
    const fs = {
      existsSync: (target: string) => target === "C:/exports/report.json" || target === "C:/Downloads",
      statSync: () => ({ isDirectory: () => true }),
    };
    expect(await openFolderOrReveal("C:/exports/report.json", null, "C:/Downloads", fs, shell)).toBe(true);
    expect(shell.showItemInFolder).toHaveBeenCalledWith("C:/exports/report.json");
    expect(shell.openPath).not.toHaveBeenCalled();
  });
});
