// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Component } from 'solid-js';
import { dynamic, type JSX } from '@solidjs/web';
import type { IconProps } from './icon-props.js';

/** Draws the icon component a prop carries, and redraws when the prop changes. */
export function DrawIcon(props: { icon: Component<IconProps>; class?: JSX.ClassValue }): JSX.Element {
  const Icon = dynamic(() => props.icon);
  return <Icon class={props.class} />;
}
