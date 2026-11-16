// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import s from './ScrollFades.module.css';

/** The class that draws the fades `wireScrollFades` turns on. */
export const SCROLL_FADES_CLASS = s['fades'];

/** Below a pixel, a scroll offset is rounding, not content past the edge. */
const EDGE_SLACK_PX = 1;

/**
 * Marks which edges of the horizontal `scroller` have content past them, as `data-fade-start` and `data-fade-end`, so
 * `SCROLL_FADES_CLASS` fades only those. Scroll-driven CSS would do it without script, but is newer than the browsers
 * the panel supports. Follows scrolls, resizes and added children. Returns its dispose. Never throws.
 */
export function wireScrollFades(scroller: HTMLElement): () => void {
  function update(): void {
    const { scrollLeft, scrollWidth, clientWidth } = scroller;
    scroller.toggleAttribute('data-fade-start', scrollLeft > EDGE_SLACK_PX);
    scroller.toggleAttribute('data-fade-end', scrollWidth - clientWidth - scrollLeft > EDGE_SLACK_PX);
  }
  // The content can grow while the scroller keeps its size, so its children are watched too.
  const resizes = new ResizeObserver(update);
  function observeChildren(): void {
    for (const child of scroller.children) {
      resizes.observe(child);
    }
  }
  const mutations = new MutationObserver(() => {
    observeChildren();
    update();
  });
  resizes.observe(scroller);
  observeChildren();
  mutations.observe(scroller, { childList: true });
  scroller.addEventListener('scroll', update, { passive: true });
  return () => {
    resizes.disconnect();
    mutations.disconnect();
    scroller.removeEventListener('scroll', update);
  };
}
