// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, Match, Show, Switch } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isMobileDevice, log } from '@dotli/shared';

import { closeAuthModal, retryLogin } from '../../auth-controller.js';
import { authModalStore, getAuthModalState, getAuthModalTrigger, type AuthModalView } from '../../state/auth-modal.js';
import { shallowEqual } from '../../state/create-store.js';
import { useStore } from '../use-store.js';
import { createPopover } from './create-popover.js';

// Lists the current Polkadot Mobile store listings for phones without the app.
const POLKADOT_MOBILE_DOWNLOAD_URL = 'https://docs.polkadot.com/apps/';

const SCAN_HINT = 'Scan with Polkadot Mobile to connect';

type ErrorView = Extract<AuthModalView, { kind: 'error' }>;

/** A drawn QR code, for the payload it encodes. */
interface DrawnQr {
  payload: string;
  canvas: HTMLCanvasElement;
}

function Spinner(): JSX.Element {
  return <div class="spinner" />;
}

function ErrorBody(props: { view: ErrorView; retry: () => void }): JSX.Element {
  return (
    <div class="auth-modal-error-view">
      <div class="auth-modal-pending-icon">
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
      </div>
      <div class="auth-modal-pending-title">{props.view.title}</div>
      <div class="auth-modal-pending-subtitle">{props.view.subtitle}</div>
      <Show when={(props.view.detail ?? '').length > 0}>
        <p class="auth-modal-error">{props.view.detail}</p>
      </Show>
      <Show when={props.view.retry}>
        <button
          onClick={() => {
            props.retry();
          }}
          class="auth-modal-retry"
        >
          Retry
        </button>
      </Show>
    </div>
  );
}

/**
 * The QR pairing modal (`#auth-modal-backdrop`), a shell island (see
 * src/islands/), rendered with the host page, closed, and hydrated. It renders
 * authModalStore, which auth-controller.ts writes from boot onwards, so a
 * login that started before the island hydrated shows once it has.
 *
 * The body follows the store's view: a spinner, the pairing QR code, login
 * progress, or an error with the friendly copy and, when it can help, Retry.
 * The QR is drawn on a canvas by the lazily imported `qrcode`; a drawing
 * that finishes after the view moved on (a newer code, progress, a close)
 * is dropped. On a phone the deeplink button leads and the QR sits behind
 * "Show QR instead", and the "get the app" link shows until pairing is past
 * the QR.
 *
 * While open it is a modal dialog, like Radix Dialog (createPopover's
 * `dialog` mode, driven by the store's `open`): it focuses its first control
 * (links skipped) or else itself, keeps Tab inside, stops the page scrolling,
 * and gives the focus back to the auth button when it closes. Escape, Cancel
 * and a click on the backdrop itself close it, which cancels the login.
 * It is itself a blocking modal (the controller opens it only once it holds
 * the blocking-modal lease), so it never closes on one coming up.
 */
export function AuthModal(): JSX.Element {
  let backdrop: HTMLDivElement | undefined;
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
      const s = state();
      return s.open ? s.view : null;
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
  // Once a phone's QR is drawn, the body keeps its column layout, as the
  // topbar left the class on.
  const [mobileLayout, setMobileLayout] = createSignal(false);

  // Last payload wins: each code starts a drawing whose result is dropped
  // once the payload is no longer on show.
  const [drawn, setDrawn] = createSignal<DrawnQr | null>(null);
  createEffect(pairingPayload, payload => {
    if (payload === null) {
      return;
    }
    let current = true;
    const onPhone = mobile();
    const canvas = document.createElement('canvas');
    canvas.dataset['qrPayload'] = payload;
    void import('qrcode')
      .then(QRCode =>
        QRCode.default.toCanvas(canvas, payload, {
          width: 200,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        }),
      )
      .then(() => {
        if (current) {
          setDrawn({ payload, canvas });
          if (onPhone) {
            setMobileLayout(true);
          }
        }
      })
      .catch((err: unknown) => {
        log.error('[dot.li] QR render failed:', err);
      });
    return () => {
      current = false;
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
      // close that came from the store (Cancel, the backdrop, a finished
      // login) finds it closed already.
      if (getAuthModalState().open) {
        closeAuthModal();
      }
    },
  });
  // The dialog follows the store.
  createEffect(open, isOpen => {
    dialog.setOpen(isOpen);
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

  const onBackdropClick = (e: MouseEvent): void => {
    // Only a click on the backdrop itself, outside the modal.
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
      class={['auth-modal-backdrop', { open: open() }]}
      id="auth-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
      tabindex="-1"
    >
      <div class="auth-modal">
        <h2 id="auth-modal-title">
          <Show when={state().productLabel} fallback="Login with Polkadot Mobile">
            {label => (
              <>
                {label()} is asking you <span class="auth-modal-title-nowrap">to sign in</span>
              </>
            )}
          </Show>
        </h2>
        <p class="auth-modal-reason" id="auth-modal-reason" hidden={state().reason === null}>
          {state().reason ?? ''}
        </p>
        <p id="auth-modal-hint">{hint()}</p>
        <div class={['auth-modal-qr', { 'auth-modal-qr-mobile': mobileLayout() }]} id="auth-modal-qr">
          <Switch>
            <Match when={view()?.kind === 'authenticating'}>
              <div class="attesting">
                <Spinner />
                <p>Logging in...</p>
              </div>
            </Match>
            <Match when={errorView()}>{v => <ErrorBody view={v()} retry={retry} />}</Match>
            <Match when={view() !== null}>
              <Show when={qr()} fallback={<Spinner />}>
                {drawnQr =>
                  mobile() ? (
                    <MobileQr
                      qr={drawnQr()}
                      shown={qrShown()}
                      reveal={() => {
                        setQrShown(true);
                      }}
                    />
                  ) : (
                    <>{drawnQr().canvas}</>
                  )
                }
              </Show>
            </Match>
          </Switch>
        </div>
        <a
          class="auth-modal-get-app"
          id="auth-modal-get-app"
          href={POLKADOT_MOBILE_DOWNLOAD_URL}
          target="_blank"
          rel="noopener noreferrer"
          hidden={getAppHidden()}
        >
          Don't have the app? Get Polkadot Mobile
        </a>
        <button
          onClick={() => {
            closeAuthModal();
          }}
          class="auth-modal-close"
          id="auth-modal-close"
        >
          Cancel
        </button>
      </div>
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
  const qrLink = (
    <a href={props.qr.payload} class="auth-modal-qr-link" hidden={!props.shown}>
      {props.qr.canvas}
    </a>
  );
  const openApp = (
    <a href={props.qr.payload} class={['auth-modal-open-app', { 'auth-modal-open-app-link': props.shown }]}>
      Login With Polkadot App
    </a>
  );
  const toggle = (
    <button
      onClick={() => {
        props.reveal();
      }}
      type="button"
      class="auth-modal-qr-toggle"
      hidden={props.shown}
    >
      Show QR instead
    </button>
  );
  return <>{props.shown ? [toggle, qrLink, openApp] : [openApp, toggle, qrLink]}</>;
}
