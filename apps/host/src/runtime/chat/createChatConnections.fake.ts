// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HostChatActionSubscribeItem, HostRendererActionSubscribeItem } from '@parity/truapi';
import type { RenderSink } from '@parity/truapi-host';
import type { ChatConnection } from './createChatConnections.js';

type Params = {
  /** Every publish rejects, as for a product that cannot be reached. */
  fails?: boolean;
  /** Every render fails at once through its sink's `onError`. */
  failsRender?: boolean;
};

/** One render the connection was asked for. */
export type RecordedRender = {
  sink: RenderSink;
  /** Set once the render's returned stop ran. */
  stopped: boolean;
};

/** A product connection that records what reaches the product. */
export function createRecordingConnection({ fails = false, failsRender = false }: Params = {}): ChatConnection & {
  renders: RecordedRender[];
  published: HostChatActionSubscribeItem[];
  rendererActions: HostRendererActionSubscribeItem[];
} {
  const published: HostChatActionSubscribeItem[] = [];
  const rendererActions: HostRendererActionSubscribeItem[] = [];
  const renders: RecordedRender[] = [];
  const settlePublish = (): Promise<void> =>
    fails ? Promise.reject(new Error('product unreachable')) : Promise.resolve();
  return {
    published,
    rendererActions,
    renders,
    publish(action) {
      published.push(action);
      return settlePublish();
    },
    publishRendererAction(item) {
      rendererActions.push(item);
      return settlePublish();
    },
    render(_request, sink) {
      const recorded: RecordedRender = { sink, stopped: false };
      renders.push(recorded);
      if (failsRender) {
        sink.onError?.(new Error('rendering unavailable'));
      }
      return () => {
        recorded.stopped = true;
      };
    },
  };
}
