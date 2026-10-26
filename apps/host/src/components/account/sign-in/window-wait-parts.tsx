// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in modal's views while a sign-in goes through the sign-in window, and what their buttons ask of the page.

import type { JSX } from '@solidjs/web';
import { ExternalWindowIcon } from '@dotli/ui/icons';
import type { AuthModalView } from '../../../state/auth-modal.js';
import {
  SIGN_IN_CLOSE_ID,
  StatusScreen,
  type HeadingLevel,
  type SignInAction,
  type SignInParts,
} from './SignInViews.js';
import s from './window-wait-parts.module.css';

/** A view of the modal that waits on the sign-in window, or says why it could not open it. */
export type WindowWaitView = Extract<AuthModalView, { kind: 'window' | 'blocked' | 'refused' | 'prompt' }>;

/** What the views that wait on the sign-in window need from the modal. */
export interface WindowWaitPartsProps {
  /** The page the sign-in is for, null for a sign-in of its own. */
  host: string | null;
  /** Cancel, or Close once nothing is left to wait for. */
  onClose: () => void;
  /** Signs in again: the blocked window's Try again and the prompt's Sign in. */
  onRetry: () => void;
  /** Brings the sign-in window to the front. */
  onFocusWindow: () => void;
  level?: HeadingLevel | undefined;
  /** Takes focus before a pressed control is replaced, so it never drops to the page. */
  holdFocus?: (() => void) | undefined;
}

function windowCopy(view: WindowWaitView, host: string | null): { title: string; body: string } {
  switch (view.kind) {
    case 'window':
      return {
        title: 'Continue in the sign-in window',
        body: "Sign in with Polkadot App in the window that opened. This page picks up your account once you're done.",
      };
    case 'blocked':
      return {
        title: 'The sign-in window was blocked',
        body: 'Your browser stopped the window that signs you in. Allow it if the browser asks, then try again.',
      };
    case 'refused':
      return {
        title: 'Sign-in is not available here',
        body: 'The sign-in window does not sign in pages at this address.',
      };
    case 'prompt':
      // The page only knows a sign-in exists elsewhere, so the resume names no account.
      return view.resume
        ? {
            title: 'Continue session',
            body: `You're already signed in. Continue to use that account in ${host ?? 'this app'}.`,
          }
        : {
            title: 'Sign in to continue',
            body: `${host ?? 'This app'} needs your account. Sign in with Polkadot App in a new window.`,
          };
  }
}

function windowActions(view: WindowWaitView, props: WindowWaitPartsProps, retry: () => void): SignInAction[] {
  const close = (label: string): SignInAction => ({
    label,
    onPress: () => {
      props.onClose();
    },
    dismisses: true,
    id: SIGN_IN_CLOSE_ID,
    testId: SIGN_IN_CLOSE_ID,
  });
  switch (view.kind) {
    case 'window':
      return [
        {
          label: 'Show the window',
          icon: ExternalWindowIcon,
          onPress: () => {
            props.onFocusWindow();
          },
          testId: 'auth-modal-window-focus',
        },
        close('Cancel'),
      ];
    case 'blocked':
      return [
        { label: 'Try again', primary: true, onPress: retry, testId: 'auth-modal-window-retry' },
        close('Cancel'),
      ];
    case 'refused':
      return [close('Close')];
    case 'prompt':
      return [
        {
          label: view.resume ? 'Continue session' : 'Sign in',
          primary: true,
          onPress: retry,
          testId: 'auth-modal-window-signin',
        },
      ];
  }
}

/** The screen for a view that waits on the sign-in window. Each call builds the screen anew. */
export function windowWaitParts(view: WindowWaitView, props: WindowWaitPartsProps): SignInParts {
  const retry = (): void => {
    // The retry replaces the pressed button.
    props.holdFocus?.();
    props.onRetry();
  };
  const parts = StatusScreen({
    get title() {
      return windowCopy(view, props.host).title;
    },
    get body() {
      return windowCopy(view, props.host).body;
    },
    actions: windowActions(view, props, retry),
    level: props.level,
    titleId: 'auth-modal-title',
  });
  const content: JSX.Element = (
    <div
      class={s['view']}
      data-testid="auth-modal-window"
      data-view={view.kind}
      data-resume={view.kind === 'prompt' && view.resume ? '' : undefined}
    >
      {parts.content}
    </div>
  );
  return { ...parts, content };
}
