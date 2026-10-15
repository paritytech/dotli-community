// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
  useContext,
  type Accessor,
} from 'solid-js';
import type { JSX } from '@solidjs/web';
import { shallowEqual } from '@dotli/shared';
import { AlertTriangleIcon, ClockIcon, PolkadotIcon } from '@dotli/ui/icons';
import {
  Button,
  ButtonLink,
  IconTile,
  LayerTracker,
  Modal,
  Spinner,
  StatusDot,
  Surface,
  Well,
  watchPhoneViewport,
} from '@dotli/ui';
import type { AuthModalState, AuthModalView } from '../../state/auth-modal.js';
import { isMobileDevice } from '../../device.js';
import { drawQrCode, type DrawQr } from './qr-code.js';
import { presentQr } from './qr-drawer.js';
import s from './AuthModal.module.css';

// Lists the current Polkadot App store listings for phones without the app.
const POLKADOT_MOBILE_DOWNLOAD_URL = 'https://docs.polkadot.com/apps/';

const SCAN_HINT = 'Scan with Polkadot App to sign in';

/** The drawn code's side, quiet zone included. The stylesheet owns it, so the code follows the layout's breakpoint. */
function qrSize(box: HTMLElement): number {
  return Number.parseInt(getComputedStyle(box).getPropertyValue('--qr-size'), 10);
}

type ErrorView = Extract<AuthModalView, { kind: 'error' }>;

interface DrawnQr {
  payload: string;
  canvas: HTMLCanvasElement;
}

/** Decorative: the code's error correction survives it. */
function QrBadge(): JSX.Element {
  return (
    <span class={s['badge']} aria-hidden="true" data-testid="auth-modal-qr-badge">
      <span>
        <PolkadotIcon />
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
    <div class={s['errorView']} data-testid="auth-modal-failure">
      <IconTile class={s['failureIcon']} testId="auth-modal-failure-icon">
        <Show when={props.view.pending} fallback={<AlertTriangleIcon testId="auth-modal-failure-alert" />}>
          <ClockIcon testId="auth-modal-failure-clock" />
        </Show>
      </IconTile>
      <div class={s['failureTitle']}>{props.view.title}</div>
      <div class={s['failureSubtitle']}>{props.view.subtitle}</div>
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

export interface AuthModalProps {
  state: Accessor<AuthModalState>;
  /** The user closed it: Cancel, Escape, the scrim, or the sheet's close or swipe. */
  onClose: () => void;
  onRetry: () => void;
  /** Takes focus back as the modal closes (the account button), over what held focus at opening. */
  restoreFocus?: (() => HTMLElement | undefined) | undefined;
  /** Without one, the `qrcode` chunk draws the code. */
  drawQr?: DrawQr | undefined;
  /** Without one, the browser's own answer. */
  isMobile?: (() => boolean) | undefined;
}

/**
 * The sign-in modal. A sign-in can start before the page hydrates, so the modal shows whatever state it is given
 * from its first render.
 *
 * It hangs from the topbar's end, so it registers with the `LayerTracker` above it, as a floating layer does, and the
 * bar stays up while it is open.
 */
export function AuthModal(props: AuthModalProps): JSX.Element {
  let frame: HTMLDivElement | undefined;
  let qrBox: HTMLDivElement | undefined;
  const state = (): AuthModalState => props.state();
  // The build-time render has no device, so it takes the desktop layout.
  const mobile = createMemo(() => (props.isMobile ?? isMobileDevice)(), { ssrSource: 'client', loadingValue: false });

  // Effects compute from memos, not `state()`: Solid 2 runs an effect's function every time its compute
  // re-runs, and the memos notify only when their own value changes.
  const open = createMemo(() => state().open);
  const view = createMemo<AuthModalView | null>(
    () => {
      const current = state();
      return current.open ? current.view : null;
    },
    // A new state may carry an equal view.
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
    return presentQr(payload, {
      drawQr: props.drawQr ?? drawQrCode,
      createCanvas: shownPayload => {
        const canvas = document.createElement('canvas');
        canvas.dataset['qrPayload'] = shownPayload;
        canvas.className = s['qrCanvas'] ?? '';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', 'Sign-in QR code');
        return canvas;
      },
      size: () => qrSize(box),
      // Crossing the phone width moves `--qr-size` to the other layout's, so redraw.
      watchSize: watchPhoneViewport,
      onDrawn: qr => {
        setDrawn(qr);
      },
    });
  });
  const qr = (): DrawnQr | undefined => {
    const d = drawn();
    return d !== null && d.payload === pairingPayload() ? d : undefined;
  };

  const track = useContext(LayerTracker);
  if (track !== null) {
    onCleanup(track({ element: () => frame, open }));
  }

  const hint = (): string =>
    mobile() && !qrShown()
      ? // Mobile leads with the deeplink button.
        'Sign in with Polkadot App on this device'
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
    props.onRetry();
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
        props.onClose();
      }}
      title="Sign in"
      labelledBy="auth-modal-title"
      placement="topbar-end"
      scrim="light"
      initialFocus={firstButton}
      restoreFocus={props.restoreFocus}
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
              <Show when={state().productLabel} fallback="Sign in with Polkadot App">
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
                  <p class={s['progressText']}>Signing in...</p>
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
            Don't have the app? Get Polkadot App
          </a>
          <Button
            id="auth-modal-close"
            block
            onClick={() => {
              props.onClose();
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
            <PolkadotIcon />
            Sign in with Polkadot App
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
        Sign in with Polkadot App
      </a>
    </Show>
  );
}
