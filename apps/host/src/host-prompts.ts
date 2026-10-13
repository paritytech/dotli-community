// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The runtime's questions to the user, answered with the page's dialogs and notifications. Only the chunk that loads
// beside the bridge imports this, so the dialogs stay out of boot.

import { withActiveTld } from '@dotli/config';
import { type HostPrompts, isDevicePermission } from '@dotli/host-runtime';
import { openModal } from '@dotli/ui';
import { showNotification } from '@dotli/ui-widgets';
import { permissionIcon } from '@dotli/ui-entities';
import { permissionRequestDialog } from './components/permissions/permission-dialog.js';
import { preimageSubmitDialog } from './components/permissions/preimage-dialog.js';
import { currentProductFrame } from './product-frame-layout.js';

const SIGN_ICON = permissionIcon('ChainSubmit');

// The product raised these dialogs, so each returns focus to its frame when the element it came from is gone.
const FROM_PRODUCT = { focusFallback: () => currentProductFrame() ?? undefined };

export interface HostPromptsDeps {
  /** Where the dialogs queue. The page's overlays by default. */
  present?: typeof openModal | undefined;
  notify?: HostPrompts['notify'] | undefined;
}

/** The user's answers come from the page's dialogs, and the runtime's notices are the page's notifications. */
export function createHostPrompts({
  present = openModal,
  notify = showNotification,
}: HostPromptsDeps = {}): HostPrompts {
  return {
    askPermission: async (label, permission, signal, { allowOnce }) => {
      const dialog = permissionRequestDialog({
        app: withActiveTld(label),
        permission,
        allowOnce,
        reloads: isDevicePermission(permission),
      });
      return (await present(dialog, signal, FROM_PRODUCT)).result;
    },
    confirmPreimage: async (size, signal) =>
      (await present(preimageSubmitDialog(size), signal, FROM_PRODUCT)).result === 'allow',
    confirmReview: async ({ icon, ...dialog }, signal) =>
      (await present(icon === 'sign' ? { ...dialog, icon: SIGN_ICON } : dialog, signal, FROM_PRODUCT)).result,
    notify,
  };
}
