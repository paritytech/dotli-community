// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { IconComponent } from '@dotli/ui-core';
import type { IconProps } from './icon-props.js';

/**
 * The icon a toast or dialog carries, as the component it is. ui-core types it without Solid, so it says no more than
 * that it renders something, and every icon it is given is one of the UI packages' icon components.
 */
export function storeIcon(icon: IconComponent): (props: IconProps) => JSX.Element {
  return icon as (props: IconProps) => JSX.Element;
}
