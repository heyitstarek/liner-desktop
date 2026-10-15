// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomizationTab } from "./CustomizationTab";

const mocks = vi.hoisted(() => ({
  setBackgroundImage: vi.fn(),
  state: {
    backgroundImage: "existing-wallpaper",
    backgroundBlur: 0,
    backgroundDim: 0,
    sidebar: { opacity: 100, blur: 0, dim: 0 },
    contentView: { opacity: 100, blur: 0, dim: 0 },
    miniplayer: { opacity: 100, blur: 0, dim: 0 },
  },
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/languages", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("@/shared/ui", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Slider: () => null,
  ToggleSwitch: () => null,
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("../controls", () => ({
  SettingBlock: ({ children }: any) => <section>{children}</section>,
  SettingRow: () => null,
  SettingSection: ({ children }: any) => <div>{children}</div>,
  SegmentedControl: () => null,
}));
vi.mock("../../store/customizationStore", () => ({
  useCustomizationStore: (selector: (state: any) => unknown) => selector({
    ...mocks.state,
    setBackgroundImage: mocks.setBackgroundImage,
    setBackgroundBlur: vi.fn(),
    setBackgroundDim: vi.fn(),
    setBlockConfig: vi.fn(),
    applyToAllBlocks: vi.fn(),
    resetBlock: vi.fn(),
    resetAll: vi.fn(),
  }),
  MIN_OPACITY: 25, MAX_OPACITY: 100, MIN_BLUR: 10, MAX_BLUR: 40, MIN_DIM: 8, MAX_DIM: 85,
}));

class ControlledFileReader {
  static readers: ControlledFileReader[] = [];
  result: string | ArrayBuffer | null = null;
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
  onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;
  constructor() { ControlledFileReader.readers.push(this); }
  readAsDataURL() {}
}

describe("CustomizationTab wallpaper read ordering", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    ControlledFileReader.readers = [];
    mocks.setBackgroundImage.mockClear();
    vi.stubGlobal("FileReader", ControlledFileReader);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("honors only the newest selection and cancels a pending selection when removed", async () => {
    await act(async () => { root.render(<CustomizationTab />); });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const choose = (name: string) => {
      Object.defineProperty(input, "files", { configurable: true, value: [new File([name], name, { type: "image/png" })] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    act(() => choose("older.png"));
    act(() => choose("newer.png"));
    const [older, newer] = ControlledFileReader.readers;
    expect(older).toBeDefined();
    expect(newer).toBeDefined();

    act(() => {
      newer.result = "data:image/png;base64,newer";
      newer.onload?.({} as ProgressEvent<FileReader>);
    });
    expect(mocks.setBackgroundImage).toHaveBeenLastCalledWith("data:image/png;base64,newer");

    act(() => {
      older.result = "data:image/png;base64,older";
      older.onload?.({} as ProgressEvent<FileReader>);
    });
    expect(mocks.setBackgroundImage).not.toHaveBeenCalledWith("data:image/png;base64,older");

    let removeButton: HTMLButtonElement | null = null;
    act(() => {
      removeButton = Array.from(container.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "settings.customization.remove_button") ?? null;
      removeButton?.click();
    });
    expect(mocks.setBackgroundImage).toHaveBeenLastCalledWith(null);

    act(() => {
      newer.result = "data:image/png;base64,late";
      newer.onload?.({} as ProgressEvent<FileReader>);
    });
    expect(mocks.setBackgroundImage).not.toHaveBeenCalledWith("data:image/png;base64,late");
  });
});
