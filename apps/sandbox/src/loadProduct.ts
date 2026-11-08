// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One load of the product the host named: fetch and verify its content, hand an archive to the service worker, and
// write its page into this window. It never throws, and its outcome names the step that failed.

import { hasLightClient } from '@dotli/config';
import { m, spans as S } from '@dotli/metrics';
import { CONTENT_ERRORS, type ArchiveFiles, type fetchArchive, type FetchResult } from '@dotli/content';
import type { validateSandboxParams } from '@dotli/sandbox-wire';
import { getErrorName, log } from '@dotli/shared';

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

type FetchArchive = typeof fetchArchive;

/** Reads one block through the host's relay. */
export type BlockSource = (cid: string) => Promise<Uint8Array>;

/**
 * What one load needs from the page. A member that throws or rejects fails the load at the step it ran in, and a
 * failed registration wins over a failed fetch.
 */
export type LoadProductDeps = {
  /** Progress text for the host's loading screen. */
  showStatus: (message: string) => void;
  /** Wipes what earlier products left in this origin. */
  purge: () => Promise<void>;
  /** Settles once a service worker controls the page, or the page goes on without one. */
  registerWorker: (options: { waitForFreshController: boolean }) => Promise<void>;
  /** Whether a service worker controls the page now. Never throws. */
  isControlled: () => boolean;
  /** Fetches and verifies the content a CID names. Rejects when it cannot, or when the bytes do not match the CID. */
  fetchArchive: FetchArchive;
  /** The block source the host relays, or null on the IPFS gateway. */
  blockSource: BlockSource | null;
  /** The files of encrypted content once its password is given, or null when it is not encrypted. */
  decrypt: (data: Uint8Array, cid: string) => Promise<ArchiveFiles | null>;
  /** Hands the archive to the service worker that serves its files. */
  storeArchive: (files: ArchiveFiles) => Promise<void>;
  /** The page as it is written, with anything the build injects. */
  prepareHtml: (html: string) => Promise<string>;
  /** Feeds the host's debug panel with `event` of the flow `flowId` names. */
  report: (params: { event: string; flowId: string; payload: Record<string, unknown> }) => void;
  /** Ends the host's loading screen. */
  notifyLoaded: () => void;
  /** Replaces this document with the product's page. */
  write: (html: string) => void;
  /** Milliseconds since the sandbox started. */
  measureSinceStart: () => number;
};

const contentLog = log.createChild({ flow: 'content' });

/**
 * Loads the product once and writes its page into this window. Never rejects: it resolves `loaded`, `torn_down` when
 * the frame goes away mid-load, or `failed` with the step that failed and its error.
 */
export async function loadProduct({ params, attempt }: LoadInput, deps: LoadProductDeps): Promise<LoadOutcome> {
  const { cid, resolutionId } = params;
  // A retry runs on the state the first attempt left, so only the first wipes it.
  const freshStart = params.fullReset && attempt === 1;
  const stopApp = m.timer(S.APP_TOTAL);
  performance.mark('dotli:app:start');
  contentLog.event('Sandbox load started', { attempt, ms: deps.measureSinceStart() });
  let step: LoadStep = 'init';
  try {
    // Before the service worker registers, so the fresh worker installs cleanly instead of adopting stale state.
    if (freshStart) {
      contentLog.event('Purging sandbox-origin state for a full reset');
      await deps.purge();
    }

    step = 'sw_register';
    const stopWorkerTimer = m.timer(S.APP_SW_REGISTER);
    const workerReady = deps.registerWorker({ waitForFreshController: freshStart }).then(() => {
      stopWorkerTimer();
      contentLog.event('Service worker ready', {
        controlled: deps.isControlled(),
        ms: deps.measureSinceStart(),
      });
    });

    // The fetch needs no worker, so it runs while the worker registers. A single page waits for the worker too, so a
    // failed registration is still reported and the worker never claims a document that was already replaced.
    const [worker, fetched] = await Promise.allSettled([workerReady, fetchContent(params, deps)]);
    // The registration is the earlier step, so its failure names the load whatever the fetch did.
    if (worker.status === 'rejected') {
      throw worker.reason;
    }
    if (fetched.status === 'rejected') {
      step = 'content_fetch';
      throw fetched.reason;
    }
    let result = fetched.value;

    if (result.type === 'single') {
      step = 'decrypt';
      const decryptedFiles = await deps.decrypt(result.content, cid);
      if (decryptedFiles !== null) {
        result = { type: 'archive', files: decryptedFiles };
        contentLog.event('Content decrypted', {
          bytes: countResultBytes(result),
          files: countResultFiles(result),
          ms: deps.measureSinceStart(),
        });
      }
    }

    // Written into this window, so the host's container bridge reaches the dApp through this iframe.
    let html: string;
    switch (result.type) {
      case 'single':
        html = new TextDecoder().decode(result.content);
        break;
      case 'archive': {
        step = 'sw_store';
        await deps.storeArchive(result.files);
        contentLog.event('Archive handed to the service worker', {
          files: countResultFiles(result),
          ms: deps.measureSinceStart(),
        });
        step = 'archive_index';
        const indexHtml = result.files['index.html'];
        if (indexHtml === undefined) {
          throw new Error('Archive missing index.html. Cannot render a sandbox without a root document.');
        }
        html = new TextDecoder().decode(indexHtml);
        break;
      }
    }

    step = 'render';
    html = await deps.prepareHtml(html);
    const bytes = countResultBytes(result);
    contentLog.event('Writing content into the window', { bytes, ms: deps.measureSinceStart() });
    deps.report({
      event: 'document_written',
      flowId: resolutionId ?? cid,
      payload: { cid, totalMs: deps.measureSinceStart(), bytes, fileCount: countResultFiles(result) },
    });
    deps.notifyLoaded();
    performance.mark('dotli:app:end');
    stopApp();
    deps.write(html);
    contentLog.event('Content rendered', { ms: deps.measureSinceStart() });
    return { outcome: 'loaded' };
  } catch (error) {
    // Reporting it would file an error every time a user switches product mid-load, burying the real failures.
    if (isTeardownAbort(error)) {
      return { outcome: 'torn_down' };
    }
    const failedStep = error instanceof Error && error.name === CONTENT_ERRORS.VERIFICATION ? 'verify' : step;
    return { outcome: 'failed', step: failedStep, error };
  }
}

async function fetchContent(params: SandboxParams, deps: LoadProductDeps): Promise<FetchResult> {
  const { cid, backend } = params;
  let result: FetchResult;
  if (deps.blockSource === null) {
    contentLog.event(`Fetching ${cid} via IPFS gateway`, { ms: deps.measureSinceStart() });
    deps.showStatus('Fetching via IPFS gateway...');
    result = await deps.fetchArchive(cid, { onStatus: deps.showStatus, useGateway: true });
  } else {
    // Through the host-relayed protocol bridge, so the sandbox runs no libp2p.
    contentLog.event(`Fetching ${cid} via bitswap`, { backend, ms: deps.measureSinceStart() });
    deps.showStatus('Fetching via bitswap...');
    result = await deps.fetchArchive(cid, { onStatus: deps.showStatus, bitswapBlockSource: deps.blockSource });
  }
  contentLog.event(`Content fetched via ${hasLightClient(backend) ? 'bitswap' : 'gateway'}`, {
    type: result.type,
    bytes: countResultBytes(result),
    files: countResultFiles(result),
    ms: deps.measureSinceStart(),
  });
  return result;
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

/** A frame's teardown rejects its fetches by the platform's abort name. */
function isTeardownAbort(error: unknown): boolean {
  return getErrorName(error) === 'AbortError';
}
