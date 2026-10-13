// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One load of the product the host named: fetch and verify its content, hand an archive to the service worker, and
// write its page into this window. It never throws, so the caller learns which step failed.

import { m, spans as S } from '@dotli/metrics';
import { CONTENT_ERRORS, type ArchiveFiles, type fetchArchive, type FetchResult } from '@dotli/content';
import type { validateSandboxParams } from '@dotli/sandbox-wire';
import { createAsyncTaskPool, log } from '@dotli/shared';

export type SandboxParams = Extract<ReturnType<typeof validateSandboxParams>, { ok: true }>['params'];

/**
 * Named alike in Sentry and in the host's `failedStep`. `verify` is never entered: a content mismatch is attributed to
 * it from whichever step fetched or parsed the bytes.
 */
export type LoadStep =
  | 'init'
  | 'sw_register'
  | 'chunk_load'
  | 'content_fetch'
  | 'verify'
  | 'decrypt'
  | 'sw_store'
  | 'archive_index'
  | 'render';

export interface LoadInput {
  params: SandboxParams;
  /** 1 for the page's first load, one more for each retry. */
  attempt: number;
}

export type LoadOutcome =
  | { outcome: 'loaded' }
  | { outcome: 'failed'; step: LoadStep; error: unknown }
  /** The frame is going away, which is not a failure. */
  | { outcome: 'torn_down' };

type FetchArchive = typeof fetchArchive;

/** Reads one block through the host's relay. */
export type BlockSource = (cid: string) => Promise<Uint8Array>;

/**
 * One block source for the document, built by the first load that asks and reused by every retry, so the page keeps
 * one bridge and one set of listeners. A build that fails is tried again by the next load.
 */
export function blockSourcePerDocument(build: () => Promise<BlockSource>): () => Promise<BlockSource> {
  const builds = createAsyncTaskPool({ poolSize: 1 });
  let built: BlockSource | null = null;
  return () =>
    builds.call(async () => {
      built ??= await build();
      return built;
    });
}

export interface LoadProductDeps {
  /** Progress text for the host's loading screen. */
  showStatus: (message: string) => void;
  /** Wipes what earlier products left in this origin. */
  purge: () => Promise<void>;
  /** Settles once a service worker controls the page, or the page goes on without one. */
  registerWorker: (options: { waitForFreshController: boolean }) => Promise<void>;
  fetchArchive: FetchArchive;
  /** The block source the host relays, loaded only on a light client backend. */
  loadBlockSource: () => Promise<BlockSource>;
  /** The files of encrypted content once its password is given, or null when it is not encrypted. */
  decrypt: (data: Uint8Array, cid: string) => Promise<ArchiveFiles | null>;
  /** Hands the archive to the service worker that serves its files. */
  storeArchive: (files: ArchiveFiles) => Promise<void>;
  /** The page as it is written, with anything the build injects. */
  prepareHtml: (html: string) => Promise<string>;
  /** Feeds the host's debug panel. */
  report: (event: string, flowId: string, payload: Record<string, unknown>) => void;
  /** Ends the host's loading screen. */
  loaded: () => void;
  /** Replaces this document with the product's page. */
  write: (html: string) => void;
  /** Milliseconds since the sandbox started. */
  sinceStart: () => number;
}

const contentLog = log.child({ flow: 'content' });

function resultBytes(result: FetchResult): number {
  return result.type === 'single'
    ? result.content.byteLength
    : Object.values(result.files).reduce((sum, file) => sum + file.byteLength, 0);
}

function resultFileCount(result: FetchResult): number {
  return result.type === 'single' ? 1 : Object.keys(result.files).length;
}

/** Matched on the message, since it crosses two modules as a plain Error. */
function isTeardownAbort(err: unknown): boolean {
  return err instanceof Error && err.message.includes('bitswap-relay: aborted');
}

export async function loadProduct({ params, attempt }: LoadInput, deps: LoadProductDeps): Promise<LoadOutcome> {
  const { cid, chainBackend, resolutionId } = params;
  const isGateway = chainBackend === 'rpc-gateway';
  // A retry runs on the state the first attempt left, so only the first wipes it.
  const freshStart = params.fullReset && attempt === 1;
  const stopApp = m.timer(S.APP_TOTAL);
  performance.mark('dotli:app:start');
  contentLog.event('Sandbox load started', { attempt, ms: deps.sinceStart() });
  let step: LoadStep = 'init';
  try {
    // Before the service worker registers, so the fresh worker installs cleanly instead of adopting stale state.
    if (freshStart) {
      contentLog.event('Purging sandbox-origin state for a full reset');
      await deps.purge();
    }

    step = 'sw_register';
    const stopSw = m.timer(S.APP_SW_REGISTER);
    const swReady = deps.registerWorker({ waitForFreshController: freshStart }).then(stopSw);
    const blockSource = isGateway ? null : deps.loadBlockSource();
    // Awaited after the worker is ready, so an early failure must not also reach the global rejection handler.
    void blockSource?.catch(() => undefined);

    // The worker must control the page before the archive is handed to it.
    await swReady;
    contentLog.event('Service worker ready', {
      controlled: 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null,
      ms: deps.sinceStart(),
    });

    let result: FetchResult;
    if (blockSource === null) {
      contentLog.event(`Fetching ${cid} via IPFS gateway`, { ms: deps.sinceStart() });
      deps.showStatus('Fetching via IPFS gateway...');
      step = 'content_fetch';
      result = await deps.fetchArchive(cid, deps.showStatus, { useGateway: true });
    } else {
      // Through the host-relayed protocol bridge, so the sandbox runs no libp2p.
      contentLog.event(`Fetching ${cid} via bitswap`, { chainBackend, ms: deps.sinceStart() });
      deps.showStatus('Fetching via bitswap...');
      step = 'chunk_load';
      const bitswapBlockSource = await blockSource;
      step = 'content_fetch';
      result = await deps.fetchArchive(cid, deps.showStatus, { bitswapBlockSource });
    }
    contentLog.event(`Content fetched via ${isGateway ? 'gateway' : 'bitswap'}`, {
      type: result.type,
      bytes: resultBytes(result),
      files: resultFileCount(result),
      ms: deps.sinceStart(),
    });

    if (result.type === 'single') {
      step = 'decrypt';
      const decryptedFiles = await deps.decrypt(result.content, cid);
      if (decryptedFiles !== null) {
        result = { type: 'archive', files: decryptedFiles };
        contentLog.event('Content decrypted', {
          bytes: resultBytes(result),
          files: resultFileCount(result),
          ms: deps.sinceStart(),
        });
      }
    }

    // Written into this window, so the host's container bridge reaches the dApp through this iframe.
    let html: string;
    if (result.type === 'single') {
      html = new TextDecoder().decode(result.content);
    } else {
      step = 'sw_store';
      await deps.storeArchive(result.files);
      contentLog.event('Archive handed to the service worker', {
        files: resultFileCount(result),
        ms: deps.sinceStart(),
      });
      step = 'archive_index';
      const indexHtml = result.files['index.html'] as Uint8Array | undefined;
      if (indexHtml === undefined) {
        throw new Error('Archive missing index.html — cannot render a sandbox without a root document.');
      }
      html = new TextDecoder().decode(indexHtml);
    }

    step = 'render';
    html = await deps.prepareHtml(html);
    const bytes = resultBytes(result);
    contentLog.event('Writing content into the window', { bytes, ms: deps.sinceStart() });
    deps.report('document_written', resolutionId ?? cid, {
      cid,
      totalMs: deps.sinceStart(),
      bytes,
      fileCount: resultFileCount(result),
    });
    deps.loaded();
    performance.mark('dotli:app:end');
    stopApp();
    deps.write(html);
    contentLog.event('Content rendered', { ms: deps.sinceStart() });
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
