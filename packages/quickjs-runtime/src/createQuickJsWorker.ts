// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's side of one VM that runs in a Web Worker: it starts the worker, hands it the files and the worker's end of
// the byte wire, answers its fetch asks, and hears its output and the run's end.

import type { HandlerOf, MachineTypes } from '@dotli/shared';
import { createDeferred, createStateMachine, listen, noop, toError } from '@dotli/shared';
import type { CallError } from '@dotli/transport';
import { createPortProvider, createTransport, ok } from '@dotli/transport';

import type { ModuleFiles } from './createModuleLoader.js';
import type { ConsoleSink } from './installConsole.js';
import type { QuickJsVmError } from './quickJsVmError.js';
import { createWorkerPortsMessage, quickJsWorkerSchema } from './quickJsWorkerSchema.js';

export type QuickJsWorkerParams = {
  /** Starts the Web Worker that serves the VM from the package's `./worker` entry. */
  createWorker: () => EventTarget & {
    postMessage(message: unknown, transfer: Transferable[]): void;
    terminate(): void;
  };
  /** The module files, by path. Imports resolve against them alone. */
  files: ModuleFiles;
  /** The path in `files` of the ES module the worker runs. */
  entrypoint: string;
  /**
   * Answers whether the VM's `fetch` may reach `host`, as a URL names it, with its port when the URL has one. A
   * rejection denies.
   */
  isHostAllowed: (host: string) => Promise<boolean>;
  /** Hears each `console` call of the VM's code. */
  onConsole: ConsoleSink;
  /**
   * Hears what goes wrong outside the run: in the VM, in its worker once the run has ended, or in this client's own
   * transitions.
   */
  onError: (error: Error) => void;
};

export type QuickJsWorker = ReturnType<typeof createQuickJsWorker>;

/** `ran` is a run that ended well, whose VM serves on. `ended` has nothing left to hear. */
type WorkerState = { kind: 'running' } | { kind: 'ran' } | { kind: 'ended' };

/** `failed` is the start's failure, or the worker's error event, which alone can come once the run has ended. */
type WorkerEvent = { kind: 'ran' } | { kind: 'failed'; error: Error } | { kind: 'disposed' };

type WorkerEffect =
  | { kind: 'runResolved' }
  | { kind: 'runRejected'; error: Error }
  | { kind: 'errorHeard'; error: Error }
  | { kind: 'workerStopped' };

type WorkerMachine = MachineTypes<WorkerState, WorkerEvent, WorkerEffect>;

const { vm: vmMethods, fetch: fetchMethods } = quickJsWorkerSchema.sections;

const stopWorker: HandlerOf<WorkerMachine, 'running' | 'ran', 'disposed'> = (
  _state,
  _event,
  { emitState, emitSideEffect },
) => {
  emitState({ kind: 'ended' });
  emitSideEffect({ kind: 'workerStopped' });
};

/**
 * Starts a Web Worker and runs `entrypoint` in a VM inside it. The frames the VM posts wait on `wire` until its owner
 * starts the port.
 *
 * Throws when `createWorker` throws.
 */
export function createQuickJsWorker({
  createWorker,
  files,
  entrypoint,
  isHostAllowed,
  onConsole,
  onError,
}: QuickJsWorkerParams) {
  const worker = createWorker();
  const control = new MessageChannel();
  const wire = new MessageChannel();
  const run = createDeferred<undefined>();
  const transport = createTransport({
    schema: quickJsWorkerSchema,
    provider: createPortProvider({ port: control.port1 }),
    handshake: 'offer',
    hello: undefined,
  });

  // The listener below sends to the machine built after it. It fires only once the worker runs.
  const stopWorkerErrors = listen({
    target: worker,
    type: 'error',
    handler: event => {
      const detail = 'message' in event && typeof event.message === 'string' ? `: ${event.message}` : '';
      machine.update({ kind: 'failed', error: new Error(`The QuickJS worker failed${detail}`) });
    },
  });
  const machine = createStateMachine<WorkerMachine>({
    initial: { kind: 'running' },
    handlers: {
      running: {
        ran(_state, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'ran' });
          emitSideEffect({ kind: 'runResolved' });
        },
        failed(_state, { error }, { emitState, emitSideEffect }) {
          emitState({ kind: 'ended' });
          emitSideEffect({ kind: 'runRejected', error });
          emitSideEffect({ kind: 'workerStopped' });
        },
        disposed: stopWorker,
      },
      ran: {
        // The run has ended well and the VM serves on, so a later error is heard rather than ending the run.
        failed(_state, { error }, { emitSideEffect }) {
          emitSideEffect({ kind: 'errorHeard', error });
        },
        disposed: stopWorker,
      },
      // Once ended, the run's answer and a late error event find nothing to move.
      ended: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'runResolved':
          run.resolve(undefined);
          break;
        case 'runRejected':
          run.reject(effect.error);
          break;
        case 'errorHeard':
          onError(effect.error);
          break;
        case 'workerStopped':
          stopWorkerErrors();
          transport.dispose(new Error(`The QuickJS worker running '${entrypoint}' stopped`));
          wire.port1.close();
          worker.terminate();
          break;
      }
    },
    onError: error => {
      onError(toError(error));
    },
  });

  worker.postMessage(createWorkerPortsMessage({ control: control.port2, wire: wire.port2 }), [
    control.port2,
    wire.port2,
  ]);
  // A rejection answers the worker with a failure, which it treats as a denial.
  transport.handleRequest(fetchMethods.isHostAllowed, async host => ok(await isHostAllowed(host)));
  // Subscribed before the start, so the worker hears it first and nothing the VM says as it starts is missed.
  transport.subscribe({
    method: vmMethods.output,
    start: undefined,
    listeners: {
      receive(output) {
        switch (output.tag) {
          case 'console':
            onConsole(output.value.level, output.value.message);
            break;
          case 'fault':
            onError(output.value);
            break;
        }
      },
      // The worker never ends the output itself.
      interrupt: noop,
      fail(failure) {
        onError(new Error(`The QuickJS worker's output failed with ${failure.tag}`));
      },
      // The transport closes only as the worker stops, and the run's end says why.
      close: noop,
    },
  });
  // A handshake that fails closes the transport, which rejects the start.
  machine.update(
    transport.request(vmMethods.start, { files, entrypoint }).then(
      (answer): WorkerEvent =>
        answer.success ? { kind: 'ran' } : { kind: 'failed', error: toStartError(answer.value) },
      (error: unknown): WorkerEvent => ({ kind: 'failed', error: toError(error) }),
    ),
  );

  return {
    /** The page's end of the byte wire. Each message on it is one frame as a `Uint8Array`. */
    wire: wire.port1,
    /**
     * Resolves once the entrypoint and its top-level await finish, while the VM serves on. Rejects with a
     * `QuickJsVmError` when the module fails, and with an `Error` when the worker fails or never answers first, after
     * which the worker is terminated. Never settles once `dispose` comes first.
     */
    run: run.promise,
    /** Ends the VM and terminates the worker. Safe to call again. */
    dispose(): void {
      machine.update({ kind: 'disposed' });
    },
  };
}

/** Why the worker did not run the entrypoint, as the run rejects with it. */
function toStartError(error: CallError<QuickJsVmError>): Error {
  switch (error.tag) {
    case 'Domain':
      return error.value;
    case 'HostFailure':
    case 'MalformedFrame':
      return new Error(`The QuickJS worker failed to start the VM: ${error.value.reason}`);
    case 'Denied':
    case 'Unsupported':
    case 'Cancelled':
      return new Error(`The QuickJS worker failed to start the VM with ${error.tag}`);
  }
}
