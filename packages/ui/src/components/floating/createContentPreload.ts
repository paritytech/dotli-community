// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onSettled } from 'solid-js';
import { preloadWhenIdle } from '../../page/preloadWhenIdle.js';

type Params = {
  /** The content's chunk loader, undefined for content with none. */
  content: () => (() => Promise<unknown>) | undefined;
};

/**
 * Preloads the content's chunk when the browser is idle, so the first opening doesn't wait on the network. Called inside
 * a component, which cancels the preload when it is disposed. Never throws.
 */
export function createContentPreload({ content }: Params): void {
  onSettled(() => {
    const preload = content();
    return preload === undefined ? undefined : preloadWhenIdle({ preload });
  });
}
