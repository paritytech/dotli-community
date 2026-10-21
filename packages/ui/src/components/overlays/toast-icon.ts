// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Component } from 'solid-js';
import { AlertTriangleIcon } from '../icons/AlertTriangleIcon.js';
import { BanIcon } from '../icons/BanIcon.js';
import { BellIcon } from '../icons/BellIcon.js';
import { CheckIcon } from '../icons/CheckIcon.js';
import type { IconProps } from '../icons/icon-props.js';
import type { StatusTone } from '../../page/status-tone.js';
import type { ToastEntry } from '../../page/state/toasts.js';

const TONE_ICON: Record<StatusTone, Component<IconProps>> = {
  info: BellIcon,
  ok: CheckIcon,
  warn: AlertTriangleIcon,
  err: AlertTriangleIcon,
  idle: BanIcon,
  quiet: BellIcon,
};

/** Chosen here, when the toast renders, so pushing a toast imports no component. */
export function toastIcon(entry: Pick<ToastEntry, 'icon' | 'tone'>): Component<IconProps> {
  return entry.icon ?? TONE_ICON[entry.tone];
}
