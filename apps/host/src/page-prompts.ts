// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The runtime's questions to the user, answered with the page's dialogs and notifications. Only the bridge chunk imports
// this, so the dialogs stay out of boot.

import { withActiveTld } from '@dotli/config';
import type { HostPrompts } from './runtime/host-prompts.js';
import { isDevicePermission } from './runtime/permissions.js';
import { openModal, showNotification, type ModalHandoff, type ModalOutcome, type ModalView } from '@dotli/ui';
import { permissionRequestDialog } from './components/permissions/permission-dialog.js';
import { preimageSubmitDialog } from './components/permissions/preimage-dialog.js';

export type HostPromptsDeps = {
  /** Where the dialogs queue. The page's overlays by default. */
  present?: typeof openModal | undefined;
  notify?: HostPrompts['notify'] | undefined;
};

/** The host's tests find any of its prompts by this id. */
const HOST_PROMPT_TEST_ID = 'host-prompt';

/** The user's answers come from the page's dialogs, and the runtime's notices are the page's notifications. */
export function createHostPrompts({
  present = openModal,
  notify = showNotification,
}: HostPromptsDeps = {}): HostPrompts {
  const ask = <R extends string>(
    view: ModalView<R>,
    signal: AbortSignal,
    handoff?: (outcome: ModalOutcome<R>) => ModalHandoff | undefined,
  ) => present({ ...view, testId: HOST_PROMPT_TEST_ID }, signal, handoff);
  return {
    askPermission: async (label, permission, signal, { allowOnce }) => {
      const dialog = permissionRequestDialog({
        app: withActiveTld(label),
        permission,
        allowOnce,
        reloads: isDevicePermission(permission),
      });
      return (await ask(dialog, signal)).result;
    },
    confirmPreimage: async (label, size, signal) =>
      (await ask(preimageSubmitDialog({ app: withActiveTld(label), dataSize: size }), signal)).result === 'allow',
    confirmReview: async (dialog, signal, handoff) =>
      (await ask(dialog, signal, outcome => handoff?.(outcome.result))).result,
    notify,
  };
}

/** The page's prompts, over its dialogs and notifications. */
export const hostPrompts: HostPrompts = createHostPrompts();
