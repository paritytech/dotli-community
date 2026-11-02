// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HostChatActionSubscribeItem, HostRendererActionSubscribeItem } from '@parity/truapi';
import type { ChatConnection } from './createChatConnections.js';

type Params = {
  /** Every publish rejects, as for a product that cannot be reached. */
  fails?: boolean;
};

/** A product connection that records what reaches the product. */
export function createRecordingConnection({ fails = false }: Params = {}): ChatConnection & {
  published: HostChatActionSubscribeItem[];
  rendererActions: HostRendererActionSubscribeItem[];
} {
  const published: HostChatActionSubscribeItem[] = [];
  const rendererActions: HostRendererActionSubscribeItem[] = [];
  const settlePublish = (): Promise<void> =>
    fails ? Promise.reject(new Error('product unreachable')) : Promise.resolve();
  return {
    published,
    rendererActions,
    publish(action) {
      published.push(action);
      return settlePublish();
    },
    publishRendererAction(item) {
      rendererActions.push(item);
      return settlePublish();
    },
    render: () => () => undefined,
  };
}
