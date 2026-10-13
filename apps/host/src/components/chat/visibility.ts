// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Calls `onChange` as `el` scrolls in and out of view, until the returned stop. */
export type WatchVisibility = (el: Element, onChange: (visible: boolean) => void) => () => void;

/** Watches with `Observer`. Without one every row counts as in view at once. */
export function visibilityWatcher(Observer: typeof IntersectionObserver | undefined): WatchVisibility {
  return (el, onChange) => {
    if (Observer === undefined) {
      onChange(true);
      return () => undefined;
    }
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
