// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The violation panel's mount against the page's frame layout: the height a panel reports keeps the product frame
// clear of it. The panel itself is tested by its story plays.

import { afterEach, describe, expect, it } from 'vitest';
import { flush, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { mountViolationPanel } from '../../../src/components/sandbox-checker/mount.js';
import { attachProductFrame, type FrameBox, resetProductFrameLayout } from '../../../src/product-frame-layout.js';

/** A panel covering 120 px at the bottom while it shows. */
function StandInPanel(props: { onReserve: (bottom: number) => void }): JSX.Element {
  // eslint-disable-next-line solid/reactivity -- the stand-in reports its height once as it mounts, nothing to track
  props.onReserve(120);
  onCleanup(() => {
    props.onReserve(0);
  });
  return <div id="sandbox-checker-panel" />;
}

afterEach(() => {
  resetProductFrameLayout();
  document.body.replaceChildren();
});

describe('violation panel mount', () => {
  it('As a dotli developer, the product frame ends above the panel and takes its full height back as the panel goes', () => {
    // Given
    const boxes: FrameBox[] = [];
    const iframe = document.createElement('iframe');
    attachProductFrame(iframe, (_frame, box) => {
      boxes.push(box);
    });

    // When
    const dispose = mountViolationPanel(iframe, StandInPanel);
    flush();

    // Then
    expect(document.getElementById('sandbox-checker-panel')?.isConnected).toBe(true);
    expect(boxes.at(-1)).toMatchObject({ right: 0, bottom: 120 });

    // When
    dispose();

    // Then
    expect(document.getElementById('sandbox-checker-panel')).toBeNull();
    expect(boxes.at(-1)).toMatchObject({ right: 0, bottom: 0 });
  });
});
