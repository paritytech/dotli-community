// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A provider decorator that fails on demand, for tests of a send that throws.

import type { Provider } from '../provider.js';

/** Wraps a provider so its posts throw `broken` while the test has it broken. */
export function createBreakablePosts(broken: Error) {
  let posting = true;
  return {
    wrap: (provider: Provider): Provider => ({
      ...provider,
      postMessage: message => {
        if (!posting) {
          throw broken;
        }
        provider.postMessage(message);
      },
    }),
    breakPosts: () => {
      posting = false;
    },
    mendPosts: () => {
      posting = true;
    },
  };
}
