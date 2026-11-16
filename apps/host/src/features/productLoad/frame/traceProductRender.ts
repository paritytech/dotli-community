// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Timers } from '@dotli/shared';
import { debugBus, type DebugBusEvent } from '@dotli/truapi-debug';
import type { FrameProduct } from './createProductFrame.js';
import { getFrameProductId } from './productFrameUrl.js';

/** One render of a product, as the debug bus names it. */
type TracedRender = {
  product: FrameProduct;
  url: URL;
  flows: { render: string; bridge: string };
};

/** A render's milestones the debug bus hears. `setupReady` comes with the iframe whose load it hears next. */
export type RenderTrace =
  | { milestone: 'begun' | 'ready'; run: TracedRender }
  | { milestone: 'setupReady'; run: TracedRender; iframe: HTMLIFrameElement };

/** Tells the debug bus a render's milestone, and from a set-up frame its iframe's first load. */
export function traceProductRender(trace: RenderTrace, timers: Pick<Timers, 'now'>): void {
  const { product, url, flows } = trace.run;
  const { label, mode } = product;
  const productId = getFrameProductId(product);
  switch (trace.milestone) {
    case 'begun': {
      const begun: DebugBusEvent = {
        layer: 'render',
        event: 'iframe_begin',
        flowId: flows.render,
        timestamp: timers.now(),
        payload: { label, url: mode === 'iframe' ? product.url : url.toString(), mode },
      };
      const setupBegun: DebugBusEvent = {
        layer: 'bridge',
        event: 'setup_begin',
        flowId: flows.bridge,
        timestamp: timers.now(),
        payload: { label, productId },
      };
      for (const event of mode === 'iframe' ? [begun, setupBegun] : [setupBegun, begun]) {
        debugBus.emit(event);
      }
      return;
    }
    case 'setupReady':
      // Told after the frame was attached, which is in time: the iframe navigates to a network URL, so its load comes
      // in a later task.
      debugBus.emit({
        layer: 'bridge',
        event: 'setup_ready',
        flowId: flows.bridge,
        timestamp: timers.now(),
        payload: { label, productId },
      });
      trace.iframe.addEventListener(
        'load',
        () => {
          debugBus.emit({
            layer: 'bridge',
            event: 'iframe_load',
            flowId: flows.bridge,
            timestamp: timers.now(),
            payload: { label, productId, mode },
          });
        },
        { once: true },
      );
      return;
    case 'ready':
      debugBus.emit({
        layer: 'render',
        event: 'iframe_ready',
        flowId: flows.render,
        timestamp: timers.now(),
        payload: { label, mode },
      });
      return;
  }
}
