// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's run: read the host's contract from the URL once, then load the product, and again on each retry the
// visitor asks for, up to a limit. Every failure is reported and shown.

import { getLocalRoot } from '@dotli/config';
import { CONTENT_ERRORS } from '@dotli/content';
import { SandboxContractError, validateSandboxParams } from '@dotli/sandbox-wire';
import { captureException, m, reportDefect, reportExpected, spans as S } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  getErrorMessage,
  getErrorName,
  describeGatewayUnreachable,
  log,
  realTimers,
  setErrorName,
  type Timers,
} from '@dotli/shared';

import { APP_LOG_TAG } from './appLogTag.js';
import type { LoadInput, LoadOutcome, LoadStep, SandboxParams } from './loadProduct.js';

type ContractStep = 'contract_top_level' | 'contract_origin' | 'contract_params' | 'contract_rerender';

/** Each step names the failure wherever it is reported. */
export type SandboxStep = LoadStep | ContractStep | 'retry_limit';

export type SandboxPage = {
  /** The page's URL, which carries the host's contract. */
  href: string;
  /** Whether the page runs in a frame, as the host renders it. */
  framed: boolean;
};

/**
 * What the run needs from the page. A throw from `notifyFailed` or `show`, and a throw or rejection from `load`, is
 * reported and the run goes on. A throw from any other member escapes the run.
 */
export type RunSandboxDeps = {
  /** Applies the contract's settings to the page, once, before the first load. */
  configure: (params: SandboxParams) => void;
  /** One load of the product. A rejection is reported and shown as a failed `init`. */
  load: (input: LoadInput) => Promise<LoadOutcome>;
  /** Ends the host's loading screen with the failed step. */
  notifyFailed: (step: SandboxStep) => void;
  /** Shows the failure, with a retry when one is offered. The retry resolves once the load it asked for has settled. */
  show: (title: string, message: string, options: { retry?: (() => Promise<void>) | undefined }) => void;
  /** Shows that a retry started. */
  showRetrying: () => void;
  /** Asks the host to render this frame again with its params. */
  askRerender: () => void;
  /** The IPFS gateway's host, named when it cannot be reached. */
  getGatewayHost: () => string | undefined;
  /** The host's root domain, whose `app.` subdomains serve products. */
  baseDomain: string;
  /** How long the host has to render the frame again. */
  recoverTimeoutMs: number;
  /** The most loads in all, the first one and each retry. */
  maxAttempts?: number;
  /** The timers the wait for the host to render the frame again runs on. */
  timers?: Pick<Timers, 'setTimeout'>;
};

type FailParams = {
  /** The step the host is told failed. */
  step: SandboxStep;
  title: string;
  message: string;
  /** Offered with the failure when given. */
  retry?: () => Promise<void>;
};

type FailContractParams = {
  /** The contract check that failed. */
  step: ContractStep;
  title: string;
  /** Why the contract is unusable, shown and captured. */
  reason: string;
  /** The error the check threw, kept on the captured one. */
  cause?: unknown;
};

type PresentFailureParams = {
  /** The load step that failed. */
  step: LoadStep;
  error: unknown;
  /** The failed load's attempt number. */
  attempt: number;
  /** Runs the next load. */
  retry: () => Promise<void>;
};

const MAX_ATTEMPTS = 5;

const contentLog = log.createChild({ flow: 'content' });

/**
 * Resolves once the first load has settled, or at once when the contract stops the run. A failed load is shown, never
 * rejected. Throws when `href` is no URL, or when the contract check fails with anything but a contract error.
 */
export function runSandbox(page: SandboxPage, deps: RunSandboxDeps): Promise<void> {
  const url = new URL(page.href);
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  const timers = deps.timers ?? realTimers;

  // A top-level load has no bridge for account, signing or storage calls, so it fails rather than half-works.
  if (!page.framed) {
    // A bookmark or a pasted link: the visitor's doing, not a defect.
    reportExpected(new Error('Sandbox loaded as a top-level page'), {
      flow: 'content',
      step: 'contract_top_level',
      metric: S.APP_RUN,
      reason: 'top_level',
    });
    fail({
      step: 'contract_top_level',
      title: 'Sandbox URL not supported',
      message: `Open this dApp through https://${deps.baseDomain}. The sandbox origin (${url.host}) is not a standalone entry point.`,
    });
    return Promise.resolve();
  }
  // A bare `app.<root>` fails loudly.
  if (!isAppSubdomain(url.hostname, deps.baseDomain)) {
    failContract({
      step: 'contract_origin',
      title: 'Sandbox URL not supported',
      reason: `This page must load as a dotns app subdomain (e.g. myapp.app.${deps.baseDomain}) through dot.li.`,
    });
    return Promise.resolve();
  }
  // The sandbox cannot read the host's localStorage, so every setting arrives in the URL. A missing or invalid value
  // is a hard error, never a silent default. Extra keys are the user's own and pass through.
  let params: SandboxParams;
  try {
    params = validateSandboxParams(url.searchParams);
  } catch (error) {
    if (!(error instanceof SandboxContractError)) {
      throw error;
    }
    const { message: reason, recoverable } = error;
    if (recoverable) {
      // A reload of this window boots without the contract params, which were stripped after the last load. The host
      // can render it again with the params it last sent, and if it does not in time, the load fails.
      contentLog.event('Asking the host to re-render the sandbox', { reason });
      deps.askRerender();
      timers.setTimeout(() => {
        failContract({ step: 'contract_rerender', title: 'Invalid sandbox URL', reason, cause: error });
      }, deps.recoverTimeoutMs);
    } else {
      failContract({ step: 'contract_params', title: 'Invalid sandbox URL', reason, cause: error });
    }
    return Promise.resolve();
  }
  deps.configure(params);
  const dependency = getDependency(params.backend);

  // One load at a time, so a retry pressed during a load waits for it.
  const runs = createAsyncTaskPool({ poolSize: 1 });
  let attempts = 0;
  return loadAfter(0);

  /** The host is told first, so a failure that cannot be shown still ends its loading screen. */
  function fail({ step, title, message, retry }: FailParams): void {
    try {
      deps.notifyFailed(step);
      deps.show(title, message, { retry });
    } catch (error) {
      reportDefect(error, {
        flow: 'content',
        step: 'failure_show',
        metric: S.APP_RUN,
        reason: 'show_threw',
        message: `${APP_LOG_TAG} Could not show the ${step} failure`,
        tags: { surface: 'sandbox_main', failed_step: step },
        logger: contentLog,
      });
    }
  }

  /** Reported, since a URL this sandbox cannot use is the host's fault, never the visitor's. */
  function failContract({ step, title, reason, cause }: FailContractParams): void {
    const error = setErrorName(new Error(`${title}: ${reason}`, { cause }), 'SandboxContractError');
    captureException(error, { flow: 'content', step, tags: { surface: 'sandbox_main' } });
    fail({ step, title, message: reason });
  }

  function presentFailure({ step, error, attempt, retry }: PresentFailureParams): void {
    captureException(error, {
      flow: 'content',
      step,
      tags: { surface: 'sandbox_main', dependency, attempt: String(attempt) },
    });
    const raw = getErrorMessage(error);
    // An unreachable gateway names a host the visitor can check, so it gets visitor copy.
    const message =
      dependency === 'ipfs-gateway' && getErrorName(error) === CONTENT_ERRORS.GATEWAY_UNREACHABLE
        ? describeGatewayUnreachable(deps.getGatewayHost())
        : `${raw} (via ${dependency})`;
    fail({ step, title: 'Failed to load content', message, retry });
  }

  async function load(attempt: number): Promise<LoadOutcome> {
    try {
      return await deps.load({ params, attempt });
    } catch (error) {
      contentLog.error(`${APP_LOG_TAG} The load rejected instead of returning its outcome`, error);
      m.count(S.APP_RUN, { outcome: 'error', reason: 'load_rejected' });
      return { outcome: 'failed', step: 'init', error };
    }
  }

  /** Idempotent per failure: a retry finds the load it asked for already run when another retry ran it first. */
  function loadAfter(failedAttempts: number): Promise<void> {
    return runs.call(async () => {
      if (attempts !== failedAttempts) {
        return;
      }
      if (attempts >= maxAttempts) {
        contentLog.warn(`${APP_LOG_TAG} Retry refused after ${String(maxAttempts)} failed attempts`);
        fail({
          step: 'retry_limit',
          title: 'Too many retry attempts',
          message: `Reached ${String(maxAttempts)} failed attempts. Reload the page to start over.`,
        });
        return;
      }
      // Past the guards, so a stale retry shows nothing.
      if (failedAttempts > 0) {
        deps.showRetrying();
      }
      attempts += 1;
      const attempt = attempts;
      const outcome = await load(attempt);
      if (outcome.outcome !== 'failed') {
        return;
      }
      presentFailure({ step: outcome.step, error: outcome.error, attempt, retry: () => loadAfter(attempt) });
    });
  }
}

/** Only confirms a `<label>.app.<root>` origin, since the CID arrives on the host contract. */
function isAppSubdomain(hostname: string, baseDomain: string): boolean {
  return hostname.endsWith(`.app.${getLocalRoot(hostname) ?? baseDomain}`);
}

function getDependency(backend: SandboxParams['backend']): string {
  switch (backend) {
    case 'rpc-gateway':
      return 'ipfs-gateway';
    case 'smoldot-direct':
    case 'smoldot-shared-worker':
      return 'smoldot-bitswap';
  }
}
