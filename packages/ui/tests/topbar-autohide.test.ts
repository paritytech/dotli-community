import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TopbarAutohideModule from "../src/topbar-autohide.js";
import { byId } from "./support.js";

// happy-dom rejects var() inside calc() and drops a bare dvh length, so the
// box helper is mocked with plain stand-in values here. The real inset math and
// units are covered by product-iframe-box tests.
vi.mock("../src/product-iframe-box.js", () => ({
  productIframeBox: (opts: { topbarOffset: boolean }) =>
    opts.topbarOffset
      ? {
          top: "56px",
          left: "0px",
          width: "100%",
          height: "calc(100dvh - 56px)",
        }
      : { top: "0px", left: "0px", width: "100%", height: "100vh" },
}));

const HIDE_DELAY_MS = 5000;

function installTopbarDom(): void {
  document.body.innerHTML = `
    <div id="topbar" role="banner">
      <a id="topbar-home" href="/"></a>
      <button id="permissions-button"></button>
      <button id="mode-button"></button>
      <button id="auth-button"><div class="user-badge">RS</div></button>
      <div class="more-popover" id="more-popover"></div>
      <div class="verification-tooltip" id="verification-tooltip"></div>
    </div>
    <div class="user-popover" id="user-popover"></div>
    <div class="mode-popover" id="mode-popover"></div>
    <div class="permissions-popover" id="permissions-popover"></div>
    <div class="auth-modal-backdrop" id="auth-modal-backdrop"></div>
    <div class="more-popover chains-popover" id="chains-popover"><button id="chains-row">row</button></div>
    <div id="app">
      <iframe id="app-frame" style="position:fixed;top:56px;height:calc(100dvh - 56px)"></iframe>
    </div>
    <a id="toast" href="/">a toast that also lives after the app</a>
  `;
}

function appFrame(): HTMLIFrameElement {
  return byId("app-frame", HTMLIFrameElement);
}

function topbar(): HTMLElement {
  return byId("topbar");
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

async function loadAutoHide(): Promise<typeof TopbarAutohideModule> {
  // Logged in, as the auth controller records it (state/auth.ts).
  const { setLoggedIn } = await import("../src/state/auth.js");
  setLoggedIn(true);
  // The bridge hands each rendered product frame to the layout module.
  const { attachProductFrame } = await import("../src/product-frame-layout.js");
  attachProductFrame(appFrame());
  const mod = await import("../src/topbar-autohide.js");
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
  it("As a user who just logged in, the bar arms from the session before the badge renders", async () => {
    // Given: the auth button island renders the badge on Solid's next flush,
    // after the dotli:authenticated listener has armed the auto-hide.
    document.querySelector(".user-badge")?.remove();
    const { armTopbarAutoHide } = await loadAutoHide();

    // When
    armTopbarAutoHide();
    vi.advanceTimersByTime(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

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
    focusElement(byId("topbar-home"));

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
    focusElement(byId("mode-button"));
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

  it("As a keyboard user, the bar stays up while the shield explainer is open", async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();

    // When
    document.getElementById("verification-tooltip")?.classList.add("open");
    vi.advanceTimersByTime(HIDE_DELAY_MS * 3);

    // Then
    expect(isHidden()).toBe(false);

    // When the explainer closes, the bar hides again
    document.getElementById("verification-tooltip")?.classList.remove("open");
    vi.advanceTimersByTime(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it("As a keyboard user, the bar stays up while I read the open chains popover", async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    const chains = byId("chains-popover");
    chains.classList.add("open");

    // When focus sits inside it, outside #topbar
    focusElement(byId("chains-row"));
    vi.advanceTimersByTime(HIDE_DELAY_MS * 3);

    // Then
    expect(isHidden()).toBe(false);

    // When it closes and focus returns to the app, the bar hides again
    chains.classList.remove("open");
    focusElement(appFrame());
    vi.advanceTimersByTime(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it("As a keyboard user, Alt+Shift+T leaves the bar under an open chains popover", async () => {
    // Given the bar is up and the chains popover is open
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    document.getElementById("chains-popover")?.classList.add("open");

    // When
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyT",
        altKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );

    // Then the popover owns the moment, so the bar stays
    expect(isHidden()).toBe(false);
  });

  it("As a dotli integrator, pinning the bar drops a queued focus check", async () => {
    // Given a focusout has queued its next-tick focus check
    const { armTopbarAutoHide, pinTopbarVisible } = await loadAutoHide();
    armTopbarAutoHide();
    // Armed: the hide timer is pending, alongside timers owned by other modules.
    const armedTimers = vi.getTimerCount();
    document.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(vi.getTimerCount()).toBe(armedTimers + 1);

    // When
    pinTopbarVisible();

    // Then both the hide timer and the queued focus check are gone
    expect(vi.getTimerCount()).toBe(armedTimers - 1);
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
    const button = byId(TOPBAR_REVEAL_BUTTON_ID);

    // Then it is focusable and sits between the frame and the toasts, so one
    // forward Tab out of the dApp reaches it
    expect(button.tagName).toBe("BUTTON");
    expect(
      appFrame().compareDocumentPosition(button) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      byId("toast").compareDocumentPosition(button) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();

    // When
    button.focus();
    button.dispatchEvent(new FocusEvent("focus"));

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
    expect(byId(TOPBAR_REVEAL_BUTTON_ID).hidden).toBe(true);
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

  it("As a dApp user, revealing the bar shifts the app below it without resizing it", async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    const hiddenTop = appFrame().style.top;
    const hiddenHeight = appFrame().style.height;
    expect(appFrame().style.transform).toBe("translateY(0)");

    // When
    focusElement(byId("topbar-home"));

    // Then the layout box is untouched (no relayout) and a transform moves
    // the frame under the bar, so the app's top content is never covered
    expect(isHidden()).toBe(false);
    expect(appFrame().style.top).toBe(hiddenTop);
    expect(appFrame().style.height).toBe(hiddenHeight);
    expect(hiddenTop).toBe("0px");
    expect(hiddenHeight).toBe("100vh");
    expect(appFrame().style.transform).toBe(
      "translateY(calc(var(--topbar-height, 56px) - var(--safe-top, 0px)))",
    );
  });

  it("As a reduced-motion user, the app frame follows the bar without a slide", async () => {
    // Given
    stubReducedMotion(true);
    const { armTopbarAutoHide } = await loadAutoHide();

    // When
    armTopbarAutoHide();
    vi.advanceTimersByTime(HIDE_DELAY_MS);

    // Then
    expect(appFrame().style.transform).toBe("translateY(0)");
    expect(appFrame().style.transition).toBe("none");
  });

  it("As a dotli integrator, a re-rendered product frame keeps the hidden-bar geometry", async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    vi.advanceTimersByTime(HIDE_DELAY_MS);

    // When a new render hands the layout module a fresh frame
    const { attachProductFrame } =
      await import("../src/product-frame-layout.js");
    const frame = document.createElement("iframe");
    appFrame().replaceWith(frame);
    frame.id = "app-frame";
    attachProductFrame(frame);

    // Then
    expect(appFrame().style.top).toBe("0px");
    expect(appFrame().style.height).toBe("100vh");
    expect(appFrame().style.transform).toBe("translateY(0)");
    expect(appFrame().style.transition).toContain("transform");
  });

  it("As a logged-out user, the bar is pinned and the app frame makes room for it", async () => {
    // Given
    const { armTopbarAutoHide, pinTopbarVisible } = await loadAutoHide();
    armTopbarAutoHide();
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(isHidden()).toBe(true);

    // When
    const { setLoggedIn } = await import("../src/state/auth.js");
    setLoggedIn(false);
    document.querySelector(".user-badge")?.remove();
    pinTopbarVisible();
    vi.advanceTimersByTime(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
    expect(appFrame().style.top).toBe("56px");
    expect(appFrame().style.height).toBe("calc(100dvh - 56px)");
    expect(appFrame().style.transform).toBe("");
  });
});
