// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProductRendererRenderRequest } from '@parity/truapi';
import type { RenderSink } from '@parity/truapi-host';
import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, type HandlerOf, type MachineTypes, type Transition } from '@dotli/shared';
import type { ChatConnection, ChatConnections } from './createChatConnections.js';

export type RenderCustomMessageParams = {
  /** The product that renders the message. */
  productId: string;
  /** The custom message to render. */
  request: ProductRendererRenderRequest;
  /** Where the trees stream. */
  sink: RenderSink;
};

type StartCustomRenderParams = RenderCustomMessageParams & {
  /** The live product connections the render follows. */
  connections: Pick<ChatConnections, 'get' | 'onRegister'>;
};

/** One render on one connection. Its sink's callbacks carry it, so a late one finds its attempt gone. */
type Attempt = { connection: ChatConnection };

/** One custom message render: rendering, failing over, waiting for the product's next connection, or done. */
type RenderState =
  | { kind: 'starting' }
  | { kind: 'rendering'; attempt: Attempt; stop: () => void }
  | { kind: 'failing'; failed: ChatConnection }
  | { kind: 'waiting'; stopListening: () => void }
  | { kind: 'completed' }
  | { kind: 'disposed' };

type RenderEvent =
  | { kind: 'started' }
  | { kind: 'treeUpdated'; attempt: Attempt; node: Parameters<RenderSink['onUpdate']>[0] }
  | { kind: 'renderCompleted'; attempt: Attempt }
  | { kind: 'renderFailed'; attempt: Attempt; error: Error }
  | { kind: 'movedOn' }
  | { kind: 'registered'; productId: string }
  | { kind: 'disposed' };

type RenderMachine = MachineTypes<RenderState, RenderEvent>;

export const NOT_CONNECTED = 'Chat is not connected for this product';

const report = createReporter({ flow: 'chat' });

/**
 * One custom message render transition that threw, after which the render keeps the state its handler emitted.
 * Tagged `outcome` (error) and `reason` (the error's name).
 */
const renderTransitionMetric = defineCount<'error'>('chat.render_transition');

/**
 * Renders a custom message on the product's newest connection, and after a failed render on the next one, until the
 * returned function disposes it. Never throws.
 */
export function startCustomRender({ connections, productId, request, sink }: StartCustomRenderParams): () => void {
  /** Ends the render and releases what its state held. */
  const disposeRender: HandlerOf<RenderMachine, 'starting' | 'rendering' | 'failing' | 'waiting', 'disposed'> = (
    state,
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'disposed' });
    switch (state.kind) {
      case 'rendering':
        state.stop();
        return;
      case 'waiting':
        state.stopListening();
        return;
      case 'starting':
      case 'failing':
        return;
    }
  };
  const render = createStateMachine<RenderMachine>({
    initial: { kind: 'starting' },
    handlers: {
      starting: {
        started(_state, _event, transition) {
          const connection = connections.get(productId);
          if (connection !== undefined) {
            renderOn(connection, transition);
            return;
          }
          wait(transition);
          sink.onError?.(new Error(NOT_CONNECTED));
        },
        disposed: disposeRender,
      },
      rendering: {
        treeUpdated(state, { attempt, node }) {
          if (attempt !== state.attempt) {
            return;
          }
          sink.onUpdate(node);
        },
        renderCompleted(state, { attempt }, { emitState }) {
          if (attempt !== state.attempt) {
            return;
          }
          emitState({ kind: 'completed' });
          sink.onComplete?.();
        },
        renderFailed(state, { attempt, error }, { emitState, update }) {
          if (attempt !== state.attempt) {
            return;
          }
          emitState({ kind: 'failing', failed: attempt.connection });
          // The sink hears the error before any tree of the next render, and may dispose the render as it hears it.
          try {
            sink.onError?.(error);
          } finally {
            update({ kind: 'movedOn' });
            state.stop();
          }
        },
        disposed: disposeRender,
      },
      failing: {
        movedOn({ failed }, _event, transition) {
          const newest = connections.get(productId);
          if (newest === undefined || newest === failed) {
            wait(transition);
            return;
          }
          renderOn(newest, transition);
        },
        disposed: disposeRender,
      },
      waiting: {
        registered(state, { productId: registered }, transition) {
          if (registered !== productId) {
            return;
          }
          const connection = connections.get(productId);
          if (connection === undefined) {
            return;
          }
          renderOn(connection, transition);
          state.stopListening();
        },
        disposed: disposeRender,
      },
      completed: null,
      disposed: null,
    },
    onError: error => {
      report.defect(error, {
        step: 'render_transition',
        metric: renderTransitionMetric,
        message: '[dot.li chat] A custom message render transition threw',
      });
    },
  });

  render.update({ kind: 'started' });
  return () => {
    render.update({ kind: 'disposed' });
  };

  function renderOn(connection: ChatConnection, { emitState, update }: Transition<RenderMachine>): void {
    const attempt: Attempt = { connection };
    const stop = connection.render(request, {
      onUpdate: node => {
        update({ kind: 'treeUpdated', attempt, node });
      },
      onComplete: () => {
        update({ kind: 'renderCompleted', attempt });
      },
      onError: error => {
        update({ kind: 'renderFailed', attempt, error });
      },
    });
    emitState({ kind: 'rendering', attempt, stop });
  }

  function wait({ emitState, update }: Transition<RenderMachine>): void {
    const stopListening = connections.onRegister(registered => {
      update({ kind: 'registered', productId: registered });
    });
    emitState({ kind: 'waiting', stopListening });
  }
}
