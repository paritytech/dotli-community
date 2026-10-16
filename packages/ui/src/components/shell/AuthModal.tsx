// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, Match, onCleanup, Show, Switch } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isMobileDevice, log } from '@dotli/shared';

import { closeAuthModal, retryLogin } from '../../auth-controller.js';
import { watchPhoneViewport } from '../../phone-viewport.js';
import { revealTopbar } from '../../topbar-autohide.js';
import { authModalStore, getAuthModalState, getAuthModalTrigger, type AuthModalView } from '../../state/auth-modal.js';
import { shallowEqual } from '../../state/create-store.js';
import { registerTopbarSurface } from '../../state/topbar-surfaces.js';
import { useStore } from '../use-store.js';
import { Button, ButtonLink } from '../primitives/Button.js';
import { IconTile } from '../primitives/IconTile.js';
import { Spinner } from '../primitives/Spinner.js';
import { StatusDot } from '../primitives/StatusDot.js';
import { Surface } from '../primitives/Surface.js';
import { Well } from '../primitives/Well.js';
import { Modal } from '../floating/Modal.js';
import s from './AuthModal.module.css';

// Lists the current Polkadot Mobile store listings for phones without the app.
const POLKADOT_MOBILE_DOWNLOAD_URL = 'https://docs.polkadot.com/apps/';

const SCAN_HINT = 'Scan with Polkadot Mobile to connect';

/** The drawn code's side, quiet zone included. The stylesheet owns it, so the code follows the layout's breakpoint. */
function qrSize(box: HTMLElement): number {
  return Number.parseInt(getComputedStyle(box).getPropertyValue('--qr-size'), 10);
}

type ErrorView = Extract<AuthModalView, { kind: 'error' }>;

interface DrawnQr {
  payload: string;
  canvas: HTMLCanvasElement;
}

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

/** Decorative: the code's error correction survives it. */
function QrBadge(): JSX.Element {
  return (
    <span class={s['badge']} aria-hidden="true">
      <span>
        <PolkadotMark />
      </span>
    </span>
  );
}

/** On a phone the tile links to the deeplink, so tapping the code pairs too. */
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
 * The sign-in modal island. It renders authModalStore, which auth-controller.ts writes from boot, so a login
 * started before hydration shows once hydrated.
 *
 * Closing cancels the login. The controller opens it only once it holds the blocking-modal lease, so it never
 * closes for another blocking modal, and a sign-in queued behind one reveals nothing until then.
 */
export function AuthModal(): JSX.Element {
  let frame: HTMLDivElement | undefined;
  let qrBox: HTMLDivElement | undefined;
  const state = useStore(authModalStore);
  // The build-time render has no device, so it takes the desktop layout.
  const mobile = createMemo(isMobileDevice, { ssrSource: 'client', loadingValue: false });

  // Effects compute from memos, not `state()`: Solid 2 runs an effect's function every time its compute
  // re-runs, and the memos notify only when their own value changes.
  const open = createMemo(() => state().open);
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

  // The phone's "Show QR instead" holds until the next presentation. Login progress keeps whichever is up.
  const [qrShown, setQrShown] = createSignal(false);
  createEffect(view, v => {
    if (v?.kind !== 'authenticating') {
      setQrShown(false);
    }
  });

  // Last payload wins: a drawing is dropped once its payload is no longer on show.
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
    // Crossing the phone width moves `--qr-size` to the other layout's, so redraw.
    const unwatch = watchPhoneViewport(draw);
    return () => {
      current = false;
      unwatch();
    };
  });
  const qr = (): DrawnQr | undefined => {
    const d = drawn();
    return d !== null && d.payload === pairingPayload() ? d : undefined;
  };

  // The surface hangs from the pill, and a product can ask for sign-in while the bar is folded into the
  // capsule, so opening brings the pill back and the registration holds it.
  onCleanup(registerTopbarSurface({ element: () => frame, open }));
  createEffect(open, isOpen => {
    if (isOpen) {
      revealTopbar();
    }
  });

  const hint = (): string =>
    mobile() && !qrShown()
      ? // Mobile leads with the deeplink button.
        'Sign in with the Polkadot app on this device'
      : SCAN_HINT;
  // Desktop users scan with a phone that already has the app, so the install link only helps on a phone.
  const getAppHidden = (): boolean => {
    const kind = state().view.kind;
    return !mobile() || kind === 'authenticating' || kind === 'error';
  };
  const errorView = (): ErrorView | undefined => {
    const v = view();
    return v?.kind === 'error' ? v : undefined;
  };

  const retry = (): void => {
    // The retry replaces the focused Retry, so focus the card first or focus drops to the body.
    card()?.focus();
    retryLogin();
  };

  const showQr = (): void => {
    // "Show QR instead" goes as the QR comes in, so focus the card first, as Retry does.
    card()?.focus();
    setQrShown(true);
  };

  const card = (): HTMLElement | null => frame?.querySelector<HTMLElement>('[data-modal-surface]') ?? null;

  // Links skipped, as in a Radix Dialog.
  const firstButton = (): HTMLElement | undefined =>
    frame?.querySelector<HTMLElement>('button:not([disabled])') ?? undefined;

  return (
    <Modal
      open={open()}
      onOpenChange={() => {
        if (getAuthModalState().open) {
          closeAuthModal();
        }
      }}
      title="Sign in"
      labelledBy="auth-modal-title"
      placement="topbar-end"
      scrim="light"
      initialFocus={firstButton}
      restoreFocus={getAuthModalTrigger}
      id="auth-modal-backdrop"
      class={s['surface']}
      testId="auth-modal"
      frameRef={el => {
        frame = el;
      }}
    >
      <div class={s['content']}>
        <Surface class={s['panel']}>
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
        </Surface>
      </div>
    </Modal>
  );
}

/**
 * A phone has no second device to scan with, so the deeplink leads.
 * The QR is opt-in, for pairing another device.
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
