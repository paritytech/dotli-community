// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The runtime's questions to the user, answered with the page's dialogs and notifications. Only the bridge chunk imports
// this, so the dialogs stay out of boot.

import { withActiveTld } from '@dotli/config';
import type { HostPrompts } from './runtime/hostPrompts.js';
import { isDevicePermission } from './runtime/permissionPolicy.js';
import { modals, showNotification, type ModalHandoff, type ModalOutcome, type ModalView } from '@dotli/ui';
import { permissionRequestDialog } from './components/permissions/permissionDialog.js';

type Params = {
  /** Where the dialogs queue. The page's overlays by default. */
  present?: typeof modals.open | undefined;
  notify?: HostPrompts['notify'] | undefined;
};

type AskParams<Result extends string> = {
  view: ModalView<Result>;
  signal: AbortSignal;
  handoff?: ((outcome: ModalOutcome<Result>) => ModalHandoff | undefined) | undefined;
};

/** The host's tests find any of its prompts by this id. */
const HOST_PROMPT_TEST_ID = 'host-prompt';

/** The user's answers come from the page's dialogs, and the runtime's notices are the page's notifications. */
export function createHostPrompts({ present = modals.open, notify = showNotification }: Params = {}): HostPrompts {
  const ask = <Result extends string>({ view, signal, handoff }: AskParams<Result>) =>
    present({ ...view, testId: HOST_PROMPT_TEST_ID }, { signal, handoff });
  return {
    async askPermission({ label, permission, signal, allowOnce }) {
      const dialog = permissionRequestDialog({
        app: withActiveTld(label),
        permission,
        allowOnce,
        reloads: isDevicePermission(permission),
      });
      return (await ask({ view: dialog, signal })).result;
    },
    confirmReview: async ({ dialog, signal, handoff }) =>
      (await ask({ view: dialog, signal, handoff: outcome => handoff?.(outcome.result) })).result,
    notify,
  };
}

/** The page's prompts, over its dialogs and notifications. */
export const hostPrompts: HostPrompts = createHostPrompts();
