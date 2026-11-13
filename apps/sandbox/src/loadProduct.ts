// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One load of the product the host named: fetch and verify its content, hand an archive to the service worker, and
// write its page into this window. It never throws, and its outcome names the step that failed.

import { createReporter, defineCount, m } from '@dotli/metrics';
import { CONTENT_ERRORS, type ArchiveFiles, type fetchArchive, type FetchResult } from '@dotli/content';
import type { validateSandboxParams } from '@dotli/sandbox-wire';
import { createStateMachine, getErrorName, type HandlerOf, type MachineTypes, type Transition } from '@dotli/shared';

import { APP_LOG_TAG } from './appLogTag.js';
import type { BitswapBridge } from './createBitswapBridge.js';
import type { createDecryptIfNeeded } from './createDecryptIfNeeded.js';
import type { HostMessages } from './createHostMessages.js';

const report = createReporter({ flow: 'content' });

/** Count. A transition of a sandbox load threw, a bug. Tagged `outcome` (error) and `reason` (the error's name). */
const loadTransitionMetric = defineCount<'error'>('sandbox.load_transition');

export type SandboxParams = ReturnType<typeof validateSandboxParams>;

/**
 * Each step names the failure wherever it is reported. `verify` is never entered: a content mismatch is attributed to
 * it from whichever step fetched or parsed the bytes.
 */
export type LoadStep =
  'init' | 'sw_register' | 'content_fetch' | 'verify' | 'decrypt' | 'sw_store' | 'archive_index' | 'render';

export type LoadInput = {
  /** The host's contract, read from the URL. */
  params: SandboxParams;
  /** 1 for the page's first load, one more for each retry. */
  attempt: number;
};

export type LoadOutcome =
  | { outcome: 'loaded' }
  | { outcome: 'failed'; step: LoadStep; error: unknown }
  /** The frame is going away, which is not a failure. */
  | { outcome: 'torn_down' };

/**
 * What one load needs from the page. A member that throws or rejects fails the load at the step it ran in, and a
 * failed registration wins over a failed fetch.
 */
export type LoadProductDeps = {
  /** Progress text, the debug feed and the end of the loading screen, all on the host. */
  hostMessages: Pick<HostMessages, 'showStatus' | 'reportDebug' | 'notifyLoadingDone'>;
  /** Wipes what earlier products left in this origin. */
  purge: () => Promise<void>;
  /** Resolves once a service worker controls the page, or the page goes on without one, with whether one does. */
  registerWorker: (options: { waitForFreshController: boolean }) => Promise<boolean>;
  /** Fetches and verifies the content a CID names. Rejects when it cannot, or when the bytes do not match the CID. */
  fetchArchive: typeof fetchArchive;
  /** The block source the host relays, or null on the IPFS gateway. */
  blockSource: BitswapBridge['requestBlock'] | null;
  /** The files of encrypted content once its password is given, or null when it is not encrypted. */
  decrypt: ReturnType<typeof createDecryptIfNeeded>;
  /** Hands the archive to the service worker that serves its files. */
  storeArchive: (files: ArchiveFiles) => Promise<void>;
  /** The page as it is written, with anything the build injects. */
  prepareHtml: (html: string) => Promise<string>;
  /** Replaces this document with the product's page. */
  write: (html: string) => void;
  /** Milliseconds since the sandbox started. */
  measureSinceStart: () => number;
};

/**
 * Where one load is. In `preparing` the registration and the fetch run side by side, and the load goes on once both
 * have settled. It ends with the outcome the caller gets.
 */
type LoadState =
  | { kind: 'idle' }
  | { kind: 'purging' }
  | { kind: 'preparing' }
  | { kind: 'decrypting'; content: Uint8Array }
  | { kind: 'storing'; files: ArchiveFiles }
  | { kind: 'rendering'; result: FetchResult }
  | { kind: 'writing'; html: string }
  | { kind: 'ended'; outcome: LoadOutcome };

type LoadEvent =
  | { kind: 'started' }
  | { kind: 'purged' }
  | { kind: 'prepared'; worker: PromiseSettledResult<WorkerReady>; content: PromiseSettledResult<ContentFetched> }
  | { kind: 'decrypted'; files: ArchiveFiles | null }
  | { kind: 'archiveStored' }
  | { kind: 'htmlPrepared'; html: string }
  | { kind: 'write' }
  | { kind: 'stepFailed'; step: LoadStep; error: unknown };

/** A registration that ended, with the time since start it ended at. */
type WorkerReady = { controlled: boolean; ms: number };

/** A fetch that ended, with the time since start it ended at. */
type ContentFetched = { result: FetchResult; ms: number };

/** What happened to a load, for its reports. */
type LoadEffect =
  | { kind: 'started' }
  | { kind: 'purging' }
  | { kind: 'fetching' }
  | ({ kind: 'workerReady' } & WorkerReady)
  | ({ kind: 'contentFetched' } & ContentFetched)
  | { kind: 'decrypted'; files: ArchiveFiles }
  | { kind: 'archiveStored'; files: ArchiveFiles }
  | { kind: 'writing'; result: FetchResult }
  | { kind: 'rendered' };

type LoadMachine = MachineTypes<LoadState, LoadEvent, LoadEffect>;

/**
 * Loads the product once and writes its page into this window. Never rejects: it resolves `loaded`, `torn_down` when
 * the frame goes away mid-load, or `failed` with the step that failed and its error.
 */
export async function loadProduct({ params, attempt }: LoadInput, deps: LoadProductDeps): Promise<LoadOutcome> {
  const { cid } = params;

  const machine = createStateMachine<LoadMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        started(_state, _event, transition) {
          transition.emitSideEffect({ kind: 'started' });
          // A retry runs on the state the first attempt left, so only the first wipes it.
          if (!params.fullReset || attempt > 1) {
            startPreparing({ waitForFreshController: false }, transition);
            return;
          }
          // Before the service worker registers, so the fresh worker installs cleanly instead of adopting stale state.
          transition.emitState({ kind: 'purging' });
          transition.emitSideEffect({ kind: 'purging' });
          transition.update(runStep('init', deps.purge, () => ({ kind: 'purged' })));
        },
      },
      purging: {
        purged(_state, _event, transition) {
          startPreparing({ waitForFreshController: true }, transition);
        },
        stepFailed: failStep,
      },
      preparing: {
        prepared(_state, { worker, content }, transition) {
          const { emitState, emitSideEffect, update } = transition;
          if (worker.status === 'fulfilled') {
            emitSideEffect({ kind: 'workerReady', ...worker.value });
          }
          if (content.status === 'fulfilled') {
            emitSideEffect({ kind: 'contentFetched', ...content.value });
          }
          // The registration is the earlier step, so its failure names the load whatever the fetch did.
          if (worker.status === 'rejected') {
            emitState(toFailure('sw_register', worker.reason));
            return;
          }
          if (content.status === 'rejected') {
            emitState(toFailure('content_fetch', content.reason));
            return;
          }
          const { result } = content.value;
          switch (result.type) {
            case 'single':
              emitState({ kind: 'decrypting', content: result.content });
              update(
                runStep(
                  'decrypt',
                  () => deps.decrypt(result.content, cid),
                  files => ({ kind: 'decrypted', files }),
                ),
              );
              return;
            case 'archive':
              startStoring(result.files, transition);
              return;
          }
        },
      },
      decrypting: {
        decrypted({ content }, { files }, transition) {
          if (files === null) {
            startRendering({ type: 'single', content }, content, transition);
            return;
          }
          transition.emitSideEffect({ kind: 'decrypted', files });
          startStoring(files, transition);
        },
        stepFailed: failStep,
      },
      storing: {
        archiveStored({ files }, _event, transition) {
          transition.emitSideEffect({ kind: 'archiveStored', files });
          const index = files['index.html'];
          if (index === undefined) {
            const error = new Error('Archive missing index.html. Cannot render a sandbox without a root document.');
            transition.emitState(toFailure('archive_index', error));
            return;
          }
          startRendering({ type: 'archive', files }, index, transition);
        },
        stepFailed: failStep,
      },
      rendering: {
        htmlPrepared({ result }, { html }, { emitState, emitSideEffect, update }) {
          emitState({ kind: 'writing', html });
          try {
            deps.hostMessages.notifyLoadingDone({ outcome: 'loaded' });
          } catch (error) {
            emitState(toFailure('render', error));
            return;
          }
          emitSideEffect({ kind: 'writing', result });
          // Queued behind the effects, so the load's timer and mark end before the page is replaced.
          update({ kind: 'write' });
        },
        stepFailed: failStep,
      },
      writing: {
        write({ html }, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'ended', outcome: { outcome: 'loaded' } });
          // Written into this window, so the host's container bridge reaches the dApp through this iframe.
          try {
            deps.write(html);
          } catch (error) {
            emitState(toFailure('render', error));
            return;
          }
          emitSideEffect({ kind: 'rendered' });
        },
      },
      ended: null,
    },
    onEffect: createLoadReports({ params, attempt }, deps),
    onError: error => {
      report.defect(error, {
        step: 'load_transition',
        metric: loadTransitionMetric,
        message: `${APP_LOG_TAG} A transition of the sandbox load threw`,
      });
    },
  });
  machine.update({ kind: 'started' });
  await machine.await();
  const settled = machine.state.get();
  // A settled load that has not ended was left there by a transition that threw.
  return settled.kind === 'ended'
    ? settled.outcome
    : { outcome: 'failed', step: 'init', error: new Error(`The sandbox load stopped in ${settled.kind}`) };

  /** Starts the registration and the fetch side by side. A load that purged waits for a fresh worker. */
  function startPreparing(
    registration: Parameters<LoadProductDeps['registerWorker']>[0],
    { emitState, emitSideEffect, update }: Transition<LoadMachine>,
  ): void {
    emitState({ kind: 'preparing' });
    // Logged as an effect, so it follows the start line of a load that did not purge.
    emitSideEffect({ kind: 'fetching' });
    // The fetch needs no worker, so it runs while the worker registers. A single page waits for the worker too, so a
    // failed registration is still reported and the worker never claims a document that was already replaced.
    update(
      Promise.allSettled([registerWorker(registration), fetchContent()]).then(([worker, content]) => ({
        kind: 'prepared',
        worker,
        content,
      })),
    );
  }

  /** Registers the worker, timing the registration alone, so a full reset's purge is left out. */
  async function registerWorker(registration: Parameters<LoadProductDeps['registerWorker']>[0]): Promise<WorkerReady> {
    const stopTimer = m.timer('app.sw_register');
    const controlled = await deps.registerWorker(registration);
    stopTimer();
    return { controlled, ms: deps.measureSinceStart() };
  }

  /** Says on the host how the content is fetched, as the fetch's own status does, then fetches it. */
  async function fetchContent(): Promise<ContentFetched> {
    const { blockSource, hostMessages } = deps;
    const { showStatus } = hostMessages;
    // Bitswap goes through the host-relayed protocol bridge, so the sandbox runs no libp2p.
    showStatus(blockSource === null ? 'Fetching via IPFS gateway...' : 'Fetching via bitswap...');
    const result = await deps.fetchArchive(cid, { onStatus: showStatus, bitswapBlockSource: blockSource });
    return { result, ms: deps.measureSinceStart() };
  }

  function startStoring(files: ArchiveFiles, { emitState, update }: Transition<LoadMachine>): void {
    emitState({ kind: 'storing', files });
    update(
      runStep(
        'sw_store',
        () => deps.storeArchive(files),
        () => ({ kind: 'archiveStored' }),
      ),
    );
  }

  /** Renders `result`, whose page is `page`. */
  function startRendering(result: FetchResult, page: Uint8Array, { emitState, update }: Transition<LoadMachine>): void {
    emitState({ kind: 'rendering', result });
    update(
      runStep(
        'render',
        () => deps.prepareHtml(new TextDecoder().decode(page)),
        prepared => ({ kind: 'htmlPrepared', html: prepared }),
      ),
    );
  }
}

/** Turns what happens to one load into its log lines, timers and marks. */
function createLoadReports(
  { params, attempt }: LoadInput,
  {
    hostMessages,
    measureSinceStart,
    blockSource,
  }: Pick<LoadProductDeps, 'hostMessages' | 'measureSinceStart' | 'blockSource'>,
): (effect: LoadEffect) => void {
  const { cid, backend, resolutionId } = params;
  const stopApp = m.timer('app.total');
  return reportEffect;

  function reportEffect(effect: LoadEffect): void {
    switch (effect.kind) {
      case 'started':
        performance.mark('dotli:app:start');
        report.log.event('Sandbox load started', { attempt, ms: measureSinceStart() });
        return;
      case 'purging':
        report.log.event('Purging sandbox-origin state for a full reset');
        return;
      case 'fetching':
        if (blockSource === null) {
          report.log.event(`Fetching ${cid} via IPFS gateway`, { ms: measureSinceStart() });
          return;
        }
        report.log.event(`Fetching ${cid} via bitswap`, { backend, ms: measureSinceStart() });
        return;
      case 'workerReady':
        report.log.event('Service worker ready', { controlled: effect.controlled, ms: effect.ms });
        return;
      case 'contentFetched': {
        const { result } = effect;
        report.log.event(`Content fetched via ${blockSource === null ? 'gateway' : 'bitswap'}`, {
          type: result.type,
          bytes: countResultBytes(result),
          files: countResultFiles(result),
          ms: effect.ms,
        });
        return;
      }
      case 'decrypted': {
        const result: FetchResult = { type: 'archive', files: effect.files };
        report.log.event('Content decrypted', {
          bytes: countResultBytes(result),
          files: countResultFiles(result),
          ms: measureSinceStart(),
        });
        return;
      }
      case 'archiveStored':
        report.log.event('Archive handed to the service worker', {
          files: countResultFiles({ type: 'archive', files: effect.files }),
          ms: measureSinceStart(),
        });
        return;
      case 'writing': {
        const bytes = countResultBytes(effect.result);
        const totalMs = measureSinceStart();
        report.log.event('Writing content into the window', { bytes, ms: totalMs });
        performance.mark('dotli:app:end');
        stopApp();
        hostMessages.reportDebug({
          event: 'document_written',
          flowId: resolutionId ?? cid,
          payload: { cid, totalMs, bytes, fileCount: countResultFiles(effect.result) },
        });
        return;
      }
      case 'rendered':
        report.log.event('Content rendered', { ms: measureSinceStart() });
        return;
    }
  }
}

/** Ends the load at the step that failed. */
const failStep: HandlerOf<LoadMachine, 'purging' | 'decrypting' | 'storing' | 'rendering', 'stepFailed'> = (
  _state,
  { step, error },
  { emitState },
) => {
  emitState(toFailure(step, error));
};

/** The event `work` settles with, as `toEvent` makes it, or the failure of `step` when it throws or rejects. */
function runStep<T>(step: LoadStep, work: () => Promise<T>, toEvent: (value: T) => LoadEvent): Promise<LoadEvent> {
  // A throw before `work` returns its promise becomes that promise's rejection.
  return new Promise<T>(resolve => {
    resolve(work());
  }).then(toEvent, (error: unknown) => ({ kind: 'stepFailed', step, error }));
}

/** The end state of a load that failed at `step`. */
function toFailure(step: LoadStep, error: unknown): LoadState {
  // A frame's teardown rejects its fetches by the platform's abort name. Reporting it would file an error every time a
  // user switches product mid-load, burying the real failures.
  if (getErrorName(error) === 'AbortError') {
    return { kind: 'ended', outcome: { outcome: 'torn_down' } };
  }
  const failedStep = getErrorName(error) === CONTENT_ERRORS.VERIFICATION ? 'verify' : step;
  return { kind: 'ended', outcome: { outcome: 'failed', step: failedStep, error } };
}

function countResultBytes(result: FetchResult): number {
  switch (result.type) {
    case 'single':
      return result.content.byteLength;
    case 'archive':
      return Object.values(result.files).reduce((sum, file) => sum + file.byteLength, 0);
  }
}

function countResultFiles(result: FetchResult): number {
  switch (result.type) {
    case 'single':
      return 1;
    case 'archive':
      return Object.keys(result.files).length;
  }
}
