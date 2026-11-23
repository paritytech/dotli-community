// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The Web Worker's side of one VM: it waits for the page's ports, starts the VM when the page asks, pipes the byte
// wire, sends the VM's output up, and lets the VM's fetch reach only the hosts the page allows.

import { serializeError, toError } from '@dotli/shared';
import { createPortProvider, createTransport, domain, err, ok, type CallError, type Sink } from '@dotli/transport';
import type { ResultPayload } from 'scale-ts';

import type { ModuleFiles } from './createModuleLoader.js';
import { createQuickJsVm } from './createQuickJsVm.js';
import type { HostFetchRequest, HostFetchResponse } from './createVmFetch.js';
import { QuickJsVmError } from './quickJsVmError.js';
import type { VmOutput, WorkerPortsMessage } from './quickJsWorkerSchema.js';
import { parseWorkerPortsMessage, quickJsWorkerSchema } from './quickJsWorkerSchema.js';

/** Where the page's first message arrives. The worker's own global scope is one. */
type MessageSource = {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
};

/** The fetch that runs each request the page allows. */
type WorkerFetch = (url: string, init: RequestInit) => Promise<Response>;

type Params = {
  /** Where the page's first message arrives: the worker's global scope. */
  scope: MessageSource;
  /** Runs each request of the VM's `fetch` that the page allows. The worker's own `fetch` by default. */
  fetch?: WorkerFetch;
  /** The WebCrypto behind the VM's `crypto`. The worker's own by default. */
  crypto?: Crypto;
};

type ServePortsParams = Pick<WorkerPortsMessage, 'control' | 'wire'> & {
  fetch: WorkerFetch;
  crypto: Crypto;
  /** Aborts when the worker stops serving. */
  signal: AbortSignal;
};

type StartAnswer = ResultPayload<undefined, CallError<QuickJsVmError>>;

const { vm: vmMethods, fetch: fetchMethods } = quickJsWorkerSchema.sections;

/**
 * Waits on `scope` for the page's first message, then serves one VM on the ports it transfers. A first message of
 * another shape throws in the worker, which the page hears as the worker's error event. Returns what ends the VM and
 * closes both ports, for a caller that stops serving without terminating the worker.
 */
export function serveQuickJsWorker({ scope, fetch = globalThis.fetch, crypto = globalThis.crypto }: Params) {
  const stop = new AbortController();

  scope.addEventListener('message', handleFirstMessage);

  return {
    /** Ends the VM and closes both ports. Safe to call again. */
    dispose() {
      scope.removeEventListener('message', handleFirstMessage);
      stop.abort(new Error('The QuickJS worker stopped serving'));
    },
  };

  function handleFirstMessage(event: MessageEvent): void {
    scope.removeEventListener('message', handleFirstMessage);
    const { control, wire } = parseWorkerPortsMessage(event.data);
    servePorts({ control, wire, fetch, crypto, signal: stop.signal });
  }
}

/** Serves the schema on `control` and, once the page starts it, the VM's byte wire on `wire`. */
function servePorts({ control, wire, fetch, crypto, signal }: ServePortsParams): void {
  const transport = createTransport({
    schema: quickJsWorkerSchema,
    provider: createPortProvider({ port: control }),
    handshake: 'respond',
    hello: undefined,
  });
  const outputs = new Set<Sink<VmOutput, undefined>>();
  let running: Promise<StartAnswer> | null = null;

  signal.addEventListener(
    'abort',
    () => {
      transport.dispose(toError(signal.reason));
      wire.close();
    },
    { once: true },
  );
  transport.handleSubscription(vmMethods.output, (_start, _context, sink) => {
    outputs.add(sink);
    return () => {
      outputs.delete(sink);
    };
  });
  // One VM per worker, so a repeated start answers with the first run.
  transport.handleRequest(vmMethods.start, payload => {
    running ??= runVm(payload).then(
      () => ok(),
      (error: unknown) => err(domain(new QuickJsVmError(serializeError(error)))),
    );
    return running;
  });

  async function runVm({ files, entrypoint }: { files: ModuleFiles; entrypoint: string }) {
    const vm = await createQuickJsVm({
      files,
      entrypoint,
      crypto,
      onError: reportFault,
      onConsole(level, message) {
        emit({ tag: 'console', value: { level, message } });
      },
      fetch: fetchAllowed,
    });
    // The worker may stop serving while the VM's WebAssembly loads.
    if (signal.aborted) {
      vm.dispose();
      throw new Error(`The QuickJS worker stopped serving before '${entrypoint}' ran`);
    }
    signal.addEventListener('abort', () => vm.dispose(), { once: true });
    vm.wire.subscribe(frame => {
      wire.postMessage(frame);
    });
    // The port holds what the page posted until it starts, so no frame sent before the VM existed is lost.
    wire.addEventListener('message', event => {
      if (!(event.data instanceof Uint8Array)) {
        reportFault(new Error(`The byte wire got a message that is not bytes: ${serializeError(event.data)}`));
        return;
      }
      vm.wire.postMessage(event.data);
    });
    wire.start();
    await vm.run();
  }

  async function fetchAllowed({ method, url, headers, body, signal: requestSignal }: HostFetchRequest) {
    const target = URL.canParse(url) ? new URL(url) : null;
    if (target === null || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
      throw new TypeError(`Only an absolute http or https URL may be fetched, not '${url}'`);
    }
    if (!(await isHostAllowed(target.host))) {
      // As a browser answers a blocked request, so the VM's code reads a status rather than a thrown error.
      return {
        status: 403,
        statusText: 'Forbidden',
        headers: [],
        body: new Uint8Array(),
        url,
      } satisfies HostFetchResponse;
    }
    const response = await fetch(url, {
      method,
      headers,
      body: body === null ? null : new Uint8Array(body),
      signal: requestSignal,
      credentials: 'omit',
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
      body: new Uint8Array(await response.arrayBuffer()),
      url: response.url,
    } satisfies HostFetchResponse;
  }

  /** Whether the page allows `host`. An ask that fails denies, and goes up as a fault. */
  async function isHostAllowed(host: string): Promise<boolean> {
    try {
      const answer = await transport.request(fetchMethods.isHostAllowed, host);
      if (answer.success) {
        return answer.value;
      }
      reportFault(new Error(`The page failed to say whether '${host}' may be fetched: ${answer.value.tag}`));
    } catch (error) {
      reportFault(new Error(`The page did not say whether '${host}' may be fetched`, { cause: error }));
    }
    return false;
  }

  function reportFault(error: Error): void {
    emit({ tag: 'fault', value: new QuickJsVmError(serializeError(error)) });
  }

  function emit(output: VmOutput): void {
    for (const sink of outputs) {
      sink.send(output);
    }
  }
}
