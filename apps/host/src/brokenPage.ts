// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { RotateCwIcon } from '@dotli/ui/icons';
import { showError } from '@dotli/ui';

function pageReload(): void {
  window.location.reload();
}

/** For a page of the host's own, such as the landing page, that cannot show. */
export function showBrokenPage(reload: () => void = pageReload): void {
  showError('Something went wrong on our side', "This page didn't load properly. Reloading usually fixes it.", {
    label: 'Reload',
    icon: RotateCwIcon,
    onClick: reload,
  });
}
