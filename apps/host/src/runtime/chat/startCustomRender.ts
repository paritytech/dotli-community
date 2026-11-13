// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProductRendererRenderRequest, RendererNode } from '@parity/truapi';
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
  | { kind: 'waiting'; stop: () => void }
  | { kind: 'completed' }
  | { kind: 'disposed' };

type RenderEvent =
  | { kind: 'started' }
  | { kind: 'treeUpdated'; attempt: Attempt; node: RendererNode }
  | { kind: 'renderCompleted'; attempt: Attempt }
  | { kind: 'renderFailed'; attempt: Attempt; error: Error }
  | { kind: 'movedOn' }
  | { kind: 'registered'; productId: string }
  | { kind: 'disposed' };

/** What the sink hears, and the stop of a render or a listener the state let go of. */
type RenderEffect =
  | { kind: 'treeUpdated'; node: RendererNode }
  | { kind: 'completed' }
  | { kind: 'errored'; error: Error }
  | { kind: 'released'; stop: () => void }
  // Sent once the sink heard the error, so a sink that disposes the render as it hears it stops it before any next one.
  | { kind: 'movedOn' };

type RenderMachine = MachineTypes<RenderState, RenderEvent, RenderEffect>;

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
  /** Ends the render and stops the render or the listener its state held. */
  const disposeRender: HandlerOf<RenderMachine, 'rendering' | 'waiting', 'disposed'> = (
    { stop },
    _event,
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'disposed' });
    emitSideEffect({ kind: 'released', stop });
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
          transition.emitSideEffect({ kind: 'errored', error: new Error(NOT_CONNECTED) });
        },
      },
      rendering: {
        treeUpdated(state, { attempt, node }, { emitSideEffect }) {
          if (attempt !== state.attempt) {
            return;
          }
          emitSideEffect({ kind: 'treeUpdated', node });
        },
        renderCompleted(state, { attempt }, { emitState, emitSideEffect }) {
          if (attempt !== state.attempt) {
            return;
          }
          emitState({ kind: 'completed' });
          emitSideEffect({ kind: 'completed' });
        },
        renderFailed(state, { attempt, error }, { emitState, emitSideEffect }) {
          if (attempt !== state.attempt) {
            return;
          }
          emitState({ kind: 'failing', failed: attempt.connection });
          emitSideEffect({ kind: 'errored', error });
          emitSideEffect({ kind: 'released', stop: state.stop });
          emitSideEffect({ kind: 'movedOn' });
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
        disposed(_state, _event, { emitState }) {
          emitState({ kind: 'disposed' });
        },
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
          transition.emitSideEffect({ kind: 'released', stop: state.stop });
        },
        disposed: disposeRender,
      },
      completed: null,
      disposed: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'treeUpdated':
          sink.onUpdate(effect.node);
          return;
        case 'completed':
          sink.onComplete?.();
          return;
        case 'errored':
          sink.onError?.(effect.error);
          return;
        case 'released':
          effect.stop();
          return;
        case 'movedOn':
          render.update({ kind: 'movedOn' });
          return;
      }
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
    const stop = connections.onRegister(registered => {
      update({ kind: 'registered', productId: registered });
    });
    emitState({ kind: 'waiting', stop });
  }
}
