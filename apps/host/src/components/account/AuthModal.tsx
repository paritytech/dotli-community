// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, merge, onCleanup, untrack, useContext, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { shallowEqual } from '@dotli/shared';
import { Button, LayerTracker, Modal } from '@dotli/ui';
import type { AuthModalState, AuthModalView, PairingView } from '../../state/auth-modal.js';
import { isMobileDevice } from '../../device.js';
import { loadPhraseScreen, type PhraseScreenModule } from '../../lazy.js';
import { createPhraseFormLoad, type PhraseForm } from './phrase-form-load.js';
import type { DrawQr } from './qr-code.js';
import { SIGN_IN_CLOSE_ID, type SignInParts } from './sign-in/SignInViews.js';
import { signInParts, type SignInPartsProps } from './sign-in/sign-in-parts.js';
import { pairingPayload, sameSignInScreen } from './sign-in/same-screen.js';
import { windowWaitParts, type WindowWaitPartsProps } from './sign-in/window-wait-parts.js';

/** Where the modal stands on a wide screen: in the middle of a page with no topbar, or hung from the topbar's end. */
export type AuthModalPlacement = 'center' | 'topbar-end';

/** Names the dialog. The sheet's head shows the same title. */
const TITLE_ID = 'auth-modal-title';

/** Shown until the modal first opens. */
const FIRST_VIEW: AuthModalView = { kind: 'spinner' };

/** Shown in place of the phrase form while its chunk loads. */
const PHRASE_FORM_LOADING: PairingView = { kind: 'spinner' };

/** Shown in place of the phrase form when its chunk failed to load. Its Try again loads it again. */
const PHRASE_FORM_FAILED: PairingView = {
  kind: 'error',
  message: 'The recovery phrase form could not load',
  retry: true,
  pending: false,
  title: 'Something went wrong',
  subtitle: 'Try again.',
};

export type AuthModalProps = {
  state: Accessor<AuthModalState>;
  placement: AuthModalPlacement;
  /** The user closed it: Cancel, Escape, the scrim, or the sheet's close or swipe. */
  onClose: () => void;
  /** Signs in again: a failure's Try again, the blocked window's Try again and the prompt's Sign in. */
  onRetry: () => void;
  /** Brings the sign-in window to the front. */
  onFocusWindow: () => void;
  /** The phrase view's check, on a page that pairs in place. */
  isValidPhrase: (phrase: string) => boolean;
  /** Rejects when the wallet could not be saved, which the page already reported. */
  onImportPhrase: (phrase: string) => Promise<void>;
  /** Takes focus back as the modal closes (the account button), over what held focus at opening. */
  restoreFocus?: (() => HTMLElement | undefined) | undefined;
  /** Without one, the `qrcode` chunk draws the code. */
  drawQr?: DrawQr | undefined;
  /** Without one, the browser's own answer. */
  isMobile?: (() => boolean) | undefined;
  /** Read once. Without one, the phrase form's own chunk. */
  loadPhraseScreen?: (() => Promise<PhraseScreenModule>) | undefined;
};

/**
 * The sign-in modal: each view of a sign-in, or the recovery phrase form on a page that pairs in place, as a prompt.
 * The view's title heads it, its content is the body, and its buttons are the answers, the way out first. A view with
 * no way out of its own gets Cancel. On the landing page it stands in the middle of the page, and on a product page it
 * hangs from the topbar's end. A phone shows it as a sheet either way. A sign-in can start before the page hydrates,
 * so it shows whatever state it is given from its first render.
 *
 * It registers with the `LayerTracker` above it, so a topbar stays up while it is open.
 */
export function AuthModal(props: AuthModalProps): JSX.Element {
  let frame: HTMLDivElement | undefined;
  const open = createMemo(() => props.state().open);
  // The build-time render has no device, so it takes the desktop layout.
  const mobile = createMemo(() => (props.isMobile ?? isMobileDevice)(), { ssrSource: 'client', loadingValue: false });

  const track = useContext(LayerTracker);
  if (track !== null) {
    onCleanup(track({ element: () => frame, open }));
  }

  const card = (): HTMLElement | null => frame?.querySelector<HTMLElement>('[data-modal-surface]') ?? null;

  // While closed it keeps the state it last showed, so it fades out on what it showed. A code queued behind another
  // prompt is drawn only at its turn, since opening takes the new state.
  const shown = createMemo<AuthModalState>(previous => {
    const current = props.state();
    return current.open ? current : (previous ?? { ...current, view: FIRST_VIEW });
  });
  const view = createMemo<AuthModalView>(
    // A copy, so the screen it builds reads plain values.
    () => ({ ...shown().view }),
    // A new state may carry an equal view, which keeps the screen on show.
    { equals: shallowEqual },
  );
  // The first view of the screen on show, which a view on the same screen keeps.
  const screen = createMemo(view, { equals: sameSignInScreen });
  // Each opening starts a new sign-in, so its screen is built anew.
  const openings = createMemo<number>(previous => (open() ? (previous ?? 0) + 1 : (previous ?? 0)));

  const holdFocus = (): void => {
    // The card, or focus drops to the body.
    card()?.focus();
  };

  const partsProps: SignInPartsProps & WindowWaitPartsProps = {
    get host() {
      return shown().productLabel;
    },
    get reason() {
      return shown().reason;
    },
    get payload() {
      return pairingPayload(view());
    },
    get mobile() {
      return mobile();
    },
    closesCopy: "This closes when you're done.",
    onClose: () => {
      props.onClose();
    },
    onRetry: () => {
      props.onRetry();
    },
    onFocusWindow: () => {
      props.onFocusWindow();
    },
    holdFocus,
    get drawQr() {
      return props.drawQr;
    },
    level: 'layout',
  };

  // The phrase form is debug only, so its chunk loads the first time a phrase view is on show.
  const phraseForm = createPhraseFormLoad(
    untrack(() => props.loadPhraseScreen) ?? loadPhraseScreen,
    () => screen().kind === 'phrase',
  );

  const phraseParts = (form: PhraseForm): SignInParts => {
    switch (form) {
      case 'loading':
        return signInParts(PHRASE_FORM_LOADING, partsProps);
      case 'failed':
        // Its Try again loads the form again rather than start a new sign-in.
        return signInParts(PHRASE_FORM_FAILED, merge(partsProps, { onRetry: phraseForm.reload }));
      default:
        return form.PhraseScreen({
          isValid: phrase => props.isValidPhrase(phrase),
          onImport: phrase => props.onImportPhrase(phrase),
          onBack: () => {
            props.onClose();
          },
          backLabel: 'Cancel',
          testId: 'auth-modal-phrase',
          level: 'layout',
        });
    }
  };

  const viewParts = (current: Exclude<AuthModalView, { kind: 'phrase' }>): SignInParts => {
    switch (current.kind) {
      case 'window':
      case 'blocked':
      case 'refused':
      case 'prompt':
        return windowWaitParts(current, partsProps);
      case 'spinner':
      case 'pairing':
      case 'authenticating':
      case 'error':
        return signInParts(current, partsProps);
    }
  };

  // Each new screen is built, and the one before is disposed with its drawing. A screen reads the device once, so a new
  // reading builds it anew too. Only the phrase screen follows its form's load, so a load that settles on another
  // screen rebuilds nothing.
  const parts = createMemo<SignInParts>(() => {
    const current = screen();
    mobile();
    openings();
    if (current.kind !== 'phrase') {
      return untrack(() => viewParts(current));
    }
    const form = phraseForm.form();
    return untrack(() => phraseParts(form));
  });

  // Focus starts on the way out, the one answer that commits to nothing.
  const firstAnswer = (): HTMLElement | undefined =>
    frame?.querySelector<HTMLElement>('[data-testid="auth-modal-actions"] button:not([disabled])') ?? undefined;

  return (
    <Modal
      open={open()}
      onOpenChange={() => {
        props.onClose();
      }}
      title={parts().title}
      labelledBy={TITLE_ID}
      placement={props.placement}
      // Over a product the card hangs from the bar, and a light scrim keeps the product in view.
      scrim={props.placement === 'center' ? 'dark' : 'light'}
      initialFocus={firstAnswer}
      // A new screen replaces the focused button, so focus moves to the card or sheet rather than drop to the page.
      refocusOn={parts}
      restoreFocus={props.restoreFocus}
      id="auth-modal-backdrop"
      testId="auth-modal"
      frameRef={el => {
        frame = el;
      }}
    >
      <Modal.Head titleId={TITLE_ID} title={parts().title} />
      <Modal.Body>
        {parts().content}
        {parts().reveal}
        {parts().note}
      </Modal.Body>
      <Modal.Actions testId="auth-modal-actions">
        {parts().dismiss ?? (
          <Button
            id={SIGN_IN_CLOSE_ID}
            testId={SIGN_IN_CLOSE_ID}
            variant="secondary"
            block
            onClick={() => {
              props.onClose();
            }}
          >
            Cancel
          </Button>
        )}
        {parts().actions}
      </Modal.Actions>
    </Modal>
  );
}
