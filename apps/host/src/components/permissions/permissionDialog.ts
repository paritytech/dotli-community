// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModalButton, ModalView } from '@dotli/ui';
import { permissionIcon } from './permissionIcons.js';
import { PERMISSION_CATALOG, type EnforceablePermissionName } from '../../runtime/permissionPolicy.js';
import type { GrantAnswer } from '../../runtime/hostPrompts.js';

export type PermissionRequest = {
  /** The app's name as the user reads it. */
  app: string;
  permission: EnforceablePermissionName;
  /** Offers a one-time grant beside the lasting one. */
  allowOnce: boolean;
  /** Granting rebuilds the app's frame, so the dialog says the app reloads. */
  reloads: boolean;
};

type GetGrantButtonsParams = {
  /** Offers a one-time grant beside the lasting one. */
  allowOnce: boolean;
  /** The allow button's label when no one-time grant is offered. */
  allowLabel?: string;
  /** The deny button's label. */
  denyLabel?: string;
};

/** The dialog an app's request for a permission asks the user with. */
export function permissionRequestDialog(request: PermissionRequest): ModalView<GrantAnswer> {
  return {
    icon: permissionIcon(request.permission),
    title: 'Permission Request',
    fields: [
      { label: 'Application', value: request.app },
      { label: 'Permission', value: PERMISSION_CATALOG[request.permission].description },
    ],
    ...(request.reloads ? { notice: 'Granting this permission will reload the application.' } : {}),
    buttons: getGrantButtons({ allowOnce: request.allowOnce }),
    dismissOnBackdrop: true,
    dismissResult: 'dismissed',
  };
}

/**
 * The answer buttons of a grant dialog: Deny, then Allow, or Always allow and Allow once when a one-time grant is
 * offered. Never throws.
 */
export function getGrantButtons({
  allowOnce,
  allowLabel = 'Allow',
  denyLabel = 'Deny',
}: GetGrantButtonsParams): ModalButton<GrantAnswer>[] {
  // Every deny refuses the request, so it is drawn destructive.
  const deny: ModalButton<GrantAnswer> = { label: denyLabel, variant: 'danger', result: 'denied' };
  if (!allowOnce) {
    return [deny, { label: allowLabel, variant: 'primary', result: 'granted' }];
  }
  return [
    deny,
    { label: 'Always allow', variant: 'secondary', result: 'granted' },
    { label: 'Allow once', variant: 'primary', result: 'granted-once' },
  ];
}
