// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which sign-in view shows each step of a pairing, and what its buttons ask of the place that shows it.

import { CircleAlertIcon, CircleXIcon } from '@dotli/ui/icons';
import type { PairingView } from '../../../state/auth-modal.js';
import type { DrawQr } from '../qr-code.js';
import { ApprovingScreen, PairingScreen, StatusScreen, type HeadingLevel, type SignInParts } from './SignInViews.js';

/** What every pairing view needs from the place that shows it. */
export interface SignInPartsProps {
  /** The page the sign-in is for, null for a sign-in of its own. */
  host: string | null;
  /** The product's own words for why it asks. */
  reason: string | null;
  /** The pairing deeplink on show, null while it is being made. */
  payload: string | null;
  mobile: boolean;
  /** What closes once the user approves, as the layout knows it. */
  closesCopy: string;
  /** The Cancel shown while the phone approves. */
  onClose: () => void;
  /** Signs in again from a failure's Try again. */
  onRetry: () => void;
  level?: HeadingLevel | undefined;
  /** Takes focus before a pressed control is replaced, so it never drops to the page. */
  holdFocus?: (() => void) | undefined;
  /** Without one, the `qrcode` chunk draws the code. */
  drawQr?: DrawQr | undefined;
}

/**
 * The screen for a view of the pairing. Each call builds the screen anew, so call it again for each new screen, where
 * the code being made and the code to scan share one. What the screen holds, such as a phone's choice to show the
 * code, lasts until then.
 */
export function signInParts(view: PairingView, props: SignInPartsProps): SignInParts {
  const retry = (): void => {
    // The retry replaces the pressed button.
    props.holdFocus?.();
    props.onRetry();
  };
  switch (view.kind) {
    case 'spinner':
    case 'pairing':
      return PairingScreen(props);
    case 'authenticating':
      return ApprovingScreen({
        closesCopy: props.closesCopy,
        onCancel: () => {
          props.onClose();
        },
        level: props.level,
      });
    case 'error':
      return StatusScreen({
        mark: view.pending ? { icon: CircleAlertIcon, tone: 'warn' } : { icon: CircleXIcon, tone: 'err' },
        title: view.title,
        body: view.subtitle,
        detail: view.detail,
        actions: view.retry ? [{ label: 'Try again', primary: true, onPress: retry, testId: 'auth-modal-retry' }] : [],
        level: props.level,
        testId: 'auth-modal-failure',
        titleId: 'auth-modal-title',
        detailTestId: 'auth-modal-error',
      });
  }
}
