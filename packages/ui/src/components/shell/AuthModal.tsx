// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, Match, Show, Switch } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isMobileDevice, log } from '@dotli/shared';

import { closeAuthModal, retryLogin } from '../../auth-controller.js';
import { PHONE_QUERY } from '../../phone-viewport.js';
import { revealTopbar } from '../../topbar-autohide.js';
import { authModalStore, getAuthModalState, getAuthModalTrigger, type AuthModalView } from '../../state/auth-modal.js';
import { shallowEqual } from '../../state/create-store.js';
import { useStore } from '../use-store.js';
import { Button, ButtonLink } from '../primitives/Button.js';
import { IconTile } from '../primitives/IconTile.js';
import { Spinner } from '../primitives/Spinner.js';
import { StatusDot } from '../primitives/StatusDot.js';
import { Surface } from '../primitives/Surface.js';
import { Well } from '../primitives/Well.js';
import { SheetHead } from '../sheet/SheetHead.js';
import s from './AuthModal.module.css';
import { createPopover } from './create-popover.js';

// Lists the current Polkadot Mobile store listings for phones without the app.
const POLKADOT_MOBILE_DOWNLOAD_URL = 'https://docs.polkadot.com/apps/';

const SCAN_HINT = 'Scan with Polkadot Mobile to connect';

/**
 * The drawn code's side in CSS px, its 2-module quiet zone included: the QR
 * box's `--qr-size` (AuthModal.module.css), which also reserves the tile's
 * height before the code is drawn. The stylesheet owns it, so the code
 * follows the layout's breakpoint.
 */
function qrSize(box: HTMLElement): number {
  return Number.parseInt(getComputedStyle(box).getPropertyValue('--qr-size'), 10);
}

type ErrorView = Extract<AuthModalView, { kind: 'error' }>;

/** A drawn QR code, for the payload it encodes. */
interface DrawnQr {
  payload: string;
  canvas: HTMLCanvasElement;
}

/** The Polkadot mark, in the current colour. */
function PolkadotMark(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <ellipse cx="12" cy="3.6" rx="3.3" ry="2.1" />
      <ellipse cx="12" cy="20.4" rx="3.3" ry="2.1" />
      <ellipse cx="19.3" cy="7.8" rx="3.3" ry="2.1" transform="rotate(60 19.3 7.8)" />
      <ellipse cx="19.3" cy="16.2" rx="3.3" ry="2.1" transform="rotate(-60 19.3 16.2)" />
      <ellipse cx="4.7" cy="16.2" rx="3.3" ry="2.1" transform="rotate(60 4.7 16.2)" />
      <ellipse cx="4.7" cy="7.8" rx="3.3" ry="2.1" transform="rotate(-60 4.7 7.8)" />
    </svg>
  );
}

/** The badge over the code's centre: decorative, the code is drawn to survive it. */
function QrBadge(): JSX.Element {
  return (
    <span class={s['badge']} aria-hidden="true">
      <span>
        <PolkadotMark />
      </span>
    </span>
  );
}

/**
 * The drawn code on its white tile, then the waiting line. On a phone the
 * tile is a link to the deeplink, so tapping the code pairs too.
 */
function QrCode(props: { qr: DrawnQr; link: boolean }): JSX.Element {
  return (
    <>
      <Show
        when={props.link}
        fallback={
          <div class={s['tile']} data-testid="auth-modal-qr-tile">
            {props.qr.canvas}
            <QrBadge />
          </div>
        }
      >
        <a href={props.qr.payload} class={s['tile']} data-testid="auth-modal-qr-link">
          {props.qr.canvas}
          <QrBadge />
        </a>
      </Show>
      <p class={s['waiting']} data-testid="auth-modal-waiting">
        <StatusDot tone="info" size="sm" />
        Waiting for your phone
      </p>
    </>
  );
}

function ErrorBody(props: { view: ErrorView; retry: () => void }): JSX.Element {
  return (
    <div class={s['errorView']}>
      <IconTile class={s['pendingIcon']}>
        {/* Clock glyph for the "account still being set up" state. */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </IconTile>
      <div class={s['pendingTitle']}>{props.view.title}</div>
      <div class={s['pendingSubtitle']}>{props.view.subtitle}</div>
      <Show when={(props.view.detail ?? '').length > 0}>
        <Well class={s['error']} testId="auth-modal-error">
          {props.view.detail}
        </Well>
      </Show>
      <Show when={props.view.retry}>
        <Button
          variant="primary"
          block
          class={s['retry']}
          testId="auth-modal-retry"
          onClick={() => {
            props.retry();
          }}
        >
          Retry
        </Button>
      </Show>
    </div>
  );
}

/**
 * The sign-in surface (`#auth-modal-backdrop`), a shell island (see
 * src/islands/), rendered with the host page, closed, and hydrated. It renders
 * authModalStore, which auth-controller.ts writes from boot onwards, so a
 * login that started before the island hydrated shows once it has.
 *
 * The glass surface drops from the pill's right edge like the topbar's
 * popovers, over a light scrim, and at 560 px and below it is a bottom sheet
 * over the dark scrim, led by the sheets' head (SheetHead): the grabber,
 * "Sign in" and a close button, and a swipe down on it closes, as Cancel
 * does. The landing page has no pill, so there it takes the popovers'
 * fallback place in the top right corner. The body follows the
 * store's view: a spinner, the pairing QR code on its tile with the Polkadot
 * badge, login progress, or an error with the friendly copy and, when it can
 * help, Retry. The QR is drawn on a canvas by the lazily imported `qrcode`,
 * and a drawing that finishes after the view moved on (a newer code,
 * progress, a close) is dropped. On a phone the deeplink button leads and
 * the QR sits behind "Show QR instead", and the "get the app" link shows
 * until pairing is past the QR.
 *
 * While open it is a modal dialog, like Radix Dialog (createPopover's
 * `dialog` mode, driven by the store's `open`): it focuses its first control
 * (links skipped) or else itself, keeps Tab inside, stops the page scrolling,
 * and gives the focus back to the auth button when it closes. Escape, Cancel
 * and a press on the scrim close it, which cancels the login. It is itself a
 * blocking modal (the controller opens it only once it holds the
 * blocking-modal lease), so it never closes on one coming up.
 *
 * Opening it reveals the topbar (revealTopbar) and the auto-hide holds the
 * pill while it is open. A sign-in queued behind another blocking prompt
 * reveals nothing until its lease opens it: the capsule's action dot says it
 * is waiting.
 */
export function AuthModal(): JSX.Element {
  let backdrop: HTMLDivElement | undefined;
  let surface: HTMLElement | undefined;
  let qrBox: HTMLDivElement | undefined;
  const state = useStore(authModalStore);
  // A phone's layout once hydrated: the build-time render, which has no
  // device, is the desktop one.
  const mobile = createMemo(isMobileDevice, { ssrSource: 'client', loadingValue: false });

  // The effects below compute from memos, not from `state()`: Solid 2 runs an
  // effect's function every time its compute re-runs, so a compute over the
  // whole store would re-run them on any write (a new reason, say), and the
  // memos only notify when their own value changes.
  const open = createMemo(() => state().open);
  /** The view on show: none while closed, as the topbar emptied it. */
  const view = createMemo<AuthModalView | null>(
    () => {
      const current = state();
      return current.open ? current.view : null;
    },
    // The store rebuilds the view on writes that keep it.
    { equals: shallowEqual },
  );
  const pairingPayload = createMemo((): string | null => {
    const v = view();
    return v?.kind === 'pairing' ? v.payload : null;
  });

  // The phone's "Show QR instead": the QR's hint replaces the deeplink's
  // until the next presentation. Login progress keeps whichever is up.
  const [qrShown, setQrShown] = createSignal(false);
  createEffect(view, v => {
    if (v?.kind !== 'authenticating') {
      setQrShown(false);
    }
  });

  // Last payload wins: each code starts a drawing whose result is dropped
  // once the payload is no longer on show.
  const [drawn, setDrawn] = createSignal<DrawnQr | null>(null);
  createEffect(pairingPayload, payload => {
    const box = qrBox;
    if (payload === null || box === undefined) {
      return;
    }
    let current = true;
    const canvas = document.createElement('canvas');
    canvas.dataset['qrPayload'] = payload;
    canvas.className = s['qrCanvas'] ?? '';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Sign-in QR code');
    const draw = (): void => {
      void import('qrcode')
        .then(QRCode =>
          QRCode.default.toCanvas(canvas, payload, {
            width: qrSize(box),
            margin: 2,
            // The badge hides the code's centre: Q recovers a quarter of it.
            errorCorrectionLevel: 'Q',
            color: { dark: '#000000', light: '#ffffff' },
          }),
        )
        .then(() => {
          if (current) {
            setDrawn({ payload, canvas });
          }
        })
        .catch((err: unknown) => {
          log.error('[dot.li] QR render failed:', err);
        });
    };
    draw();
    // A window crossing the phone width (a phone turned, a desktop narrowed)
    // moves `--qr-size` to the other layout's: redraw to fill the new tile.
    const phone = window.matchMedia(PHONE_QUERY);
    phone.addEventListener('change', draw);
    return () => {
      current = false;
      phone.removeEventListener('change', draw);
    };
  });
  const qr = (): DrawnQr | undefined => {
    const d = drawn();
    return d !== null && d.payload === pairingPayload() ? d : undefined;
  };

  const dialog = createPopover({
    mode: 'dialog',
    trigger: getAuthModalTrigger,
    surface: () => backdrop,
    closeOnBlockingModal: false,
    onClose: () => {
      // Escape closed it: close the store too, which cancels the login. A
      // close that came from the store (Cancel, the scrim, a finished
      // login) finds it closed already.
      if (getAuthModalState().open) {
        closeAuthModal();
      }
    },
  });
  // The dialog follows the store. The surface hangs from the pill, and a
  // product can ask for sign-in while the bar is folded into the capsule, so
  // opening brings the pill back. createPopover registers the dialog as a
  // topbar surface, so the auto-hide keeps the pill up until it closes.
  createEffect(open, isOpen => {
    dialog.setOpen(isOpen);
    if (isOpen) {
      revealTopbar();
    }
  });

  const hint = (): string =>
    mobile() && !qrShown()
      ? // Mobile leads with the deeplink button.
        'Sign in with the Polkadot app on this device'
      : SCAN_HINT;
  // Desktop users scan with a phone that already has the app, so the install
  // link only helps on the phone itself, and not once pairing is past the QR.
  const getAppHidden = (): boolean => {
    const kind = state().view.kind;
    return !mobile() || kind === 'authenticating' || kind === 'error';
  };
  const errorView = (): ErrorView | undefined => {
    const v = view();
    return v?.kind === 'error' ? v : undefined;
  };

  const retry = (): void => {
    // The retry replaces the error view, Retry included: focus the dialog
    // first, so focus stays in it rather than dropping to the body (Radix's
    // FocusScope refocuses its container when the focused node goes).
    backdrop?.focus();
    retryLogin();
  };

  const showQr = (): void => {
    // "Show QR instead" goes as the QR comes in: focus the dialog first, as
    // Retry does, so focus stays in it rather than dropping to the body.
    backdrop?.focus();
    setQrShown(true);
  };

  const onBackdropClick = (e: MouseEvent): void => {
    // Only a press on the scrim itself, outside the surface.
    if (e.target === e.currentTarget) {
      closeAuthModal();
    }
  };

  return (
    <div
      ref={el => {
        backdrop = el;
      }}
      onClick={onBackdropClick}
      class={s['backdrop']}
      data-chrome=""
      data-open={open() ? '' : undefined}
      id="auth-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
      tabindex="-1"
    >
      <Surface
        ref={el => {
          surface = el;
        }}
        class={s['surface']}
      >
        {/* Always in the surface: the stylesheet shows it at phone width,
            so an open sign-in narrowed to a phone's gets it too. */}
        <SheetHead
          title="Sign in"
          surface={() => surface}
          onDismiss={closeAuthModal}
          closeLabel="Close"
          class={s['sheetHead']}
          testId="auth-modal-sheet-head"
          titleTestId="auth-modal-sheet-title"
          closeTestId="auth-modal-sheet-close"
        />
        <div class={s['body']}>
          <div class={s['head']}>
            <h2 class={s['title']} id="auth-modal-title">
              <Show when={state().productLabel} fallback="Login with Polkadot Mobile">
                {label => (
                  <>
                    {label()}
                    <span class={s['titleRest']}> wants you to sign in</span>
                  </>
                )}
              </Show>
            </h2>
            <p class={s['reason']} id="auth-modal-reason" hidden={state().reason === null}>
              {state().reason ?? ''}
            </p>
            <p class={s['hint']} id="auth-modal-hint">
              {hint()}
            </p>
          </div>
          <div
            ref={el => {
              qrBox = el;
            }}
            class={[s['qr'], !mobile() && s['qrScan']]}
            id="auth-modal-qr"
          >
            <Switch>
              <Match when={view()?.kind === 'authenticating'}>
                <div class={s['progress']}>
                  <Spinner class={s['spinner']} testId="auth-modal-spinner" />
                  <p class={s['progressText']}>Logging in...</p>
                </div>
              </Match>
              <Match when={errorView()}>{v => <ErrorBody view={v()} retry={retry} />}</Match>
              <Match when={view() !== null}>
                <Show when={qr()} fallback={<Spinner class={s['spinner']} testId="auth-modal-spinner" />}>
                  {drawnQr => (
                    <Show when={mobile()} fallback={<QrCode qr={drawnQr()} link={false} />}>
                      <MobileQr qr={drawnQr()} shown={qrShown()} reveal={showQr} />
                    </Show>
                  )}
                </Show>
              </Match>
            </Switch>
          </div>
          <a
            class={s['link']}
            id="auth-modal-get-app"
            href={POLKADOT_MOBILE_DOWNLOAD_URL}
            target="_blank"
            rel="noopener noreferrer"
            hidden={getAppHidden()}
          >
            Don't have the app? Get Polkadot Mobile
          </a>
          <Button
            id="auth-modal-close"
            block
            onClick={() => {
              closeAuthModal();
            }}
          >
            Cancel
          </Button>
        </div>
      </Surface>
    </div>
  );
}

/**
 * A phone has no second device to scan with, so the deeplink button leads
 * and the QR is opt-in behind "Show QR instead", for pairing from another
 * device. Once shown, the QR goes on top and the deeplink below it, demoted
 * to a link.
 */
function MobileQr(props: { qr: DrawnQr; shown: boolean; reveal: () => void }): JSX.Element {
  return (
    <Show
      when={props.shown}
      fallback={
        <>
          <ButtonLink href={props.qr.payload} variant="primary" size="lg" block testId="auth-modal-open-app">
            <PolkadotMark />
            Login With Polkadot App
          </ButtonLink>
          <Button
            block
            testId="auth-modal-qr-toggle"
            onClick={() => {
              props.reveal();
            }}
          >
            Show QR instead
          </Button>
        </>
      }
    >
      <QrCode qr={props.qr} link />
      <a href={props.qr.payload} class={s['link']} data-testid="auth-modal-open-app">
        Login With Polkadot App
      </a>
    </Show>
  );
}
