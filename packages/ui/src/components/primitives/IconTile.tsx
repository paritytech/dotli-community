// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show, type Component } from 'solid-js';
import { dynamic, type JSX } from '@solidjs/web';
import type { IconProps } from '../icons/icon-props.js';
import s from './IconTile.module.css';

/** The decorative tile that leads a modal or the sign-in's pending view. It draws `icon`, or else its children. */
export function IconTile(props: {
  icon?: Component<IconProps> | undefined;
  class?: string | undefined;
  testId?: string | undefined;
  children?: JSX.Element;
}): JSX.Element {
  const Icon = dynamic(() => props.icon);
  return (
    <div class={[s['tile'], props.class]} aria-hidden="true" data-testid={props.testId}>
      <Show when={props.icon} fallback={props.children}>
        <Icon />
      </Show>
    </div>
  );
}
