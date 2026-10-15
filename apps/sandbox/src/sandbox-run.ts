// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's run: read the host's contract from the URL once, then load the product, and again on each retry the
// visitor asks for, up to a limit. Every failure is reported and shown.

import { validateSandboxParams } from '@dotli/sandbox-wire';
import { captureException, m, recordExpected, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, errorMessage, gatewayUnreachable, log, named } from '@dotli/shared';

import type { LoadInput, LoadOutcome, LoadStep, SandboxParams } from './load-product.js';

type ContractStep = 'contract_top_level' | 'contract_origin' | 'contract_params' | 'contract_rerender';

/** Named alike in Sentry and in the host's `failedStep`. */
export type SandboxStep = LoadStep | ContractStep | 'retry_limit';

export interface SandboxPage {
  /** The page's URL, which carries the host's contract. */
  href: string;
  /** Whether the page runs in a frame, as the host renders it. */
  framed: boolean;
}

export interface SandboxRunDeps {
  /** Applies the contract's settings to the page, once, before the first load. */
  configure: (params: SandboxParams) => void;
  /** One load of the product. A rejection is reported and shown as a failed `init`. */
  load: (input: LoadInput) => Promise<LoadOutcome>;
  /** Ends the host's loading screen with the failed step. */
  failed: (step: SandboxStep) => void;
  /** Shows the failure, with a retry when one is offered. The retry resolves once the load it asked for has settled. */
  show: (title: string, message: string, retry?: () => Promise<void>) => void;
  /** Shows that a retry started. */
  retrying: () => void;
  /** Asks the host to render this frame again with its params. */
  askRerender: () => void;
  /** The IPFS gateway's host, named when it cannot be reached. */
  gatewayHost: () => string | undefined;
  /** The host's root domain, whose `app.` subdomains serve products. */
  baseDomain: string;
  /** How long the host has to render the frame again. */
  recoverTimeoutMs: number;
  maxAttempts?: number;
}

const MAX_ATTEMPTS = 5;

const contentLog = log.child({ flow: 'content' });

/** Only confirms a `<label>.app.<root>` origin, since the CID arrives on the host contract. */
function isAppSubdomain(hostname: string, baseDomain: string): boolean {
  for (const suffix of [`.app.${baseDomain}`, '.app.localhost']) {
    if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
      return true;
    }
  }
  return false;
}

function dependencyOf(backend: SandboxParams['backend']): string {
  return backend === 'rpc-gateway' ? 'ipfs-gateway' : 'smoldot-bitswap';
}

/** Resolves once the first load has settled, or at once when the contract stops the run. */
export function runSandbox(page: SandboxPage, deps: SandboxRunDeps): Promise<void> {
  const url = new URL(page.href);
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;

  /** The host is told first, so a failure that cannot be shown still ends its loading screen. */
  const fail = (step: SandboxStep, title: string, message: string, retry?: () => Promise<void>): void => {
    try {
      deps.failed(step);
      deps.show(title, message, retry);
    } catch (err) {
      captureException(err, {
        flow: 'content',
        step: 'failure_show',
        tags: { surface: 'sandbox_main', failed_step: step },
      });
      contentLog.error(`[dot.li app] Could not show the ${step} failure`, err);
      m.count(S.APP_RUN, { outcome: 'error', reason: 'show_threw' });
    }
  };

  /** Reported, since a URL this sandbox cannot use is the host's fault, never the visitor's. */
  const failContract = (step: ContractStep, title: string, reason: string): void => {
    const err = named(new Error(`${title}: ${reason}`), 'SandboxContractError');
    captureException(err, { flow: 'content', step, tags: { surface: 'sandbox_main' } });
    fail(step, title, reason);
  };

  // A top-level load has no bridge for account, signing or storage calls, so it fails rather than half-works.
  if (!page.framed) {
    // A bookmark or a pasted link: the visitor's doing, not a defect.
    recordExpected(new Error('Sandbox loaded as a top-level page'), { flow: 'content', step: 'contract_top_level' });
    fail(
      'contract_top_level',
      'Sandbox URL not supported',
      `Open this dApp through https://${deps.baseDomain}. The sandbox origin (${url.host}) is not a standalone entry point.`,
    );
    return Promise.resolve();
  }
  // A bare `app.<root>` fails loudly.
  if (!isAppSubdomain(url.hostname, deps.baseDomain)) {
    failContract(
      'contract_origin',
      'Sandbox URL not supported',
      `This page must load as a dotns app subdomain (e.g. myapp.app.${deps.baseDomain}) through dot.li.`,
    );
    return Promise.resolve();
  }
  // The sandbox cannot read the host's localStorage, so every setting arrives in the URL. A missing or invalid value
  // is a hard error, never a silent default. Extra keys are the user's own and pass through.
  const parsed = validateSandboxParams(url.searchParams);
  if (!parsed.ok) {
    if (parsed.recoverable === true) {
      // A reload of this window boots without the contract params, which were stripped after the last load. The host
      // can render it again with the params it last sent, and if it does not in time, the load fails.
      contentLog.event('Asking the host to re-render the sandbox', { reason: parsed.reason });
      deps.askRerender();
      setTimeout(() => {
        failContract('contract_rerender', 'Invalid sandbox URL', parsed.reason);
      }, deps.recoverTimeoutMs);
    } else {
      failContract('contract_params', 'Invalid sandbox URL', parsed.reason);
    }
    return Promise.resolve();
  }
  const { params } = parsed;
  deps.configure(params);
  const dependency = dependencyOf(params.backend);

  const presentFailure = (step: LoadStep, err: unknown, attempt: number, retry: () => Promise<void>): void => {
    captureException(err, {
      flow: 'content',
      step,
      tags: { surface: 'sandbox_main', dependency, attempt: String(attempt) },
    });
    const raw = errorMessage(err);
    // The gateway path's commonest failure reads as an app bug verbatim, so it gets plain words. A failed dynamic
    // import starts the same way but means a missing chunk, not an unreachable gateway.
    const message =
      dependency === 'ipfs-gateway' && raw.includes('Failed to fetch') && !raw.includes('dynamically imported module')
        ? gatewayUnreachable(deps.gatewayHost())
        : `${raw} (via ${dependency})`;
    fail(step, 'Failed to load content', message, retry);
  };

  // One load at a time, so a retry pressed during a load waits for it.
  const runs = createAsyncTaskPool({ poolSize: 1 });
  let attempts = 0;
  const load = async (attempt: number): Promise<LoadOutcome> => {
    try {
      return await deps.load({ params, attempt });
    } catch (error) {
      contentLog.error('[dot.li app] The load rejected instead of returning its outcome', error);
      m.count(S.APP_RUN, { outcome: 'error', reason: 'load_rejected' });
      return { outcome: 'failed', step: 'init', error };
    }
  };
  // Idempotent per failure: a retry finds the load it asked for already run when another retry ran it first.
  const loadAfter = (failedAttempts: number): Promise<void> =>
    runs.call(async () => {
      if (attempts !== failedAttempts) {
        return;
      }
      if (attempts >= maxAttempts) {
        contentLog.warn(`[dot.li app] Retry refused after ${String(maxAttempts)} failed attempts`);
        fail(
          'retry_limit',
          'Too many retry attempts',
          `Reached ${String(maxAttempts)} failed attempts. Reload the page to start over.`,
        );
        return;
      }
      // Past the guards, so a stale retry shows nothing.
      if (failedAttempts > 0) {
        deps.retrying();
      }
      attempts += 1;
      const attempt = attempts;
      const outcome = await load(attempt);
      if (outcome.outcome !== 'failed') {
        return;
      }
      presentFailure(outcome.step, outcome.error, attempt, () => loadAfter(attempt));
    });
  return loadAfter(0);
}
