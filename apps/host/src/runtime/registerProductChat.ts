// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { noop } from '@dotli/shared';
import { chatConnections } from './chat/createChatConnections.js';
import type { CoreConnection } from './createPageCore.js';

/** Routes the page's chat for the product to its connection, until the returned removal. */
export function registerProductChat({ provider, productId }: CoreConnection): () => void {
  return chatConnections.register(productId, {
    publish: action =>
      provider.publishChatAction === undefined
        ? Promise.reject(new Error('chat publishing unavailable'))
        : provider.publishChatAction(action),
    publishRendererAction: item =>
      provider.publishRendererAction === undefined
        ? Promise.reject(new Error('renderer actions unavailable'))
        : provider.publishRendererAction(item),
    render(request, sink) {
      if (provider.render === undefined) {
        sink.onError?.(new Error('rendering unavailable'));
        return noop;
      }
      return provider.render(request, sink);
    },
  });
}
