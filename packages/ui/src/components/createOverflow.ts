// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onSettled } from 'solid-js';

/**
 * Whether an element's content is taller than its box, measured once the element settles and again each time the
 * box resizes. Content that changes inside a box of a fixed size is not seen.
 */
export function createOverflow() {
  let element: HTMLElement | undefined;
  const [overflows, setOverflows] = createSignal(false);
  function measure(): void {
    setOverflows(element !== undefined && element.scrollHeight > element.clientHeight);
  }
  onSettled(() => {
    measure();
    if (element === undefined || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  });
  return {
    /** The element to watch, passed as its `ref`. */
    ref: (el: HTMLElement): void => {
      element = el;
    },
    overflows,
  };
}
