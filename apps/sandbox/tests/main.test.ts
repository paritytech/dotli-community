// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SANDBOX_CONTRACT_PARAMS, SANDBOX_SCHEMA_VERSION } from '@dotli/config';
import type * as ContentModule from '@dotli/content';

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  fetchArchive: vi.fn(),
}));

vi.mock('@dotli/ui/styles.css', () => ({}));
vi.mock('@dotli/ui', () => ({
  showNotification: vi.fn(),
  prefetchOverlays: vi.fn(),
  showError: vi.fn(),
  showPasswordPrompt: vi.fn(),
  showRetryScreen: vi.fn(),
}));
vi.mock('@dotli/metrics', () => ({
  initSentry: vi.fn(),
  installGlobalErrorHandlers: vi.fn(),
  captureException: mocks.captureException,
  recordExpected: vi.fn(),
  m: { timer: () => () => undefined, setDefaults: vi.fn() },
  setResolutionId: vi.fn(),
  spans: {},
}));
vi.mock('@dotli/sandbox-checker', () => ({ loadSandboxChecker: vi.fn() }));
vi.mock('@dotli/content', async importOriginal => ({
  ...(await importOriginal<typeof ContentModule>()),
  loadFetch: () => Promise.resolve({ fetchArchive: mocks.fetchArchive }),
}));

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

/** Load the sandbox as the host frames it, at `search`, and collect what it tells the host. */
async function bootSandbox(search: Record<string, string>): Promise<unknown[]> {
  const posted: unknown[] = [];
  vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
  vi.spyOn(window, 'parent', 'get').mockReturnValue({
    postMessage: (message: unknown) => {
      posted.push(message);
    },
  } as unknown as Window);
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(
    `https://myapp.app.localhost/?${new URLSearchParams(search).toString()}`,
  );
  vi.resetModules();
  await import('../src/main.js');
  return posted;
}

const validContract = {
  [SANDBOX_CONTRACT_PARAMS.v]: String(SANDBOX_SCHEMA_VERSION),
  [SANDBOX_CONTRACT_PARAMS.cid]: CID,
  [SANDBOX_CONTRACT_PARAMS.chainBackend]: 'rpc-gateway',
  [SANDBOX_CONTRACT_PARAMS.network]: 'paseo-next-v2',
};

function doneMessage(posted: unknown[]): unknown {
  return posted.find(m => typeof m === 'object' && m !== null && (m as { done?: unknown }).done === true);
}

describe('sandbox load failure reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('As an operator, content that does not match its CID is reported as a verification failure', async () => {
    // Given a gateway that serves bytes the verifier rejects
    mocks.fetchArchive.mockRejectedValue(
      Object.assign(new Error(`Content hash mismatch for ${CID}`), { name: 'ContentVerificationError' }),
    );

    // When the sandbox loads
    const posted = await bootSandbox(validContract);

    // Then the host hears which step failed, and Sentry files it under the same step
    await vi.waitFor(() => {
      expect(doneMessage(posted)).toEqual({
        type: 'dotli:loading-status',
        done: true,
        outcome: 'failed',
        failedStep: 'verify',
      });
    });
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ flow: 'content', step: 'verify' }),
    );
  });

  it('As an operator, an unreachable gateway is reported as a fetch failure', async () => {
    // Given a gateway the browser cannot reach
    mocks.fetchArchive.mockRejectedValue(new TypeError('Failed to fetch'));

    // When the sandbox loads
    const posted = await bootSandbox(validContract);

    // Then the failure is attributed to the fetch, not to a later step
    await vi.waitFor(() => {
      expect(doneMessage(posted)).toMatchObject({ outcome: 'failed', failedStep: 'content_fetch' });
    });
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(TypeError),
      expect.objectContaining({
        flow: 'content',
        step: 'content_fetch',
        tags: expect.objectContaining({ surface: 'sandbox_main', dependency: 'ipfs-gateway' }) as unknown,
      }),
    );
  });

  it('As an operator, a host that sends a contract this sandbox cannot use is reported', async () => {
    // Given a host built against another contract version
    const posted = await bootSandbox({ ...validContract, [SANDBOX_CONTRACT_PARAMS.v]: '999' });

    // Then the load ends as a contract failure, reported as one
    await vi.waitFor(() => {
      expect(doneMessage(posted)).toMatchObject({ outcome: 'failed', failedStep: 'contract_params' });
    });
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'SandboxContractError' }),
      expect.objectContaining({ flow: 'content', step: 'contract_params' }),
    );
    expect(mocks.fetchArchive).not.toHaveBeenCalled();
  });
});
