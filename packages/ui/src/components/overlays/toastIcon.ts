// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Component } from 'solid-js';
import { AlertTriangleIcon } from '../icons/AlertTriangleIcon.js';
import { BanIcon } from '../icons/BanIcon.js';
import { BellIcon } from '../icons/BellIcon.js';
import { CircleCheckIcon } from '../icons/CircleCheckIcon.js';
import { CircleXIcon } from '../icons/CircleXIcon.js';
import { InfoIcon } from '../icons/InfoIcon.js';
import type { IconProps } from '../icons/iconProps.js';
import type { StatusTone } from '../../page/statusTone.js';
import type { ToastEntry } from '../../page/state/createToasts.js';

const TONE_ICON: Record<StatusTone, Component<IconProps>> = {
  info: InfoIcon,
  ok: CircleCheckIcon,
  warn: AlertTriangleIcon,
  err: CircleXIcon,
  idle: BanIcon,
  quiet: BellIcon,
};

/**
 * Chosen here, when the toast renders, so pushing a toast imports no component. A warning always shows its triangle
 * and an error its crossed circle, so a toast's own icon never makes an alarm look like a notice.
 */
export function toastIcon(entry: Pick<ToastEntry, 'icon' | 'tone'>): Component<IconProps> {
  if (entry.tone === 'warn' || entry.tone === 'err') {
    return TONE_ICON[entry.tone];
  }
  return entry.icon ?? TONE_ICON[entry.tone];
}
