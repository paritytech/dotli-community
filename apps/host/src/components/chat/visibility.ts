// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Calls `onChange` as `el` scrolls in and out of view, until the returned stop. */
export type WatchVisibility = (el: Element, onChange: (visible: boolean) => void) => () => void;

/** Watches with `Observer`, the browser's IntersectionObserver or a test's stand-in. */
export function visibilityWatcher(Observer: typeof IntersectionObserver): WatchVisibility {
  return (el, onChange) => {
    const observer = new Observer(entries => {
      for (const entry of entries) {
        onChange(entry.isIntersecting);
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  };
}
