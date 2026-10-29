// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isPhoneViewport } from '@dotli/ui';
import { getActionRoom } from './getActionRoom.js';

/**
 * Returns the open pill's max width less the rest of its row, the group's layout parent, or undefined while the page
 * has no bar or row. Neither changes while the pill morphs, even where the morph animates the pill's own max-width, so
 * items never pop in and out during a reveal.
 */
export function getTopbarActionRoom(group: HTMLElement, row: HTMLElement | null): number | undefined {
  if (isPhoneViewport()) {
    return group.clientWidth;
  }
  const bar = document.getElementById('topbar');
  if (bar === null || row === null) {
    return undefined;
  }
  return getActionRoom({
    pillMaxWidth: Number.parseFloat(getComputedStyle(bar).getPropertyValue('--topbar-max-width')),
    rowWidth: row.scrollWidth,
    groupWidth: group.getBoundingClientRect().width,
  });
}
