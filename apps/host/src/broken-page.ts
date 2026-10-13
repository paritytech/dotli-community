// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { RotateCwIcon } from '@dotli/ui/icons';
import { showError } from '@dotli/ui-widgets';

/** For a page of the host's own, such as the landing page, that cannot show. */
export function showBrokenPage(): void {
  showError('Something went wrong on our side', "This page didn't load properly. Reloading usually fixes it.", {
    label: 'Reload',
    icon: RotateCwIcon,
    onClick: () => {
      window.location.reload();
    },
  });
}
