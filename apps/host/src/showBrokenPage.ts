// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { RotateCwIcon } from '@dotli/ui/icons';
import { showError } from '@dotli/ui';

/** For a page of the host's own, such as the landing page, that cannot show. */
export function showBrokenPage(reload: () => void = reloadPage): void {
  showError('Something went wrong on our side', {
    detail: "This page didn't load properly. Reloading usually fixes it.",
    action: { label: 'Reload', icon: RotateCwIcon, onClick: reload },
  });
}

function reloadPage(): void {
  window.location.reload();
}
