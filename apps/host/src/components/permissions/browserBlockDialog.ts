// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModalView } from '@dotli/ui';
import { permissionIcon } from './permissionIcons.js';
import { PERMISSION_CATALOG, type EnforceablePermissionName } from '../../runtime/permissionPolicy.js';
import type { BrowserBlockAnswer } from '../../runtime/hostPrompts.js';

type BrowserBlockRequest = {
  /** The app's name as the user reads it. */
  app: string;
  permission: EnforceablePermissionName;
  /** The browser still denied after a Retry, so the notice says so. */
  retried: boolean;
};

const BLOCK_NOTICE =
  "You allowed this in dot.li, but your browser blocks it, so the app cannot use it. Allow it for this site in your browser's settings, then retry. Or restrict the app's access.";

/** The dialog that tells the user their browser blocks a permission dot.li granted. */
export function browserBlockDialog(request: BrowserBlockRequest): ModalView<BrowserBlockAnswer> {
  return {
    icon: permissionIcon(request.permission),
    title: 'Blocked by your browser',
    fields: [
      { label: 'Application', value: request.app },
      { label: 'Permission', value: PERMISSION_CATALOG[request.permission].description },
    ],
    notice: request.retried ? `Your browser still blocks it. ${BLOCK_NOTICE}` : BLOCK_NOTICE,
    buttons: [
      { label: 'Restrict access for product', variant: 'danger', result: 'restrict' },
      { label: 'Retry', variant: 'primary', result: 'retry' },
    ],
    dismissOnBackdrop: true,
    dismissResult: 'dismissed',
  };
}
