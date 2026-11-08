// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How the runtime asks the user and tells them things, in the page's own dialogs and notifications, and how the user's
// answer to a grant reads.

import type { ModalHandoff, ModalView, ShowNotification } from '@dotli/ui';
import type { PermissionDecision } from '@parity/truapi-host';
import { ERRORS } from './errors.js';
import type { EnforceablePermissionName, PermissionStatus } from './permissionPolicy.js';

/** The user's answer to a grant prompt. `dismissed` stays apart from `denied` so a dismissal stores no denial. */
export type GrantAnswer = 'granted' | 'granted-once' | 'denied' | 'dismissed';

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
  askPermission: (params: AskPermissionParams) => Promise<GrantAnswer>;
  /** Resolves the result of the button the user chose. */
  confirmReview: <R extends string>(params: ConfirmReviewParams<R>) => Promise<R>;
  /** Shows the user a notification. */
  notify: ShowNotification;
};

/** True when the user allowed it, for this execution or for good. Never throws. */
export function isGranted(answer: GrantAnswer): boolean {
  switch (answer) {
    case 'granted':
    case 'granted-once':
      return true;
    case 'denied':
    case 'dismissed':
      return false;
  }
}

/** True when the user closed the prompt without answering. Never throws. */
export function isDismissed(answer: GrantAnswer): boolean {
  return answer === 'dismissed';
}

/**
 * The core's decision for `answer`. Throws `ERRORS.PERMISSION_DIALOG_DISMISSED` on a dismissal, so the core stores
 * nothing and the next request asks again.
 */
export function toPermissionDecision(answer: GrantAnswer): PermissionDecision {
  switch (answer) {
    case 'granted':
      return 'AllowAlways';
    case 'granted-once':
      return 'AllowOnce';
    case 'denied':
      return 'Deny';
    case 'dismissed':
      // The core keeps every answer but AllowOnce, so a dismissal rejects and the next request asks again.
      throw new Error(ERRORS.PERMISSION_DIALOG_DISMISSED);
  }
}

/** The status the host records for `answer`, null when it records none. Never throws. */
export function getLastingStatus(answer: GrantAnswer): Exclude<PermissionStatus, 'ask'> | null {
  switch (answer) {
    case 'granted':
      return 'granted';
    case 'denied':
      return 'denied';
    case 'granted-once':
    case 'dismissed':
      return null;
  }
}
