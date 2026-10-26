// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which sign-in screen each view of the sign-in window shows, and what its buttons ask of the window.

import { merge, omit } from 'solid-js';
import { BanIcon, CircleAlertIcon, CircleCheckIcon } from '@dotli/ui/icons';
import type { PairingView } from '../../state/auth-modal.js';
import type { ContinueOffer, WindowFailure, WindowView } from '../../state/session-window.js';
import type { PhraseForm } from './phrase-form-load.js';
import type { DrawQr } from './qr-code.js';
import { signInParts } from './sign-in/sign-in-parts.js';
import {
  ContinueScreen,
  SIGN_IN_CLOSE_ID,
  StatusScreen,
  type SignInAction,
  type SignInParts,
  type StatusMark,
} from './sign-in/SignInViews.js';

/**
 * What a window view stands for. A new step builds its screen anew, and what the screen held goes with it. The code
 * being made and the code to scan are one pairing step.
 */
export type WindowStep =
  | { view: 'pairing'; pairing: PairingView }
  | { view: 'continue'; offer: ContinueOffer; phoneFailed: boolean }
  | { view: 'phrase'; form: PhraseForm }
  | { view: Exclude<WindowView, 'pairing' | 'continue' | 'phrase'> };

/** What every window screen needs from the window. */
export interface WindowPartsProps {
  /** The page the window signs in for. */
  host: string | null;
  /** A step the user asked for that failed, said on the view it left. */
  failure: WindowFailure | null;
  /** The pairing deeplink on show, null while it is being made. */
  payload: string | null;
  /** A phone has no second device to scan with, so the pairing leads with the deeplink. */
  mobile: boolean;
  /** The user pressed Close on a view that only says where the window stands. */
  onClose: () => void;
  /** The user gave up on the round. */
  onCancel: () => void;
  onContinue: () => void;
  onUseAnotherAccount: () => void;
  /** Goes on to another account after the phone could not be told of the sign-out. */
  onGoOnWithoutPhone: () => void;
  /** Pairs again after a failed pairing, or decides again what to show after a step of the window's own failed. */
  onRetry: () => void;
  onClosePhrase: () => void;
  /** Loads the phrase form again after its chunk failed to load. */
  onReloadPhrase: () => void;
  /** Rejects when the wallet could not be saved, which the window already reported. */
  onImportPhrase: (phrase: string) => Promise<void>;
  isValidPhrase: (phrase: string) => boolean;
  /** Without one, the `qrcode` chunk draws the code. */
  drawQr?: DrawQr | undefined;
}

/** The views that only say where the window stands. */
type StatusView = Extract<WindowView, 'connecting' | 'refused' | 'signing-out' | 'signed-out' | 'done-no-opener'>;

interface StatusCopy {
  mark: StatusMark;
  title: string;
  body: string;
  /**
   * The label of Close, where it is offered. A window no page opened may not be one a script can close, and a sign-out
   * under way closes itself or says when it is done.
   */
  close?: string;
}

const STATUS_COPY: Record<StatusView, StatusCopy> = {
  connecting: {
    mark: 'spinner',
    title: 'Connecting',
    body: 'Waiting for the page that opened this window.',
    close: 'Close',
  },
  refused: {
    mark: { icon: BanIcon, tone: 'idle' },
    title: 'Sign-in is not available for this page',
    body: 'This window does not sign in pages at that address.',
    close: 'Close',
  },
  'signing-out': {
    mark: 'spinner',
    title: 'Signing out',
    body: 'Signing you out of Polkadot App.',
  },
  'signed-out': {
    mark: { icon: CircleCheckIcon, tone: 'ok' },
    title: "You're signed out",
    body: 'Signed out of every app. Polkadot App is being told to forget this browser.',
    close: 'Close this window',
  },
  'done-no-opener': {
    mark: { icon: CircleCheckIcon, tone: 'ok' },
    title: "You're signed in",
    body: 'Return to the app.',
  },
};

/** Said on Continue, which stays on show. The phone's failure has a view of its own. */
const FAILURE_COPY: Record<Exclude<WindowFailure, 'phone'>, string> = {
  'sign-out': 'This account could not be signed out. Try again.',
  step: 'Something went wrong. Try again.',
};

function statusParts(view: StatusView, props: WindowPartsProps): SignInParts {
  const copy = STATUS_COPY[view];
  const close: SignInAction[] =
    copy.close === undefined
      ? []
      : [
          {
            label: copy.close,
            onPress: () => {
              props.onClose();
            },
            dismisses: true,
            testId: 'session-window-close',
          },
        ];
  return StatusScreen({
    mark: copy.mark,
    title: copy.title,
    body: copy.body,
    actions: close,
    testId: 'session-window-status',
    titleTestId: 'session-window-title',
    spinnerTestId: 'session-window-spinner',
  });
}

/** The account's sign-out let it go from the store, but the phone was not told, so no account is offered. */
function phoneNotToldParts(props: WindowPartsProps): SignInParts {
  return StatusScreen({
    mark: { icon: CircleAlertIcon, tone: 'warn' },
    title: 'Not signed out of Polkadot App',
    body: (
      <span role="alert" data-testid="session-window-failure">
        Polkadot App could not be told. It still lists this browser.
      </span>
    ),
    actions: [
      {
        label: 'Try again',
        primary: true,
        onPress: () => {
          props.onUseAnotherAccount();
        },
        testId: 'session-window-another-retry',
      },
      {
        label: 'Use another account anyway',
        onPress: () => {
          props.onGoOnWithoutPhone();
        },
        testId: 'session-window-go-on',
      },
    ],
    testId: 'session-window-phone-failed',
    titleTestId: 'session-window-title',
  });
}

/** A step of the window's own failed where its view could not go on. Try again asks `retry`. */
function stepFailedParts(props: WindowPartsProps, retry: () => void): SignInParts {
  return StatusScreen({
    mark: { icon: CircleAlertIcon, tone: 'err' },
    title: 'Something went wrong',
    body: 'This window could not go on with the sign-in. Try again.',
    actions: [
      {
        label: 'Try again',
        primary: true,
        onPress: retry,
        testId: 'auth-modal-retry',
      },
      {
        label: 'Cancel',
        onPress: () => {
          props.onCancel();
        },
        dismisses: true,
        id: SIGN_IN_CLOSE_ID,
        testId: SIGN_IN_CLOSE_ID,
      },
    ],
    testId: 'auth-modal-failure',
    titleTestId: 'session-window-title',
  });
}

function pairingParts(pairing: PairingView, props: WindowPartsProps): SignInParts {
  return signInParts(
    pairing,
    merge(props, {
      reason: null,
      closesCopy: "This window closes when you're done.",
      onClose: () => {
        props.onCancel();
      },
    }),
  );
}

function continueParts(offer: ContinueOffer, props: WindowPartsProps): SignInParts {
  return ContinueScreen(
    merge(omit(props, 'failure'), {
      offer,
      get failure() {
        const failure = props.failure;
        return failure === null || failure === 'phone' ? null : FAILURE_COPY[failure];
      },
    }),
  );
}

/**
 * The phrase form, which the debug panel's wallet tab opens the window at. Its chunk loads with the view, which says it
 * is connecting until then.
 */
function phraseParts(form: PhraseForm, props: WindowPartsProps): SignInParts {
  if (form === 'loading') {
    return statusParts('connecting', props);
  }
  if (form === 'failed') {
    return stepFailedParts(props, () => {
      props.onReloadPhrase();
    });
  }
  return form.PhraseScreen({
    isValid: phrase => props.isValidPhrase(phrase),
    onImport: phrase => props.onImportPhrase(phrase),
    onBack: () => {
      props.onClosePhrase();
    },
    backLabel: 'Back',
    testId: 'session-window-phrase',
  });
}

/** The screen for a step of the window. Each call builds the screen anew, so call it once per step. */
export function windowParts(step: WindowStep, props: WindowPartsProps): SignInParts {
  switch (step.view) {
    case 'pairing':
      return pairingParts(step.pairing, props);
    case 'continue':
      return step.phoneFailed ? phoneNotToldParts(props) : continueParts(step.offer, props);
    case 'failed':
      return stepFailedParts(props, () => {
        props.onRetry();
      });
    case 'phrase':
      return phraseParts(step.form, props);
    case 'connecting':
    case 'refused':
    case 'signing-out':
    case 'signed-out':
    case 'done-no-opener':
      return statusParts(step.view, props);
  }
}
