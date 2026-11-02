// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The live product connections chat reaches the product through, one stack per product.

import type {
  HostChatActionSubscribeItem,
  HostRendererActionSubscribeItem,
  ProductRendererRenderRequest,
} from '@parity/truapi';
import type { RenderSink } from '@parity/truapi-host';

/** Live handles for one product's Worker-kind core connection. */
export type ChatConnection = {
  /** Hands a user-side chat action to the product. Rejects when it cannot reach the product. */
  publish(action: HostChatActionSubscribeItem): Promise<void>;
  /** Hands a gesture made inside a custom message's tree to the product. Rejects when it cannot reach the product. */
  publishRendererAction(item: HostRendererActionSubscribeItem): Promise<void>;
  /**
   * Streams the product's trees for `request` into `sink` until the returned function disposes it. Never throws: a
   * failure reaches `sink.onError`.
   */
  render(request: ProductRendererRenderRequest, sink: RenderSink): () => void;
};

export type ChatConnections = ReturnType<typeof createChatConnections>;

/** Builds an empty registry of live product connections, one stack per product. Never throws. */
export function createChatConnections() {
  // A stack per product, as a render registers before the one on screen goes.
  const connections = new Map<string, ChatConnection[]>();

  return {
    /**
     * Makes `connection` the one that answers for `productId` until the returned function unregisters it. The newest
     * registration answers. Unregistering one leaves the others, so a render that failed hands chat back to the product
     * still on screen. Never throws.
     */
    register(productId: string, connection: ChatConnection): () => void {
      const stack = connections.get(productId) ?? [];
      stack.push(connection);
      connections.set(productId, stack);
      return unregister;

      function unregister(): void {
        const registered = connections.get(productId);
        const index = registered?.lastIndexOf(connection) ?? -1;
        if (registered === undefined || index < 0) {
          return;
        }
        registered.splice(index, 1);
        if (registered.length === 0) {
          connections.delete(productId);
        }
      }
    },

    /** The newest live connection for `productId`, or undefined while none is registered. Never throws. */
    get(productId: string): ChatConnection | undefined {
      return connections.get(productId)?.at(-1);
    },
  };
}

/** The page's product connections. */
export const chatConnections = createChatConnections();
