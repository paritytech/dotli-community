// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How the runtime asks the user and tells them things. The runtime never renders, so the app answers these with its
// own dialogs and notifications.

import type { EnforceablePermissionName } from './permissions.js';

/** `dismissed` stays apart from `denied` so a dismissal stores no denial. */
export type PermissionPromptDecision = 'granted' | 'granted-once' | 'denied' | 'dismissed';

export type HostNoticeTone = 'info' | 'ok' | 'warn' | 'err' | 'idle';

/** A notification on the page. */
export interface HostNotice {
  text: string;
  label: string;
  deeplink?: string | undefined;
  tone?: HostNoticeTone;
  /** 0 keeps it until closed. */
  dismissMs?: number;
  /** Also fire a browser Notification when the tab is hidden. Default true. */
  browserNotification?: boolean;
  action?: { label: string; onClick: () => void };
}

export interface ReviewField {
  label: string;
  value: string;
  mono?: boolean;
  warning?: boolean;
}

/**
 * `danger` rejects the request and is drawn destructive. `cancel` backs out of a prompt that is not a request to
 * reject. `secondary` is the lesser approval. `primary` is the main one.
 */
export type ReviewButtonVariant = 'cancel' | 'danger' | 'secondary' | 'primary';

export interface ReviewButton<R extends string> {
  label: string;
  variant: ReviewButtonVariant;
  result: R;
}

/** A request the user reviews field by field and answers with one of its buttons. */
export interface ReviewDialog<R extends string> {
  title: string;
  /** The glyph that heads it, `sign` for a request to sign. */
  icon?: 'sign';
  fields: ReviewField[];
  /** Display order. */
  buttons: ReviewButton<R>[];
  dismissOnBackdrop: boolean;
  /** Result of a backdrop click or Escape. Required when `dismissOnBackdrop`. */
  dismissResult?: R;
  /** Result when the dialog cannot be shown at all. */
  fallbackResult: R;
}

/** Each ask settles with the user's answer, and rejects with an AbortError once `signal` aborts. */
export interface HostPrompts {
  askPermission: (
    label: string,
    permission: EnforceablePermissionName,
    signal: AbortSignal,
    options: { allowOnce: boolean },
  ) => Promise<PermissionPromptDecision>;
  /** Resolves true when the user allows storing a preimage of `size` bytes. */
  confirmPreimage: (size: number, signal: AbortSignal) => Promise<boolean>;
  /** Resolves the result of the button the user chose. */
  confirmReview: <R extends string>(dialog: ReviewDialog<R>, signal: AbortSignal) => Promise<R>;
  notify: (notice: HostNotice) => void;
}
