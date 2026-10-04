// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthButton } from '../../../src/components/shell/AuthButton.js';
import { AuthModal } from '../../../src/components/shell/AuthModal.js';
import { setAuthState } from '../../../src/state/auth.js';
import { updateAuthModal } from '../../../src/state/auth-modal.js';
import { setBlockingModalActive } from '../../../src/state/topbar.js';
import { ThemeToggle } from '../../../src/components/shell/ThemeToggle.js';
import type { DotliAuthState } from '../../../src/host-callbacks/AuthState.js';
import { mouseClick, pointerPress, renderComponent } from '../../helpers/solid.js';
import {
  byId,
  coordinator,
  expectQrSpinnerView,
  press,
  recordEvents,
  settleAll,
  useAuthController,
} from './auth-harness.js';
import type * as PopoverModule from '../../../src/components/shell/create-popover.js';
import { byTestId, query } from '../../support.js';
import { nth } from '../../helpers/nth.js';

const device = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../../../shared/src/device.js', () => ({
  isMobileDevice: () => device.mobile,
}));

// The lazy `qrcode` import, whose drawing each test can hold back.
type DrawQr = (canvas: HTMLCanvasElement, payload: string, options?: unknown) => Promise<void>;
const qr = vi.hoisted(() => ({
  toCanvas: vi.fn<DrawQr>(() => Promise.resolve()),
}));
vi.mock('qrcode', () => {
  return {
    default: {
      toCanvas: (...args: Parameters<DrawQr>): Promise<void> => qr.toCanvas(...args),
    },
  };
});

// Counts the auth modal's dialog `setOpen` calls: its popover is the only
// one in `dialog` mode here.
const dialogSetOpen = vi.hoisted(() => ({ calls: [] as boolean[] }));
vi.mock('../../../src/components/shell/create-popover.js', async importOriginal => {
  const actual = await importOriginal<typeof PopoverModule>();
  return {
    ...actual,
    createPopover: (options: Parameters<typeof actual.createPopover>[0]) => {
      const popover = actual.createPopover(options);
      if (options.mode !== 'dialog') {
        return popover;
      }
      return {
        ...popover,
        setOpen: (next: boolean) => {
          dialogSetOpen.calls.push(next);
          popover.setOpen(next);
        },
      };
    },
  };
});

useAuthController();

beforeEach(() => {
  device.mobile = false;
  dialogSetOpen.calls = [];
  qr.toCanvas = vi.fn<DrawQr>(() => Promise.resolve());
});

const DEEPLINK = 'polkadotapp://pair?handshake=test';
const DESKTOP_HINT = 'Scan with Polkadot Mobile to connect';
const MOBILE_HINT = 'Sign in with the Polkadot app on this device';

/** The modal and the auth button (focus goes back to it on close). */
async function renderModal(): Promise<HTMLElement> {
  renderComponent(() => (
    <div>
      <AuthButton />
      <AuthModal />
      <button id="outside" type="button">
        Outside
      </button>
    </div>
  ));
  await settleQr();
  return byId('auth-modal-backdrop');
}

/** Wait out the lazy qrcode import and drawing, then Solid's updates. */
async function settleQr(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await settleAll();
  }
}

async function authState(state: DotliAuthState): Promise<void> {
  setAuthState(state);
  await settleQr();
}

function pairing(extra: Partial<DotliAuthState> = {}): DotliAuthState {
  return {
    tag: 'Pairing',
    deeplink: DEEPLINK,
    label: 'localhost:3000',
    ...extra,
  } as DotliAuthState;
}

function isOpen(): boolean {
  return byId('auth-modal-backdrop').hasAttribute('data-open');
}

function qrText(): string {
  return byId('auth-modal-qr').textContent;
}

type ModalBody =
  | { kind: 'empty' }
  | { kind: 'spinner' }
  | { kind: 'canvas'; payload: string }
  | { kind: 'mobile-qr'; payload: string; qrShown: boolean }
  | { kind: 'authenticating' }
  | { kind: 'error'; title: string; subtitle: string; detail?: string; retry: boolean };

interface ModalExpectation {
  open: boolean;
  productLabel?: string;
  reason?: string;
  hint: string;
  getAppHidden: boolean;
  body: ModalBody;
}

const tags = (el: Element): string[] => Array.from(el.children).map(child => child.tagName);

/** The drawn code on its tile: the canvas, named as an image, then the badge. */
function expectQrTile(tile: Element, payload: string): void {
  expect(tags(tile)).toEqual(['CANVAS', 'SPAN']);
  const canvas = nth(tile.children, 0) as HTMLElement;
  expect(canvas.dataset['qrPayload']).toBe(payload);
  expect(canvas.getAttribute('role')).toBe('img');
  expect(canvas.getAttribute('aria-label')).toBe('Sign-in QR code');
  expect(tile.children[1]?.getAttribute('aria-hidden')).toBe('true');
}

/** The QR container's content for each view the modal can show. */
function expectQrBody(qrBox: Element, body: ModalBody): void {
  switch (body.kind) {
    case 'empty':
      expect(qrBox.childNodes).toHaveLength(0);
      break;
    case 'spinner':
      expectQrSpinnerView();
      break;
    case 'canvas': {
      expect(tags(qrBox)).toEqual(['DIV', 'P']);
      expectQrTile(byTestId('auth-modal-qr-tile', qrBox), body.payload);
      expect(byTestId('auth-modal-waiting', qrBox).textContent).toBe('Waiting for your phone');
      break;
    }
    case 'mobile-qr': {
      const openApp = byTestId('auth-modal-open-app', qrBox, HTMLAnchorElement);
      expect(openApp.getAttribute('href')).toBe(body.payload);
      expect(openApp.textContent).toBe('Login With Polkadot App');
      if (body.qrShown) {
        // The QR on top, the deeplink demoted to a link under it, the toggle gone.
        expect(tags(qrBox)).toEqual(['A', 'P', 'A']);
        const qrLink = byTestId('auth-modal-qr-link', qrBox, HTMLAnchorElement);
        expect(qrLink.getAttribute('href')).toBe(body.payload);
        expectQrTile(qrLink, body.payload);
        expect(byTestId('auth-modal-waiting', qrBox).textContent).toBe('Waiting for your phone');
        expect(qrBox.lastElementChild).toBe(openApp);
        expect(qrBox.querySelector('[data-testid="auth-modal-qr-toggle"]')).toBeNull();
      } else {
        // The deeplink leads, then the toggle, and no QR yet.
        expect(tags(qrBox)).toEqual(['A', 'BUTTON']);
        expect(qrBox.firstElementChild).toBe(openApp);
        const toggle = byTestId('auth-modal-qr-toggle', qrBox, HTMLButtonElement);
        expect(toggle.type).toBe('button');
        expect(toggle.textContent).toBe('Show QR instead');
        expect(qrBox.querySelector('canvas')).toBeNull();
      }
      break;
    }
    case 'authenticating': {
      expect(tags(qrBox)).toEqual(['DIV']);
      const progress = nth(qrBox.children, 0);
      expect(tags(progress)).toEqual(['DIV', 'P']);
      byTestId('auth-modal-spinner', progress);
      expect(progress.children[1]?.textContent).toBe('Logging in...');
      break;
    }
    case 'error': {
      expect(tags(qrBox)).toEqual(['DIV']);
      const view = nth(qrBox.children, 0);
      const expectedTags = ['DIV', 'DIV', 'DIV'];
      if (body.detail !== undefined && body.detail.length > 0) {
        expectedTags.push('DIV');
      }
      if (body.retry) {
        expectedTags.push('BUTTON');
      }
      expect(tags(view)).toEqual(expectedTags);
      expect(view.children[0]?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(view.children[1]?.textContent).toBe(body.title);
      expect(view.children[2]?.textContent).toBe(body.subtitle);
      if (body.detail !== undefined && body.detail.length > 0) {
        expect(view.children[3]?.textContent).toBe(body.detail);
      }
      if (body.retry) {
        const retry = view.lastElementChild as HTMLButtonElement;
        expect(retry.tagName).toBe('BUTTON');
        expect(retry.textContent).toBe('Retry');
      }
      break;
    }
  }
}

/**
 * The surface apart from styling: the dialog ARIA, the head and the body in
 * order with their ids and text, the visibility of the reason and the get-app
 * link, and the QR container's view.
 */
function expectMarkup(backdrop: Element, opts: ModalExpectation): void {
  expect(backdrop.id).toBe('auth-modal-backdrop');
  expect(backdrop.getAttribute('role')).toBe('dialog');
  expect(backdrop.getAttribute('aria-modal')).toBe('true');
  expect(backdrop.getAttribute('aria-labelledby')).toBe('auth-modal-title');
  expect(backdrop.getAttribute('tabindex')).toBe('-1');
  expect(backdrop.hasAttribute('data-open')).toBe(opts.open);
  expect(tags(backdrop)).toEqual(['SECTION']);
  const surface = nth(backdrop.children, 0);
  expect(Array.from(surface.children).map(child => `${child.tagName}#${child.id}`)).toEqual([
    'DIV#',
    'DIV#auth-modal-qr',
    'A#auth-modal-get-app',
    'BUTTON#auth-modal-close',
  ]);
  const head = nth(surface.children, 0);
  expect(Array.from(head.children).map(child => `${child.tagName}#${child.id}`)).toEqual([
    'H2#auth-modal-title',
    'P#auth-modal-reason',
    'P#auth-modal-hint',
  ]);
  expect(byId('auth-modal-title').textContent).toBe(
    opts.productLabel !== undefined ? `${opts.productLabel} wants you to sign in` : 'Login with Polkadot Mobile',
  );
  const reason = byId('auth-modal-reason');
  expect(reason.hidden).toBe(opts.reason === undefined);
  expect(reason.textContent).toBe(opts.reason ?? '');
  expect(byId('auth-modal-hint').textContent).toBe(opts.hint);
  const getApp = byId('auth-modal-get-app', HTMLAnchorElement);
  expect(getApp.hidden).toBe(opts.getAppHidden);
  expect(getApp.getAttribute('href')).toBe('https://docs.polkadot.com/apps/');
  expect(getApp.getAttribute('target')).toBe('_blank');
  expect(getApp.getAttribute('rel')).toBe('noopener noreferrer');
  expect(getApp.textContent).toBe("Don't have the app? Get Polkadot Mobile");
  expect(byId('auth-modal-close').textContent).toBe('Cancel');
  expectQrBody(byId('auth-modal-qr'), opts.body);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('AuthModal markup', () => {
  it('As a dotli user, the closed modal has its dialog ids, labels and ARIA state, empty', async () => {
    // When
    const backdrop = await renderModal();

    // Then
    expect(backdrop.getAttribute('role')).toBe('dialog');
    expect(backdrop.getAttribute('aria-modal')).toBe('true');
    expect(backdrop.getAttribute('aria-labelledby')).toBe('auth-modal-title');
    expectMarkup(backdrop, {
      open: false,
      hint: DESKTOP_HINT,
      getAppHidden: true,
      body: { kind: 'empty' },
    });
  });

  it('As a desktop user, the login modal opens on the spinner, then shows the QR code', async () => {
    // Given
    const backdrop = await renderModal();

    // When
    byId('auth-button').click();
    await settleQr();

    // Then
    expectMarkup(backdrop, {
      open: true,
      hint: DESKTOP_HINT,
      getAppHidden: true,
      body: { kind: 'spinner' },
    });

    // When
    await authState(pairing({ dotSuffix: false, label: 'app.dot' }));

    // Then
    expect(qr.toCanvas).toHaveBeenCalledTimes(1);
    expect(qr.toCanvas).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), DEEPLINK, {
      width: 248,
      margin: 2,
      errorCorrectionLevel: 'Q',
      color: { dark: '#000000', light: '#ffffff' },
    });
    expectMarkup(backdrop, {
      open: true,
      productLabel: 'app.dot',
      hint: DESKTOP_HINT,
      getAppHidden: true,
      body: { kind: 'canvas', payload: DEEPLINK },
    });
    expect(document.querySelector('#auth-modal-qr canvas')).toBe(qr.toCanvas.mock.calls[0]?.[0]);
  });

  it('As a user asked to sign in by a product, the title names it and shows why, as text', async () => {
    // Given
    const backdrop = await renderModal();

    // When
    window.dispatchEvent(
      new CustomEvent('dotli:request-login', {
        detail: { reason: '<i>to vote</i>', label: 'localhost:<b>x</b>' },
      }),
    );
    await settleQr();

    // Then
    expect(byId('auth-modal-title').querySelector('b')).toBeNull();
    expect(byId('auth-modal-title').textContent).toBe('localhost:<b>x</b> wants you to sign in');
    expect(byId('auth-modal-reason').textContent).toBe('<i>to vote</i>');
    expectMarkup(backdrop, {
      open: true,
      productLabel: 'localhost:<b>x</b>',
      reason: '<i>to vote</i>',
      hint: DESKTOP_HINT,
      getAppHidden: true,
      body: { kind: 'spinner' },
    });
  });

  it('As a dotli integrator, the host replaces the pairing QR with login progress after wallet approval', async () => {
    // Given
    const backdrop = await renderModal();
    await authState(pairing({ hostGlobal: true }));

    // When
    await authState({ tag: 'Authenticating' });

    // Then
    expect(qrText()).toContain('Logging in...');
    byTestId('auth-modal-spinner', byId('auth-modal-qr'));
    expect(isOpen()).toBe(true);
    expectMarkup(backdrop, {
      open: true,
      hint: DESKTOP_HINT,
      getAppHidden: true,
      body: { kind: 'authenticating' },
    });
  });

  it('As a new user, a failed login shows the error view, and Retry starts over', async () => {
    // Given
    const loginRequests = recordEvents('dotli:truapi-login-request');
    const backdrop = await renderModal();

    // When
    await authState({
      tag: 'LoginFailed',
      kind: 'Other',
      reason: 'Host failure',
    });

    // Then
    expectMarkup(backdrop, {
      open: true,
      hint: DESKTOP_HINT,
      getAppHidden: true,
      body: {
        kind: 'error',
        title: 'Login did not complete',
        subtitle:
          'Something interrupted the connection to Polkadot Mobile. Try again, and make sure the app is installed and up to date.',
        detail: 'Host failure',
        retry: true,
      },
    });

    // When
    byTestId('auth-modal-retry', document).click();
    await settleQr();

    // Then
    expect(loginRequests.details).toEqual([{ reason: undefined }]);
    expect(isOpen()).toBe(true);
    expectQrSpinnerView();
  });

  it('As a new user whose account is still being set up, the error view hides the raw reason', async () => {
    // Given
    const backdrop = await renderModal();

    // When
    await authState({
      tag: 'LoginFailed',
      kind: 'Other',
      reason: 'OriginPersonProviderError',
    });

    // Then
    expectMarkup(backdrop, {
      open: true,
      hint: DESKTOP_HINT,
      getAppHidden: true,
      body: {
        kind: 'error',
        title: 'Your account is still being set up',
        subtitle: 'Please try again later',
        retry: true,
      },
    });
  });
});

describe('AuthModal login flow', () => {
  it('As a dotli integrator, the host waits for an active TrUAPI prompt before opening login', async () => {
    // Given
    await renderModal();
    const scope = coordinator.createScope();
    const { promise: held, resolve: releaseBlockingPrompt }: PromiseWithResolvers<void> = Promise.withResolvers();
    const blockingPrompt = scope.enqueue(() => held);

    // When
    byId('auth-button').click();
    await settleQr();

    // Then
    expect(isOpen()).toBe(false);

    // When
    releaseBlockingPrompt();
    await blockingPrompt;
    await settleQr();

    // Then
    expect(isOpen()).toBe(true);

    byId('auth-modal-close').click();
    scope.dispose();
  });

  it('As a dotli integrator, the host opens host-global login from the topbar even when a product is loaded', async () => {
    // Given
    const loginRequests = recordEvents('dotli:truapi-login-request');
    await renderModal();

    // When
    window.dispatchEvent(
      new CustomEvent('dotli:product-loaded', {
        detail: { label: 'localhost:3000' },
      }),
    );
    byId('auth-button').click();
    await settleQr();

    // Then
    expect(byId('auth-modal-title').textContent).toBe('Login with Polkadot Mobile');
    expect(loginRequests.details).toEqual([{ reason: undefined }]);
  });

  it('As a dotli integrator, the host keeps the pairing modal open through an unrelated disconnected state', async () => {
    // Given
    await renderModal();

    // When
    await authState(pairing({ label: 'Polkadot Web', dotSuffix: false, hostGlobal: true }));
    // A bare disconnected state (e.g. a product core clearing its session)
    // must only update the badge, never tear down the pairing modal.
    await authState({ tag: 'Disconnected' });

    // Then
    expect(isOpen()).toBe(true);
  });

  it('As a dotli integrator, the host keeps landing pairing presentation host-global', async () => {
    // Given
    await renderModal();

    // When
    await authState(pairing({ label: 'Polkadot Web', dotSuffix: false, hostGlobal: true }));

    // Then
    expect(byId('auth-modal-title').textContent).toBe('Login with Polkadot Mobile');
  });

  it('As a dotli integrator, the host cancels the in-flight login when the user closes the pairing modal', async () => {
    // Given
    const cancels = recordEvents('dotli:truapi-cancel-login');
    await renderModal();
    await authState(pairing());

    // When
    byId('auth-modal-close').click();
    await settleQr();

    // Then
    expect(cancels.details).toHaveLength(1);
    expect(isOpen()).toBe(false);
    expect(byId('auth-modal-qr').children).toHaveLength(0);
  });

  it('As a user, a click on the backdrop itself closes the modal, and a click inside it does not', async () => {
    // Given
    const cancels = recordEvents('dotli:truapi-cancel-login');
    await renderModal();
    await authState(pairing());

    // When
    byId('auth-modal-title').click();
    await settleQr();

    // Then
    expect(isOpen()).toBe(true);

    // When
    byId('auth-modal-backdrop').click();
    await settleQr();

    // Then
    expect(isOpen()).toBe(false);
    expect(cancels.details).toHaveLength(1);
  });

  it('As a dotli integrator, the host cancels the in-flight login when Escape closes the pairing modal', async () => {
    // Given
    const cancels = recordEvents('dotli:truapi-cancel-login');
    await renderModal();

    // When
    await authState(pairing());

    // Then
    expect(isOpen()).toBe(true);

    // When
    press('Escape');
    await settleQr();

    // Then
    expect(isOpen()).toBe(false);
    expect(cancels.details).toHaveLength(1);
    expect(document.activeElement).toBe(byId('auth-button'));
  });

  it('As a keyboard user, Tab and Shift+Tab stay inside the open modal', async () => {
    // Given: Retry is the first control and Cancel the last. The get-app link
    // is hidden on desktop, so it takes no part.
    await renderModal();
    await authState({ tag: 'LoginFailed', kind: 'Other', reason: 'Host failure' });
    byId('auth-modal-close').focus();

    // When
    const tab = press('Tab');

    // Then: it wraps to the modal's first control.
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byTestId('auth-modal-retry', document));

    // When: focus somehow left the modal.
    byId('outside').focus();
    const shiftTab = press('Tab', { shiftKey: true });

    // Then
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId('auth-modal-close'));
  });

  it('As a keyboard user, the open modal focuses its first control, not a link, as a Radix Dialog does', async () => {
    // Given
    await renderModal();
    byId('auth-button').focus();

    // When
    await authState(pairing());

    // Then: the get-app link is hidden on desktop, and the QR (a canvas)
    // takes no focus, so Cancel is the first control.
    expect(document.activeElement).toBe(byId('auth-modal-close'));
  });

  it('As a user, the page does not scroll behind the open modal, and scrolls again once it closes', async () => {
    // Given
    document.body.style.overflow = 'auto';
    await renderModal();

    // When
    await authState(pairing());

    // Then
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(true);

    // When
    byId('auth-modal-close').click();
    await settleQr();

    // Then
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false);
    expect(document.body.style.overflow).toBe('auto');
    document.body.style.overflow = '';
  });

  it('As a user who opened the modal while a product was loading, the overflow the product frame hides as it attaches stays hidden once the modal closes', async () => {
    // Given
    await renderModal();
    await authState(pairing());
    expect(isOpen()).toBe(true);

    // When: the product frame attaches, and bridge.ts hides the body's
    // overflow; then the modal closes.
    document.body.style.overflow = 'hidden';
    byId('auth-modal-close').click();
    await settleQr();

    // Then
    expect(isOpen()).toBe(false);
    expect(document.body.style.overflow).toBe('hidden');
    document.body.style.overflow = '';
  });

  it('As a user, a press outside the modal (neither its backdrop nor the auth button) closes it and cancels the login', async () => {
    // Given
    const cancels = recordEvents('dotli:truapi-cancel-login');
    await renderModal();
    await authState(pairing());
    expect(isOpen()).toBe(true);

    // When: something above the backdrop, outside it, is pressed.
    pointerPress(byId('outside'));
    await settleQr();

    // Then
    expect(isOpen()).toBe(false);
    expect(cancels.details).toHaveLength(1);
  });

  it('As a keyboard user, Retry keeps focus in the modal while the error view it sat in goes away', async () => {
    // Given
    await renderModal();
    await authState({
      tag: 'LoginFailed',
      kind: 'Other',
      reason: 'Host failure',
    });
    const retry = byTestId('auth-modal-retry', document);
    retry.focus();
    expect(document.activeElement).toBe(retry);

    // When
    retry.click();
    await settleQr();

    // Then: the button is gone, and focus is on the modal, not the body.
    expect(retry.isConnected).toBe(false);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(byId('auth-modal-backdrop'));
  });

  it('As a user, the modal stays open, focused and trapping Tab through its own blocking-modal lease, while the theme menu closes for it', async () => {
    // Given: the theme menu is open when a product asks for a login.
    renderComponent(() => <ThemeToggle />);
    await renderModal();
    mouseClick(byId('theme-toggle'));
    await settleQr();
    expect(byId('theme-popover').hasAttribute('data-open')).toBe(true);

    // When: the controller takes the lease, which marks a blocking modal up.
    await authState(pairing());
    setBlockingModalActive(true);
    await settleQr();

    // Then
    expect(byId('theme-popover').hasAttribute('data-open')).toBe(false);
    expect(isOpen()).toBe(true);
    expect(byId('auth-modal-backdrop').contains(document.activeElement)).toBe(true);
    byId('auth-modal-close').focus();
    const tab = press('Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(byId('auth-modal-backdrop').contains(document.activeElement)).toBe(true);
    setBlockingModalActive(false);
  });

  it('As a user, when my login completes the modal closes and focus goes back to the auth button', async () => {
    // Given
    await renderModal();
    await authState(pairing());
    expect(byId('auth-modal-backdrop').contains(document.activeElement)).toBe(true);

    // When
    await authState({
      tag: 'Connected',
      session: { connected: true, liteUsername: 'pgherveou.04' },
    });

    // Then
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId('auth-button'));
  });

  it('As a dotli integrator, the host closes the pairing modal when the session connects', async () => {
    // Given
    const cancels = recordEvents('dotli:truapi-cancel-login');
    await renderModal();
    await authState(pairing());

    // When
    await authState({
      tag: 'Connected',
      session: { connected: true, liteUsername: 'pgherveou.04' },
    });

    // Then
    expect(isOpen()).toBe(false);
    expect(cancels.details).toHaveLength(0);
    expect(byId('auth-button').textContent).toBe('PG');
  });

  it('As a user whose login was requested before the islands loaded, the modal is open with the QR as it mounts', async () => {
    // Given: a product asked for a login at boot and the core paired.
    window.dispatchEvent(
      new CustomEvent('dotli:request-login', {
        detail: { label: 'localhost:3000' },
      }),
    );
    setAuthState(pairing());
    await settleQr();

    // When
    await renderModal();

    // Then
    expect(isOpen()).toBe(true);
    expect(byId('auth-modal-title').textContent).toBe('localhost:3000 wants you to sign in');
    expect(document.querySelector('#auth-modal-qr canvas')).not.toBeNull();
  });
});

describe('AuthModal QR', () => {
  it('As a user whose phone already scanned, a QR drawing that finishes late never replaces the login progress', async () => {
    // Given: the drawing is held back. (A late qrcode import itself is
    // covered by auth-modal-late-qr.test.tsx.)
    const drawing = deferred();
    qr.toCanvas = vi.fn<DrawQr>(() => drawing.promise);
    await renderModal();
    await authState(pairing());
    expectQrSpinnerView();

    // When: the wallet approved before the drawing finished.
    await authState({ tag: 'Authenticating' });
    drawing.resolve();
    await settleQr();

    // Then
    expect(document.querySelector('#auth-modal-qr canvas')).toBeNull();
    expect(qrText()).toContain('Logging in...');
  });

  it('As a user shown a new pairing code, only the newest QR is drawn in', async () => {
    // Given: the first code's drawing is held back.
    const first = deferred();
    qr.toCanvas = vi.fn<DrawQr>((_canvas: HTMLCanvasElement, payload: string) =>
      payload === 'polkadotapp://first' ? first.promise : Promise.resolve(),
    );
    await renderModal();

    // When
    await authState(pairing({ deeplink: 'polkadotapp://first' }));
    await authState(pairing({ deeplink: 'polkadotapp://second' }));
    first.resolve();
    await settleQr();

    // Then
    const canvases = document.querySelectorAll<HTMLCanvasElement>('#auth-modal-qr canvas');
    expect(canvases).toHaveLength(1);
    expect(canvases[0]?.dataset['qrPayload']).toBe('polkadotapp://second');
  });

  it("As a user who scanned, then was shown a new code, the first code's late drawing never shows", async () => {
    // Given: every drawing is held back.
    const drawings = new Map<string, () => void>();
    qr.toCanvas = vi.fn<DrawQr>(
      (_canvas: HTMLCanvasElement, payload: string) =>
        new Promise<void>(resolve => {
          drawings.set(payload, resolve);
        }),
    );
    await renderModal();
    await authState(pairing({ deeplink: 'polkadotapp://first' }));
    await authState({ tag: 'Authenticating' });
    await authState(pairing({ deeplink: 'polkadotapp://second' }));

    // When
    drawings.get('polkadotapp://first')?.();
    await settleQr();

    // Then
    expect(document.querySelector('#auth-modal-qr canvas')).toBeNull();
    expectQrSpinnerView();

    // When
    drawings.get('polkadotapp://second')?.();
    await settleQr();

    // Then
    expect(document.querySelector<HTMLCanvasElement>('#auth-modal-qr canvas')?.dataset['qrPayload']).toBe(
      'polkadotapp://second',
    );
  });

  it('As a user whose modal was closed while the QR was drawing, nothing is drawn in', async () => {
    // Given
    const drawing = deferred();
    qr.toCanvas = vi.fn<DrawQr>(() => drawing.promise);
    await renderModal();
    await authState(pairing());

    // When
    byId('auth-modal-close').click();
    await settleQr();
    drawing.resolve();
    await settleQr();

    // Then
    expect(byId('auth-modal-qr').children).toHaveLength(0);
  });

  it("As a user, the QR is drawn once per pairing code, not again when the modal's lease opens it", async () => {
    // Given: a prompt holds the blocking-modal queue.
    await renderModal();
    const scope = coordinator.createScope();
    const { promise: held, resolve: release }: PromiseWithResolvers<void> = Promise.withResolvers();
    const prompt = scope.enqueue(() => held);

    // When: the core pairs while the modal waits for its lease.
    await authState(pairing());
    expect(isOpen()).toBe(false);
    release();
    await prompt;
    await settleQr();

    // Then
    expect(isOpen()).toBe(true);
    expect(qr.toCanvas).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#auth-modal-qr canvas')).not.toBeNull();
    scope.dispose();
  });
});

describe('AuthModal on unrelated store writes', () => {
  it('As a user shown a QR, it is drawn once and keeps its canvas while other modal fields change', async () => {
    // Given
    await renderModal();
    const createElement = vi.spyOn(document, 'createElement');
    const canvases = (): number => createElement.mock.calls.filter(([tag]) => tag === 'canvas').length;
    await authState(pairing());
    const canvas = document.querySelector('#auth-modal-qr canvas');
    expect(canvas).not.toBeNull();
    expect(canvases()).toBe(1);

    // When: the reason changes twice, the code does not.
    updateAuthModal({ reason: 'first' });
    await settleQr();
    updateAuthModal({ reason: 'second' });
    await settleQr();

    // Then
    expect(canvases()).toBe(1);
    expect(qr.toCanvas).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#auth-modal-qr canvas')).toBe(canvas);
  });

  it("As a user, the open modal's dialog is set once per open, not again on other modal writes", async () => {
    // Given
    await renderModal();
    await authState(pairing());
    expect(isOpen()).toBe(true);
    const opens = dialogSetOpen.calls.length;
    expect(dialogSetOpen.calls.at(-1)).toBe(true);

    // When
    updateAuthModal({ reason: 'first' });
    await settleQr();
    updateAuthModal({ productLabel: 'other.dot' });
    await settleQr();

    // Then
    expect(dialogSetOpen.calls.length).toBe(opens);
    expect(isOpen()).toBe(true);
  });
});

describe('AuthModal on a phone', () => {
  it('As a new user on a phone without the app, the login modal shows me where to get Polkadot Mobile', async () => {
    // Given
    device.mobile = true;
    await renderModal();
    const getApp = byId('auth-modal-get-app', HTMLAnchorElement);

    // When
    await authState(pairing());

    // Then
    expect(getApp.hidden).toBe(false);
    expect(getApp.getAttribute('href')).toBe('https://docs.polkadot.com/apps/');

    // When the wallet has approved, installing the app is no longer the ask.
    await authState({ tag: 'Authenticating' });

    // Then
    expect(getApp.hidden).toBe(true);
  });

  it('As a desktop user scanning with my phone, the modal does not offer an app install link', async () => {
    // Given
    await renderModal();

    // When
    await authState(pairing());

    // Then
    expect(byId('auth-modal-get-app').hidden).toBe(true);
  });

  it('As a phone user, the deeplink leads and the QR is behind Show QR instead, with its ids, labels and ARIA state', async () => {
    // Given
    device.mobile = true;
    const backdrop = await renderModal();

    // When
    await authState(pairing());

    // Then
    expectMarkup(backdrop, {
      open: true,
      productLabel: 'localhost:3000',
      hint: MOBILE_HINT,
      getAppHidden: false,
      body: { kind: 'mobile-qr', payload: DEEPLINK, qrShown: false },
    });

    // When
    byTestId('auth-modal-qr-toggle', document).click();
    await settleQr();

    // Then
    expectMarkup(backdrop, {
      open: true,
      productLabel: 'localhost:3000',
      hint: DESKTOP_HINT,
      getAppHidden: false,
      body: { kind: 'mobile-qr', payload: DEEPLINK, qrShown: true },
    });

    // When: the wallet approved, the QR's hint stays.
    await authState({ tag: 'Authenticating' });

    // Then
    expectMarkup(backdrop, {
      open: true,
      productLabel: 'localhost:3000',
      hint: DESKTOP_HINT,
      getAppHidden: true,
      body: { kind: 'authenticating' },
    });

    // When: a new pairing starts over with the deeplink first.
    await authState(pairing());

    // Then
    expectMarkup(backdrop, {
      open: true,
      productLabel: 'localhost:3000',
      hint: MOBILE_HINT,
      getAppHidden: false,
      body: { kind: 'mobile-qr', payload: DEEPLINK, qrShown: false },
    });
  });
});

describe('AuthModal on a phone, on unrelated store writes', () => {
  it('As a phone user who chose Show QR instead, the QR stays shown while other modal fields change', async () => {
    // Given
    device.mobile = true;
    await renderModal();
    await authState(pairing());
    byTestId('auth-modal-qr-toggle', document).click();
    await settleQr();
    expect(document.querySelector('[data-testid="auth-modal-qr-toggle"]')).toBeNull();

    // When
    updateAuthModal({ reason: 'first' });
    await settleQr();

    // Then
    expect(document.querySelector('[data-testid="auth-modal-qr-toggle"]')).toBeNull();
    expect(byTestId('auth-modal-qr-link', document, HTMLAnchorElement).getAttribute('href')).toBe(DEEPLINK);
    expect(byId('auth-modal-hint').textContent).toBe(DESKTOP_HINT);
  });
});

describe('AuthModal error copy', () => {
  async function failWith(reason: string, kind: 'Other' | 'NoFreeAllowanceSlots' = 'Other'): Promise<string> {
    await renderModal();
    await authState({ tag: 'LoginFailed', kind, reason });
    return qrText();
  }

  it('As a dotli integrator, the host keeps the retry view for login failures', async () => {
    // Given
    await renderModal();

    // When
    window.dispatchEvent(
      new CustomEvent('dotli:product-loaded', {
        detail: { label: 'localhost:3000' },
      }),
    );
    await authState({
      tag: 'LoginFailed',
      kind: 'Other',
      reason: 'Host failure',
    });

    // Then
    expect(byId('auth-modal-title').textContent).toBe('Login with Polkadot Mobile');
    expect(isOpen()).toBe(true);
    expect(qrText()).toContain('Retry');
  });

  it('explains statement-store slot exhaustion from the typed failure kind', async () => {
    // Wallet wording, which this workspace does not control. The core
    // classifies it; matching the prose here would not.
    const modalText = await failWith('No free slots available (limit=8)', 'NoFreeAllowanceSlots');
    expect(modalText).toContain('No Statement Store slots left');
    expect(modalText).toContain('No free slots available (limit=8)');
    // Retrying cannot succeed until the allowance period rolls over, so the
    // view must not offer it as the way forward.
    expect(modalText).not.toContain('Retry');
  });

  it('keeps the retry affordance for login failures that are worth retrying', async () => {
    const modalText = await failWith('transport closed before the wallet answered');
    expect(modalText).toContain('transport closed before the wallet answered');
    expect(modalText).toContain('Retry');
  });

  it('explains rejected statement-store transactions from the raw reason', async () => {
    const modalText = await failWith('submit RPC error: Invalid Transaction');
    expect(modalText).toContain('Statement Store transaction rejected');
    expect(modalText).toContain('submit RPC error: Invalid Transaction');
    expect(modalText).toContain('Retry');
  });

  it('As a new user, I am told when I declined the login on my phone', async () => {
    const modalText = await failWith('Login request denied');
    expect(modalText).toContain('Login was declined');
    expect(modalText).toContain('Retry');
  });

  it('As a new user, I am told when Polkadot Mobile did not answer in time', async () => {
    const modalText = await failWith('runtime call timed out');
    expect(modalText).toContain('Login timed out');
    expect(modalText).toContain('Retry');
  });

  it('As a new user, I am not offered a retry when this page cannot log in at all', async () => {
    const modalText = await failWith('Login is not supported by this host');
    expect(modalText).toContain('Login is not available here');
    expect(modalText).not.toContain('Retry');
  });

  it('As a new user, a login runtime that fails to load reads as a page problem rather than a phone problem', async () => {
    // Observed with the asset server down: the auth worker never booted.
    const modalText = await failWith('worker init failed: undefined');
    expect(modalText).toContain('The login service did not start');
    expect(modalText).toContain('Retry');
  });

  it('As a new user, a chunk that fails to fetch is a runtime problem, not a lost phone connection', async () => {
    const modalText = await failWith(
      'TypeError: Failed to fetch dynamically imported module: http://localhost:5173/assets/web-1228KImM.js',
    );
    expect(modalText).toContain('The login service did not start');
    expect(modalText).not.toContain('Connection to Polkadot Mobile was lost');
  });

  it('As a new user, an unknown failure still reads as a login problem with the raw reason kept for bug reports', async () => {
    const modalText = await failWith('Host failure');
    expect(modalText).toContain('Login did not complete');
    expect(query(document, '#auth-modal-qr [data-testid="auth-modal-error"]').textContent).toBe('Host failure');
    expect(modalText).toContain('Retry');
  });
});
