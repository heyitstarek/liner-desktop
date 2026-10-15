// @vitest-environment jsdom
import React, { useRef } from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHorizontalScroll } from "./useHorizontalScroll";
import { useListReorder } from "./useListReorder";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

function pointerEvent(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    pointerId: { value: 1 },
  });
  return event;
}

describe("drag hook listener cleanup", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("removes horizontal drag listeners on unmount", async () => {
    let result!: ReturnType<typeof useHorizontalScroll>;
    function TestComponent() {
      result = useHorizontalScroll();
      return <div ref={result.scrollRef} {...result.handlers} />;
    }
    await act(async () => { root.render(<TestComponent />); });
    const scroller = container.firstElementChild as HTMLDivElement;
    Object.defineProperties(scroller, {
      scrollWidth: { configurable: true, value: 500 },
      clientWidth: { configurable: true, value: 100 },
      scrollLeft: { configurable: true, writable: true, value: 10 },
    });
    act(() => {
      scroller.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 100 }));
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 80 }));
    });
    const positionAtUnmount = scroller.scrollLeft;
    expect(document.body.style.cursor).toBe("grabbing");

    act(() => root.unmount());
    act(() => window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 30 })));

    expect(scroller.scrollLeft).toBe(positionAtUnmount);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("discards a cancelled reorder and removes active pointer listeners on unmount", async () => {
    const items = ["one", "two", "three"];
    const onReorder = vi.fn();
    let result!: ReturnType<typeof useListReorder<string>>;
    let card!: HTMLDivElement;
    function TestComponent() {
      const scrollRef = useRef<HTMLDivElement>(null);
      const listRef = useRef<HTMLDivElement>(null);
      result = useListReorder({ items, scrollContainerRef: scrollRef, listContainerRef: listRef, itemHeight: 50, onReorder });
      return <div ref={scrollRef}><div ref={listRef}><div ref={(node) => { if (node) card = node; }} data-reorder-item="" /></div></div>;
    }
    await act(async () => { root.render(<TestComponent />); });
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON() {} });
    const event = {
      button: 0,
      clientX: 10,
      clientY: 10,
      target: card,
      currentTarget: card,
    } as any;
    act(() => result.handleCardGrab(0, "one", event));
    act(() => window.dispatchEvent(pointerEvent("pointermove", 10, 130)));
    expect(result.isDragging).toBe(true);

    act(() => window.dispatchEvent(pointerEvent("pointercancel", 10, 130)));
    expect(onReorder).not.toHaveBeenCalled();
    expect(result.isDragging).toBe(false);

    act(() => result.handleCardGrab(0, "one", event));
    act(() => window.dispatchEvent(pointerEvent("pointermove", 10, 130)));
    expect(window.__linerWasDragging).toBe(true);
    act(() => root.unmount());
    window.dispatchEvent(pointerEvent("pointermove", 10, 30));
    window.dispatchEvent(pointerEvent("pointerup", 10, 30));

    expect(onReorder).not.toHaveBeenCalled();
    expect(window.__linerWasDragging).toBe(false);
    expect(document.body.style.cursor).toBe("");
  });
});
