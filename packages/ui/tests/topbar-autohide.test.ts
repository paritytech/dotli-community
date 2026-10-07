import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TopbarAutohideModule from '../src/topbar-autohide.js';
import type * as TopbarSurfacesModule from '../src/state/topbar-surfaces.js';
import { byId } from './support.js';
import { stubPhoneViewport } from './helpers/viewport.js';

// happy-dom rejects var() inside calc() and drops a bare dvh length, so the
// box helper is mocked with plain stand-in values here. The real inset math and
// units are covered by product-iframe-box tests.
vi.mock('../src/product-iframe-box.js', () => ({
  productIframeBox: (opts: { topbarOffset: boolean }) =>
    opts.topbarOffset
      ? {
          top: '56px',
          left: '0px',
          width: '100%',
          height: 'calc(100dvh - 56px)',
        }
      : { top: '0px', left: '0px', width: '100%', height: '100vh' },
}));

const device = vi.hoisted(() => ({ mobile: false }));

vi.mock('../../shared/src/device.js', () => ({
  isMobileDevice: () => device.mobile,
}));

const HIDE_DELAY_MS = 2500;

const SHORTCUT = { code: 'KeyT', altKey: true, shiftKey: true, bubbles: true };

// Shaped like the host page (apps/host/src/pages/index.astro): the bar
// (components/Topbar.astro, its action group down to the account and settings buttons),
// the app with its product frame, then the reveal control and the toasts.
function installPageDom(): void {
  document.body.innerHTML = `
    <div id="topbar">
      <a id="topbar-home" href="/">Home</a>
      <div id="topbar-url" hidden></div>
      <div id="topbar-actions"><button id="auth-button">Login</button><button id="mode-button">Settings</button></div>
    </div>
    <div id="app">
      <iframe id="app-frame" style="position:fixed;top:56px;height:calc(100dvh - 56px)"></iframe>
    </div>
    <div id="reveal-slot"></div>
    <a id="toast" href="/">a toast that also lives after the app</a>
  `;
}

function appFrame(): HTMLIFrameElement {
  return byId('app-frame', HTMLIFrameElement);
}

function topbar(): HTMLElement {
  return byId('topbar');
}

/** Hidden as the topbar store says, which the bar's script renders. */
let isHidden: () => boolean = () => false;

/** Applies the islands' batched Solid updates (the current module graph's). */
let flushUi: () => void = () => undefined;

/** happy-dom does not raise focusin from focus(), so drive it explicitly. */
function focusElement(el: HTMLElement): void {
  el.focus();
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  flushUi();
}

/** Let the timers run, then render what they changed. */
function advance(ms: number): void {
  vi.advanceTimersByTime(ms);
  flushUi();
}

function pressShortcut(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', SHORTCUT));
  flushUi();
}

/** The window's width: a phone's or a desktop's (see stubPhoneViewport). */
let viewport: ReturnType<typeof stubPhoneViewport>;

/** Resize the window across the phone width, then render what changed. */
function setPhone(phone: boolean): void {
  viewport.set(phone);
  flushUi();
}

/** A popover of the bar, as FloatingLayer registers it, open or not. */
interface StandInSurface {
  element: HTMLElement;
  open: boolean;
}

// Each test imports a fresh module graph, so the previous one has to drop
// its document listeners and its islands or they keep acting on the DOM.
const disposers: (() => void)[] = [];
let surfaces: typeof TopbarSurfacesModule;

/** Register a stand-in surface, rendered outside `#topbar` like a portal. */
function surface(open = false): StandInSurface {
  const element = document.createElement('div');
  document.body.append(element);
  const stand: StandInSurface = { element, open };
  disposers.push(surfaces.registerTopbarSurface({ element: () => stand.element, open: () => stand.open }));
  return stand;
}

async function loadAutoHide(loggedIn = true, contentShown = true): Promise<typeof TopbarAutohideModule> {
  // As the auth controller records it (state/auth.ts).
  const { setLoggedIn } = await import('../src/state/auth.js');
  setLoggedIn(loggedIn);
  // The host page has the topbar (initTopBar says so).
  const { setTopbarPresent } = await import('../src/state/topbar.js');
  setTopbarPresent();
  // The bridge hands each rendered product frame to the layout module.
  const { attachProductFrame } = await import('../src/product-frame-layout.js');
  attachProductFrame(appFrame());
  surfaces = await import('../src/state/topbar-surfaces.js');
  const mod = await import('../src/topbar-autohide.js');
  disposers.push(mod.disposeTopbarAutoHide);
  // The product's content is on screen, as the host reports once the sandbox has loaded it.
  if (contentShown) {
    mod.setProductContentShown(true);
  }

  // The bar registers its element, as its script does on the host page
  // (apps/host/src/components/Topbar.astro).
  disposers.push(mod.registerTopbarElement(topbar()));
  const { getTopbarState } = await import('../src/state/topbar.js');
  isHidden = () => !getTopbarState().visible;
  // The TopbarReveal island, from this module graph. Built without JSX: this
  // file's JSX would bind to the Solid instance loaded before resetModules.
  const solid = await import('solid-js');
  const web = await import('@solidjs/web');
  const { TopbarReveal } = await import('../src/components/shell/TopbarReveal.js');
  disposers.push(web.render(() => solid.createComponent(TopbarReveal, {}), byId('reveal-slot')));
  flushUi = solid.flush;
  flushUi();
  return mod;
}

beforeEach(() => {
  device.mobile = false;
  vi.resetModules();
  vi.unstubAllGlobals();
  viewport = stubPhoneViewport(false);
  vi.useFakeTimers();
  installPageDom();
});

afterEach(() => {
  // Before the body goes: the bar's popovers are portaled into it.
  for (const dispose of disposers.splice(0).reverse()) {
    dispose();
  }
  flushUi = () => undefined;
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('topbar auto-hide reveal', () => {
  it('As a user who just logged in, the bar arms from the session before the badge renders', async () => {
    // Given: the account button renders no badge here; the session store
    // alone says the user is in.
    const { armTopbarAutoHide } = await loadAutoHide();

    // When
    armTopbarAutoHide();
    flushUi();
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a dotli integrator, the host hides the bar once the session settles', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();

    // When
    armTopbarAutoHide();
    flushUi();
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a keyboard user, tabbing into the hidden bar brings it back', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();
    advance(HIDE_DELAY_MS);
    expect(isHidden()).toBe(true);

    // When
    focusElement(byId('topbar-home'));

    // Then
    expect(isHidden()).toBe(false);

    // When focus stays in the bar, the hide timer must not fire
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
  });

  it('As a keyboard user, leaving the bar re-arms the hide timer', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();
    focusElement(byId('mode-button'));
    expect(isHidden()).toBe(false);

    // When
    focusElement(appFrame());
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a keyboard user, the bar stays up while its settings popover is open', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();

    // When
    const settings = surface(true);
    advance(HIDE_DELAY_MS * 3);

    // Then
    expect(isHidden()).toBe(false);

    // When the popover closes, the bar hides again
    settings.open = false;
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a keyboard user, the bar stays up while the shield explainer is open', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();

    // When
    const explainer = surface(true);
    advance(HIDE_DELAY_MS * 3);

    // Then
    expect(isHidden()).toBe(false);

    // When the explainer closes, the bar hides again
    explainer.open = false;
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a keyboard user, the bar stays up while I read the open chains popover', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();
    const chains = surface(true);
    const row = document.createElement('button');
    chains.element.append(row);

    // When focus sits inside it, outside #topbar
    focusElement(row);
    advance(HIDE_DELAY_MS * 3);

    // Then
    expect(isHidden()).toBe(false);

    // When it closes and focus returns to the app, the bar hides again
    chains.open = false;
    focusElement(appFrame());
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a keyboard user, Alt+Shift+T leaves the bar under an open chains popover', async () => {
    // Given the bar is up and the chains popover is open
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();
    surface(true);

    // When
    pressShortcut();

    // Then the popover owns the moment, so the bar stays
    expect(isHidden()).toBe(false);
  });

  it('As a dotli integrator, disposing the auto-hide drops a queued focus check', async () => {
    // Given a focusout has queued its next-tick focus check
    const { armTopbarAutoHide, disposeTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();
    // Armed: the hide timer is pending, alongside timers owned by other modules.
    const armedTimers = vi.getTimerCount();
    document.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(vi.getTimerCount()).toBe(armedTimers + 1);

    // When
    disposeTopbarAutoHide();

    // Then both the hide timer and the queued focus check are gone
    expect(vi.getTimerCount()).toBe(armedTimers - 1);
  });

  it('As a keyboard user, Alt+Shift+T toggles the bar and moves focus with it', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();
    advance(HIDE_DELAY_MS);

    // When
    pressShortcut();

    // Then
    expect(isHidden()).toBe(false);
    expect(document.activeElement?.id).toBe('topbar-home');

    // When
    pressShortcut();

    // Then focus must not stay parked on the offscreen bar
    expect(isHidden()).toBe(true);
    expect(topbar().contains(document.activeElement)).toBe(false);
  });

  it('As a keyboard user, the reveal button sits after the app frame in tab order', async () => {
    // Given
    const { armTopbarAutoHide, TOPBAR_REVEAL_BUTTON_ID } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();
    advance(HIDE_DELAY_MS);
    const button = byId(TOPBAR_REVEAL_BUTTON_ID);

    // Then it is focusable and sits between the frame and the toasts, so one
    // forward Tab out of the dApp reaches it
    expect(button.tagName).toBe('BUTTON');
    expect(appFrame().compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(byId('toast').compareDocumentPosition(button) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

    // When
    button.focus();
    button.dispatchEvent(new FocusEvent('focus'));
    flushUi();

    // Then focus alone reveals the bar and holds it there
    expect(isHidden()).toBe(false);
    advance(HIDE_DELAY_MS * 2);
    expect(isHidden()).toBe(false);

    // When
    (button as HTMLButtonElement).click();
    flushUi();

    // Then
    expect(document.activeElement?.id).toBe('topbar-home');
  });

  it('As a dotli integrator, the reveal button shows only while the bar auto-hides', async () => {
    // Given
    const { armTopbarAutoHide, disposeTopbarAutoHide, TOPBAR_REVEAL_BUTTON_ID } = await loadAutoHide();

    // When
    armTopbarAutoHide();
    flushUi();

    // Then
    expect(byId(TOPBAR_REVEAL_BUTTON_ID).hidden).toBe(false);

    // When
    disposeTopbarAutoHide();
    flushUi();

    // Then
    expect(byId(TOPBAR_REVEAL_BUTTON_ID).hidden).toBe(true);
  });
});

describe('topbar auto-hide layout', () => {
  it('As a dApp user, once the bar folds into the capsule the app takes the full height and stays there when the pill comes back', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();

    // When
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
    expect(appFrame().style.top).toBe('0px');
    expect(appFrame().style.height).toBe('100vh');

    // When
    focusElement(byId('topbar-home'));
    advance(300);

    // Then: the pill floats over the app, which does not move
    expect(isHidden()).toBe(false);
    expect(appFrame().style.top).toBe('0px');
    expect(appFrame().style.height).toBe('100vh');
    expect(appFrame().style.transform).toBe('');
  });

  it('As a dotli integrator, a re-rendered product frame keeps the full-height geometry', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();
    advance(HIDE_DELAY_MS);

    // When
    const { attachProductFrame } = await import('../src/product-frame-layout.js');
    const frame = document.createElement('iframe');
    appFrame().replaceWith(frame);
    frame.id = 'app-frame';
    attachProductFrame(frame);

    // Then
    expect(appFrame().style.top).toBe('0px');
    expect(appFrame().style.height).toBe('100vh');
    expect(appFrame().style.transform).toBe('');
  });

  it("As a logged-out user, the bar folds into the capsule as anyone else's does, over the full-height app", async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide(false);

    // When
    armTopbarAutoHide();
    flushUi();
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
    expect(appFrame().style.top).toBe('0px');
    expect(appFrame().style.height).toBe('100vh');
  });

  it('As a dApp user, the app takes the full height under the pill before the bar first folds', async () => {
    // Given: the bar is up and not armed yet (the shield still settling)
    await loadAutoHide();

    // Then
    expect(isHidden()).toBe(false);
    expect(appFrame().style.top).toBe('0px');
    expect(appFrame().style.height).toBe('100vh');
  });
});

describe('topbar auto-hide over the product', () => {
  it("As a user on the loading screen, the bar stays up until the app's content shows, then folds", async () => {
    // Given
    const { armTopbarAutoHide, setProductContentShown } = await loadAutoHide(true, false);
    armTopbarAutoHide();
    flushUi();

    // When
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);

    // When
    setProductContentShown(true);
    flushUi();
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a user whose app fails to load, the folded bar comes back and stays over the error page', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();
    advance(HIDE_DELAY_MS);
    expect(isHidden()).toBe(true);

    // When
    const { setProductError } = await import('../src/state/product.js');
    setProductError();
    flushUi();
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
  });

  it('As a user whose app reports its own failure in the frame, the folded bar comes back and stays', async () => {
    // Given
    const { armTopbarAutoHide, setProductContentShown } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();
    advance(HIDE_DELAY_MS);
    expect(isHidden()).toBe(true);

    // When
    setProductContentShown(false);
    flushUi();
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
  });
});

describe('topbar auto-hide on use of the app', () => {
  /** A press or a Tab into the cross-origin frame: focus moves to it and this window blurs. */
  function pressIntoApp(): void {
    appFrame().focus();
    window.dispatchEvent(new FocusEvent('blur'));
    flushUi();
  }

  it('As a dApp user, pressing into the app folds the bar at once', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();

    // When
    pressIntoApp();
    advance(0);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a dApp user, pressing into the app while a popover of the bar is open leaves the bar up until it closes', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();
    const settings = surface(true);

    // When
    pressIntoApp();
    advance(0);

    // Then
    expect(isHidden()).toBe(false);

    // When
    settings.open = false;
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a user on the loading screen, pressing into the frame leaves the bar up', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide(true, false);
    armTopbarAutoHide();
    flushUi();

    // When
    pressIntoApp();
    advance(0);

    // Then
    expect(isHidden()).toBe(false);
  });

  it('As a user switching to another window, the bar folds only after the usual delay', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();

    // When
    window.dispatchEvent(new FocusEvent('blur'));
    advance(0);

    // Then
    expect(isHidden()).toBe(false);

    // When
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });
});

describe('topbar auto-hide on a phone', () => {
  it('As a tablet user, the bar never folds and the app starts below it, so the bar never covers the app', async () => {
    // Given: a touch device at a desktop width, where auto-hide never arms
    device.mobile = true;
    const { armTopbarAutoHide } = await loadAutoHide();

    // When
    armTopbarAutoHide();
    flushUi();
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
    expect(appFrame().style.top).toBe('56px');
  });

  it('As a phone user, the bar never folds away, and the app keeps clear of it', async () => {
    // Given
    viewport.set(true);
    const { armTopbarAutoHide } = await loadAutoHide();

    // When
    armTopbarAutoHide();
    flushUi();
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
    expect(appFrame().style.top).toBe('56px');
  });

  it('As a user narrowing the window to a phone width, the folded bar comes back as the phone bar, the app keeps clear of it, and widening folds it again', async () => {
    // Given
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();
    advance(HIDE_DELAY_MS);
    expect(isHidden()).toBe(true);
    expect(appFrame().style.top).toBe('0px');

    // When
    setPhone(true);
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
    expect(appFrame().style.top).toBe('56px');

    // When
    setPhone(false);
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
    expect(appFrame().style.top).toBe('0px');
  });

  it('As a keyboard user on a phone-width window, Alt+Shift+T leaves the header where it is', async () => {
    // Given
    viewport.set(true);
    const { armTopbarAutoHide } = await loadAutoHide();
    armTopbarAutoHide();
    flushUi();

    // When
    pressShortcut();
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(false);
  });
});
