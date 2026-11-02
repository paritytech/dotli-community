// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How the runtime asks the user and tells them things, in the page's own dialogs and notifications.

import type { ModalHandoff, ModalView, ShowNotification } from '@dotli/ui';
import type { EnforceablePermissionName } from './permissionPolicy.js';

/** `dismissed` stays apart from `denied` so a dismissal stores no denial. */
export type PermissionPromptDecision = 'granted' | 'granted-once' | 'denied' | 'dismissed';

type AskPermissionParams = {
  /** The product that asks. */
  label: string;
  permission: EnforceablePermissionName;
  /** Ends the ask. */
  signal: AbortSignal;
  /** Whether the user may grant it for this execution only. */
  allowOnce: boolean;
};

type ConfirmReviewParams<R extends string> = {
  /** The review the user answers. */
  dialog: ModalView<R>;
  /** Ends the ask. */
  signal: AbortSignal;
  /** Sees every answer, and the step it returns takes the dialog's place until that step closes. */
  handoff?: ((result: R) => ModalHandoff | undefined) | undefined;
};

/** Each ask settles with the user's answer, and rejects with an AbortError once its `signal` aborts. */
export type HostPrompts = {
  /** Resolves the user's decision on `label`'s ask for `permission`. */
  askPermission: (params: AskPermissionParams) => Promise<PermissionPromptDecision>;
  /** Resolves the result of the button the user chose. */
  confirmReview: <R extends string>(params: ConfirmReviewParams<R>) => Promise<R>;
  /** Shows the user a notification. */
  notify: ShowNotification;
};
