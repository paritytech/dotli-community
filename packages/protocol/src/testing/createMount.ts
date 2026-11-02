// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { FakeIframe } from './fakeIframe.js';
import type { MountEvent } from './types.js';

type Params = {
  /** What each iframe fires on its own once mounted, or null to leave its `load` to the test. */
  fires: MountEvent;
};

/** Where the frame mounts its iframe. Holds only fake iframes, each firing `fires` on its own once mounted. */
export function createMount({ fires }: Params) {
  const iframes = new Set<FakeIframe>();

  function appendChild<T>(node: T): T {
    if (!(node instanceof FakeIframe)) {
      throw new Error('the fake mount holds only fake iframes');
    }
    iframes.add(node);
    node.mount(() => iframes.delete(node), fires);
    return node;
  }

  return {
    /** The iframes mounted now. */
    iframes,
    /** Mounts `node`, which fires `fires` on its own. Throws for a node that is not a fake iframe. */
    appendChild,
  };
}
