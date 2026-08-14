import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HIDE_DELAY_MS = 5000;

function installTopbarDom(): void {
  document.body.innerHTML = `
    <div id="topbar" role="banner">
      <a id="topbar-home" href="/"></a>
      <button id="permissions-button"></button>
      <button id="mode-button"></button>
      <button id="auth-button"><div class="user-badge">RS</div></button>
      <div class="more-popover" id="more-popover"></div>
    </div>
    <div class="user-popover" id="user-popover"></div>
    <div class="mode-popover" id="mode-popover"></div>
    <div class="permissions-popover" id="permissions-popover"></div>
    <div class="auth-modal-backdrop" id="auth-modal-backdrop"></div>
    <div id="app">
      <iframe id="app-frame" style="position:fixed;top:56px;height:calc(100vh - 56px)"></iframe>
    </div>
    <a id="toast" href="/">a toast that also lives after the app</a>
  `;
}

function appFrame(): HTMLIFrameElement {
  return document.getElementById("app-frame") as HTMLIFrameElement;
}

function topbar(): HTMLElement {
  return document.getElementById("topbar") as HTMLElement;
}

function isHidden(): boolean {
  return topbar().style.transform === "translateY(-100%)";
}

/** happy-dom does not raise focusin from focus(), so drive it explicitly. */
function focusElement(el: HTMLElement): void {
  el.focus();
  el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
}

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

// Each test imports a fresh module instance, so the previous one has to drop
// its document listeners or it keeps acting on the shared DOM.
let dispose: (() => void) | null = null;

async function loadAutoHide(): Promise<
  typeof import("@dotli/ui/topbar-autohide")
> {
  const mod = await import("@dotli/ui/topbar-autohide");
  dispose = mod.disposeTopbarAutoHide;
  return mod;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.useFakeTimers();
  installTopbarDom();
});

afterEach(() => {
  dispose?.();
  dispose = null;
  vi.useRealTimers();
});

describe("topbar auto-hide reveal", () => {
  it("As a dotli integrator, the host hides the bar once the session settles", async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();

    // When
    armTopbarAutoHide();
    vi.advanceTimersByTime(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it("As a keyboard user, tabbing into the hidden bar brings it back", async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(isHidden()).toBe(true);

    // When
    focusElement(document.getElementById("topbar-home") as HTMLElement);

    // Then
    expect(isHidden()).toBe(false);

    // When focus stays in the bar, the hide timer must not fire
    vi.advanceTimersByTime(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
  });

  it("As a keyboard user, leaving the bar re-arms the hide timer", async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    focusElement(document.getElementById("mode-button") as HTMLElement);
    expect(isHidden()).toBe(false);

    // When
    focusElement(appFrame());
    vi.advanceTimersByTime(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it("As a keyboard user, the bar stays up while its settings popover is open", async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();

    // When
    document.getElementById("mode-popover")?.classList.add("open");
    vi.advanceTimersByTime(HIDE_DELAY_MS * 3);

    // Then
    expect(isHidden()).toBe(false);

    // When the popover closes, the bar hides again
    document.getElementById("mode-popover")?.classList.remove("open");
    vi.advanceTimersByTime(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it("As a keyboard user, Alt+Shift+T toggles the bar and moves focus with it", async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    vi.advanceTimersByTime(HIDE_DELAY_MS);

    // When
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyT",
        altKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );

    // Then
    expect(isHidden()).toBe(false);
    expect(document.activeElement?.id).toBe("topbar-home");

    // When
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyT",
        altKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );

    // Then focus must not stay parked on the offscreen bar
    expect(isHidden()).toBe(true);
    expect(topbar().contains(document.activeElement)).toBe(false);
  });

  it("As a keyboard user, the reveal button sits after the app frame in tab order", async () => {
    // Given
    const { armTopbarAutoHide, TOPBAR_REVEAL_BUTTON_ID } = await loadAutoHide();
    armTopbarAutoHide();
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    const button = document.getElementById(TOPBAR_REVEAL_BUTTON_ID);

    // Then it is focusable and sits between the frame and the toasts, so one
    // forward Tab out of the dApp reaches it
    expect(button?.tagName).toBe("BUTTON");
    expect(
      appFrame().compareDocumentPosition(button as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (document.getElementById("toast") as Node).compareDocumentPosition(
        button as Node,
      ) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();

    // When
    (button as HTMLElement).focus();
    (button as HTMLElement).dispatchEvent(new FocusEvent("focus"));

    // Then focus alone reveals the bar and holds it there
    expect(isHidden()).toBe(false);
    vi.advanceTimersByTime(HIDE_DELAY_MS * 2);
    expect(isHidden()).toBe(false);

    // When
    (button as HTMLButtonElement).click();

    // Then
    expect(document.activeElement?.id).toBe("topbar-home");
  });

  it("As a dotli integrator, the bar advertises its reveal shortcut while armed", async () => {
    // Given
    const {
      armTopbarAutoHide,
      pinTopbarVisible,
      TOPBAR_REVEAL_SHORTCUT,
      TOPBAR_REVEAL_BUTTON_ID,
    } = await loadAutoHide();

    // When
    armTopbarAutoHide();

    // Then
    expect(topbar().getAttribute("aria-keyshortcuts")).toBe(
      TOPBAR_REVEAL_SHORTCUT,
    );

    // When
    pinTopbarVisible();

    // Then
    expect(topbar().hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(
      (document.getElementById(TOPBAR_REVEAL_BUTTON_ID) as HTMLElement).hidden,
    ).toBe(true);
  });
});

describe("topbar auto-hide motion and layout", () => {
  it("As a reduced-motion user, the bar skips the slide animation", async () => {
    // Given
    stubReducedMotion(true);
    const { armTopbarAutoHide } = await loadAutoHide();

    // When
    armTopbarAutoHide();
    vi.advanceTimersByTime(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
    expect(topbar().style.transition).toBe("none");
  });

  it("As a dotli integrator, motion stays on when nothing is reduced", async () => {
    // Given
    stubReducedMotion(false);
    const { armTopbarAutoHide } = await loadAutoHide();

    // When
    armTopbarAutoHide();

    // Then
    expect(topbar().style.transition).toContain("transform");
  });

  it("As a dApp user, revealing the bar never resizes the app frame", async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    const hiddenTop = appFrame().style.top;
    const hiddenHeight = appFrame().style.height;

    // When
    focusElement(document.getElementById("topbar-home") as HTMLElement);

    // Then the frame keeps the full viewport, so the product never relayouts
    expect(isHidden()).toBe(false);
    expect(appFrame().style.top).toBe(hiddenTop);
    expect(appFrame().style.height).toBe(hiddenHeight);
    expect(hiddenTop).toBe("0px");
    expect(hiddenHeight).toBe("100vh");
  });

  it("As a dotli integrator, a re-rendered product frame keeps the hidden-bar geometry", async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    vi.advanceTimersByTime(HIDE_DELAY_MS);

    // When a new render restyles the frame with the topbar offset
    appFrame().style.top = "56px";
    appFrame().style.height = "calc(100vh - 56px)";
    window.dispatchEvent(
      new CustomEvent("dotli:product-loaded", { detail: { label: "demo" } }),
    );

    // Then
    expect(appFrame().style.top).toBe("0px");
    expect(appFrame().style.height).toBe("100vh");
  });

  it("As a logged-out user, the bar is pinned and the app frame makes room for it", async () => {
    // Given
    const { armTopbarAutoHide, pinTopbarVisible } = await loadAutoHide();
    armTopbarAutoHide();
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(isHidden()).toBe(true);

    // When
    document.querySelector(".user-badge")?.remove();
    pinTopbarVisible();
    vi.advanceTimersByTime(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
    expect(appFrame().style.top).toBe("56px");
    expect(appFrame().style.height).toBe("calc(100vh - 56px)");
  });
});
