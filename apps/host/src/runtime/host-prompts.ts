// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How the runtime asks the user and tells them things, in the page's own dialogs and notifications.

import type { ModalHandoff, ModalView, ShowNotification } from '@dotli/ui';
import type { EnforceablePermissionName } from './permissions.js';

/** `dismissed` stays apart from `denied` so a dismissal stores no denial. */
export type PermissionPromptDecision = 'granted' | 'granted-once' | 'denied' | 'dismissed';

/** Each ask settles with the user's answer, and rejects with an AbortError once `signal` aborts. */
export interface HostPrompts {
  askPermission: (
    label: string,
    permission: EnforceablePermissionName,
    signal: AbortSignal,
    options: { allowOnce: boolean },
  ) => Promise<PermissionPromptDecision>;
  /** Resolves true when the user allows `label` to store a preimage of `size` bytes. */
  confirmPreimage: (label: string, size: number, signal: AbortSignal) => Promise<boolean>;
  /**
   * Resolves the result of the button the user chose. `handoff` sees every answer, and the step it returns takes the
   * dialog's place until that step closes.
   */
  confirmReview: <R extends string>(
    dialog: ModalView<R>,
    signal: AbortSignal,
    handoff?: (result: R) => ModalHandoff | undefined,
  ) => Promise<R>;
  notify: ShowNotification;
}
