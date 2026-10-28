// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { RendererContext } from './types.js';

/** One page render's state: the island render ids it hands out and the style keys its islands have emitted. */
export type PageRenderState = ReturnType<typeof createPageRenderState>;

const pageRenderStates = new WeakMap<RendererContext['result'], PageRenderState>();

/** Returns the render state of the page `result` belongs to, made on first use. Never throws. */
export function getPageRenderState(result: RendererContext['result']): PageRenderState {
  const existing = pageRenderStates.get(result);
  if (existing !== undefined) {
    return existing;
  }
  const state = createPageRenderState();
  pageRenderStates.set(result, state);
  return state;
}

function createPageRenderState() {
  let renderCount = 0;
  const claimedStyles = new Set<string>();

  return {
    /** Returns the next island's render id on this page (`s0`, `s1`, ...) and counts it. Never throws. */
    claimRenderId,
    /** Returns whether `key` is new on this page, and records it, so a style ships once per page. Never throws. */
    claimStyle,
  };

  function claimRenderId(): string {
    const id = `s${renderCount.toString()}`;
    renderCount += 1;
    return id;
  }

  function claimStyle(key: string): boolean {
    if (claimedStyles.has(key)) {
      return false;
    }
    claimedStyles.add(key);
    return true;
  }
}
