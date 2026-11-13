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

/** How the registration ended, held while the fetch still runs. */
type WorkerOutcome = { kind: 'ready'; controlled: boolean } | { kind: 'failed'; error: unknown };

/** How the fetch ended, held while the registration still runs. */
type ContentOutcome = { kind: 'fetched'; result: FetchResult } | { kind: 'failed'; error: unknown };

/**
 * Where one load is. From `preparing` the registration and the fetch run side by side, and the load goes on once both
 * have settled. It ends with the outcome the caller gets.
 */
type LoadState =
  | { kind: 'idle' }
  | { kind: 'purging' }
  | { kind: 'preparing' }
  | { kind: 'awaitingContent'; worker: WorkerOutcome }
  | { kind: 'awaitingWorker'; content: ContentOutcome }
  | { kind: 'decrypting'; content: Uint8Array }
  | { kind: 'storing'; files: ArchiveFiles }
  | { kind: 'rendering'; result: FetchResult }
  | { kind: 'writing'; html: string }
  | { kind: 'ended'; outcome: LoadOutcome };

type LoadEvent =
  | { kind: 'started' }
  | { kind: 'purged' }
  | { kind: 'workerSettled'; worker: WorkerOutcome }
  | { kind: 'contentSettled'; content: ContentOutcome }
  | { kind: 'decrypted'; files: ArchiveFiles | null }
  | { kind: 'archiveStored' }
  | { kind: 'htmlPrepared'; html: string }
  | { kind: 'write' }
  | { kind: 'stepFailed'; step: LoadStep; error: unknown };

/** What happened to a load, for its reports. */
type LoadEffect =
  | { kind: 'started' }
  | { kind: 'purging' }
  | { kind: 'workerSettled'; worker: WorkerOutcome }
  | { kind: 'fetching' }
  | { kind: 'contentSettled'; content: ContentOutcome }
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
        workerSettled(_state, { worker }, { emitState, emitSideEffect }) {
          emitState({ kind: 'awaitingContent', worker });
          emitSideEffect({ kind: 'workerSettled', worker });
        },
        contentSettled(_state, { content }, { emitState, emitSideEffect }) {
          emitState({ kind: 'awaitingWorker', content });
          emitSideEffect({ kind: 'contentSettled', content });
        },
      },
      awaitingContent: {
        contentSettled({ worker }, { content }, transition) {
          transition.emitSideEffect({ kind: 'contentSettled', content });
          goOnPrepared(worker, content, transition);
        },
      },
      awaitingWorker: {
        workerSettled({ content }, { worker }, transition) {
          transition.emitSideEffect({ kind: 'workerSettled', worker });
          goOnPrepared(worker, content, transition);
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
    update(
      startStep(() => registerWorker(registration)).then(
        controlled => ({ kind: 'workerSettled', worker: { kind: 'ready', controlled } }),
        (error: unknown) => ({ kind: 'workerSettled', worker: { kind: 'failed', error } }),
      ),
    );
    // The fetch needs no worker, so it runs while the worker registers. A single page waits for the worker too, so a
    // failed registration is still reported and the worker never claims a document that was already replaced.
    emitSideEffect({ kind: 'fetching' });
    update(
      startStep(fetchContent).then(
        result => ({ kind: 'contentSettled', content: { kind: 'fetched', result } }),
        (error: unknown) => ({ kind: 'contentSettled', content: { kind: 'failed', error } }),
      ),
    );
  }

  /** Registers the worker, timing the registration alone, so a full reset's purge is left out. */
  async function registerWorker(registration: Parameters<LoadProductDeps['registerWorker']>[0]): Promise<boolean> {
    const stopTimer = m.timer('app.sw_register');
    const controlled = await deps.registerWorker(registration);
    stopTimer();
    return controlled;
  }

  /** Says on the host how the content is fetched, as the fetch's own status does, then fetches it. */
  function fetchContent(): Promise<FetchResult> {
    const { blockSource, hostMessages } = deps;
    const { showStatus } = hostMessages;
    // Bitswap goes through the host-relayed protocol bridge, so the sandbox runs no libp2p.
    showStatus(blockSource === null ? 'Fetching via IPFS gateway...' : 'Fetching via bitswap...');
    return deps.fetchArchive(cid, { onStatus: showStatus, bitswapBlockSource: blockSource });
  }

  /** Takes the load on once the registration and the fetch have both settled. */
  function goOnPrepared(worker: WorkerOutcome, content: ContentOutcome, transition: Transition<LoadMachine>): void {
    const { emitState, update } = transition;
    // The registration is the earlier step, so its failure names the load whatever the fetch did.
    if (worker.kind === 'failed') {
      emitState(toFailure('sw_register', worker.error));
      return;
    }
    if (content.kind === 'failed') {
      emitState(toFailure('content_fetch', content.error));
      return;
    }
    const { result } = content;
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
  const via = blockSource === null ? 'gateway' : 'bitswap';
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
      case 'workerSettled': {
        const { worker } = effect;
        if (worker.kind === 'failed') {
          return;
        }
        report.log.event('Service worker ready', { controlled: worker.controlled, ms: measureSinceStart() });
        return;
      }
      case 'fetching':
        switch (via) {
          case 'gateway':
            report.log.event(`Fetching ${cid} via IPFS gateway`, { ms: measureSinceStart() });
            break;
          case 'bitswap':
            report.log.event(`Fetching ${cid} via bitswap`, { backend, ms: measureSinceStart() });
            break;
        }
        return;
      case 'contentSettled': {
        const { content } = effect;
        if (content.kind === 'failed') {
          return;
        }
        const { result } = content;
        report.log.event(`Content fetched via ${via}`, {
          type: result.type,
          bytes: countResultBytes(result),
          files: countResultFiles(result),
          ms: measureSinceStart(),
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
  return startStep(work).then(toEvent, (error: unknown) => ({ kind: 'stepFailed', step, error }));
}

/** `work`'s promise, with a throw before it returns one turned into its rejection. */
function startStep<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>(resolve => {
    resolve(work());
  });
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
