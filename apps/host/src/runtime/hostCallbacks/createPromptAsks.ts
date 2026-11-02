// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HostPrompts } from '../hostPrompts.js';
import type { HostAsks } from './createHostCallbacks.js';
import { createPromptPermission, type PromptPermissionStores } from './createPromptPermission.js';
import { createUserConfirmationAdapters } from './createUserConfirmationAdapters.js';

type Params = {
  /** The page's prompts the asks are shown through. */
  prompts: HostPrompts;
  /** The page's permissions the prompts read and record. */
  permissions: PromptPermissionStores;
};

/** Answers the core's asks by showing the page's prompts, and reads and records the permissions they decide. */
export function createPromptAsks({ prompts, permissions }: Params): HostAsks {
  return ({ label, blockingModalScope, phoneRequests }) => ({
    permissions: createPromptPermission({
      label,
      ask: prompts.askPermission,
      notify: prompts.notify,
      permissions,
      modalScope: blockingModalScope,
    }),
    userConfirmation: createUserConfirmationAdapters({
      label,
      prompts,
      modalScope: blockingModalScope,
      phoneRequests,
    }),
  });
}
