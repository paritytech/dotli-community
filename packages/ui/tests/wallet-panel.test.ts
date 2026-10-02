import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { setupTruapiDebugPanel, type SetupOptions } from '../src/components/truapi-debug/mount.js';
import { type InspectorIdentity, type LocalIdentityProgress, renderAllowanceSnapshot } from '@dotli/truapi-debug';
import { dispatchAuthState } from '../src/host-callbacks/AuthState.js';
import type { WalletAllowanceSnapshot } from '@parity/truapi-host/web';
import type * as Config from '@dotli/config';
import { query } from './support.js';

const buildFlags = vi.hoisted(() => ({ debug: true }));
vi.mock('@dotli/config', async importOriginal => ({
  ...(await importOriginal<typeof Config>()),
  get DEBUG() {
    return buildFlags.debug;
  },
}));

type Wallet = NonNullable<SetupOptions['experimentalWallet']>;
const cached = {
  network: 'Paseo',
  identityAccountId: `0x${'ab'.repeat(32)}`,
  liteUsername: 'alice.02',
} satisfies InspectorIdentity;

function unexpectedOperation(): Promise<never> {
  return Promise.reject(new Error('Unexpected native wallet mutation'));
}

function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll('button')].find(candidate => candidate.textContent === label);
  if (result === undefined) {
    throw new Error(`Missing button: ${label}`);
  }
  return result;
}

let wallet: Wallet;
let dispose: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
  buildFlags.debug = true;
  document.body.replaceChildren();
  wallet = {
    isActive: () => true,
    networkLabel: () => 'Paseo',
    getCachedIdentity: () => cached,
    storedInOtherApp: () => Promise.resolve(false),
    getIdentity: vi.fn(),
    getProduct: () => Promise.resolve(null),
    getAllowanceSnapshot: () => Promise.reject(new Error('Allowance inspection is unavailable in this scenario')),
    describeResource: () => null,
    requestResource: unexpectedOperation,
    refreshUsername: () => Promise.resolve(cached),
    claimLiteUsername: unexpectedOperation,
    activate: unexpectedOperation,
    disconnect: unexpectedOperation,
    exportMnemonic: unexpectedOperation,
    importMnemonic: unexpectedOperation,
    deleteWallet: unexpectedOperation,
  };
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function otherAppNotice(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.td-wallet-hint')].find(hint =>
    hint.textContent.includes('separately for each app'),
  );
}

it('never exposes browser custody through runtime debug opt-in in a production build', () => {
  buildFlags.debug = false;
  const isActive = vi.fn(() => true);
  wallet.isActive = isActive;
  dispose = setupTruapiDebugPanel({ experimentalWallet: wallet });
  expect(document.querySelector('.td-wallet-entry')).toBeNull();
  expect(document.querySelector('#td-wallet-view')).toBeNull();
  expect(isActive).not.toHaveBeenCalled();
});

describe('browser that keeps the test wallet per app', () => {
  it('warns that Use test wallet would start a different wallet when another app holds one', async () => {
    wallet.isActive = () => false;
    wallet.getCachedIdentity = () => undefined;
    wallet.storedInOtherApp = () => Promise.resolve(true);
    dispose = setupTruapiDebugPanel({ experimentalWallet: wallet });

    await vi.waitFor(() => {
      expect(otherAppNotice()?.hidden).toBe(false);
    });
    expect(otherAppNotice()?.textContent).toContain('import the same recovery phrase');
  });

  it('stays hidden while this app runs its own test wallet', async () => {
    const storedInOtherApp = vi.fn(() => Promise.resolve(true));
    wallet.storedInOtherApp = storedInOtherApp;
    dispose = setupTruapiDebugPanel({ experimentalWallet: wallet });

    await vi.waitFor(() => {
      expect(storedInOtherApp).toHaveBeenCalled();
    });
    await Promise.resolve();
    expect(otherAppNotice()?.hidden).toBe(true);
  });
});

describe('wallet failure presentation', () => {
  it('keeps the entry stable across status changes and displays only a known username', async () => {
    const identity = Promise.withResolvers<InspectorIdentity>();
    const refresh = Promise.withResolvers<InspectorIdentity>();
    wallet.getCachedIdentity = () => undefined;
    wallet.getIdentity = () => identity.promise;
    wallet.refreshUsername = () => refresh.promise;
    dispose = setupTruapiDebugPanel({ experimentalWallet: wallet });
    const entry = query(document, '.td-wallet-entry', HTMLButtonElement);
    const iconLabel = entry.getAttribute('aria-label');
    expect(entry.textContent).toBe('');

    identity.resolve({ ...cached, liteUsername: undefined });
    await vi.waitFor(() => {
      expect(button('Check username').disabled).toBe(false);
    });
    entry.click();
    expect(entry.getAttribute('aria-expanded')).toBe('true');
    button('Check username').click();
    expect(entry.textContent).toBe('');
    expect(entry.getAttribute('aria-label')).toBe(iconLabel);

    refresh.resolve(cached);
    await vi.waitFor(() => {
      expect(entry.textContent).toBe(cached.liteUsername);
    });
    const namedLabel = entry.getAttribute('aria-label');
    expect(namedLabel).toContain(cached.liteUsername);
    dispatchAuthState({
      tag: 'WalletUnavailable',
      reason: 'Native worker stopped',
    });
    expect(entry.textContent).toBe(cached.liteUsername);
    expect(entry.getAttribute('aria-label')).toBe(namedLabel);
    expect(button('Claim username').disabled).toBe(true);
    const details = query(document, '.td-wallet-error', HTMLDetailsElement);
    expect(details.hidden).toBe(false);
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('Native worker stopped');
  });

  it('retains cached display without retrying native startup until explicitly requested', async () => {
    const pending = Promise.withResolvers<InspectorIdentity>();
    const getIdentity = vi.fn(() => pending.promise);
    wallet.getIdentity = getIdentity;
    dispose = setupTruapiDebugPanel({ experimentalWallet: wallet });
    expect(document.querySelector('.td-wallet-entry')?.textContent).toContain(cached.liteUsername);

    dispatchAuthState({
      tag: 'WalletUnavailable',
      reason: 'Native worker stopped',
    });
    pending.reject(new Error('Native worker stopped'));
    await vi.waitFor(() => {
      expect(button('Retry wallet verification').disabled).toBe(false);
    });
    expect(getIdentity).toHaveBeenCalledTimes(1);
    expect(button('Claim username').disabled).toBe(true);
    expect(document.querySelector('.td-wallet-entry')?.textContent).toContain(cached.liteUsername);

    getIdentity.mockResolvedValue(cached);
    button('Retry wallet verification').click();
    await vi.waitFor(() => {
      expect(document.querySelector('.td-wallet-entry')?.textContent).toBe(cached.liteUsername);
      expect(button('Check username').disabled).toBe(false);
    });
    expect(getIdentity).toHaveBeenCalledTimes(2);
  });

  it('does not let a late successful identity read erase a native failure', async () => {
    const pending = Promise.withResolvers<InspectorIdentity>();
    const getIdentity = vi.fn(() => pending.promise);
    wallet.getIdentity = getIdentity;
    dispose = setupTruapiDebugPanel({ experimentalWallet: wallet });
    dispatchAuthState({
      tag: 'WalletUnavailable',
      reason: 'Native worker stopped',
    });
    pending.resolve({ ...cached, liteUsername: 'stale.02' });
    await pending.promise;
    await new Promise<void>(resolve => {
      queueMicrotask(resolve);
    });

    expect(document.querySelector('.td-wallet-error')?.textContent).toContain('Native worker stopped');
    expect(document.querySelector('.td-wallet-entry')?.textContent).toContain(cached.liteUsername);
    expect(button('Claim username').disabled).toBe(true);
    expect(button('Retry wallet verification').disabled).toBe(false);
    expect(getIdentity).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a disconnected wallet by automatically querying identity', async () => {
    const getIdentity = vi.fn(() => Promise.resolve(cached));
    wallet.getIdentity = getIdentity;
    dispose = setupTruapiDebugPanel({ experimentalWallet: wallet });
    await vi.waitFor(() => {
      expect(document.querySelector('.td-wallet-entry')?.textContent).toBe(cached.liteUsername);
    });
    dispatchAuthState({ tag: 'Disconnected' });
    await new Promise<void>(resolve => {
      queueMicrotask(resolve);
    });
    expect(getIdentity).toHaveBeenCalledTimes(1);
    expect(button('Claim username').disabled).toBe(true);
    expect(button('Retry wallet verification').disabled).toBe(false);
  });

  it("reports the host's automatic username lookup instead of asking for a manual check", async () => {
    const unclaimed = { ...cached, liteUsername: undefined };
    wallet.getCachedIdentity = () => unclaimed;
    wallet.getIdentity = () => Promise.resolve({ ...unclaimed, usernameVerified: true });
    dispose = setupTruapiDebugPanel({ experimentalWallet: wallet });
    const status = (): string => query(document, '.td-wallet-username strong').textContent;
    await vi.waitFor(() => {
      expect(status()).toBe('No username registered');
    });
  });
});

interface ClaimFixture {
  completion: PromiseWithResolvers<InspectorIdentity>;
  entry: HTMLButtonElement;
  status: HTMLElement;
  claim: HTMLButtonElement;
  claimUsername: Mock<Wallet['claimLiteUsername']>;
  start(): void;
  progress(progress: LocalIdentityProgress): void;
}

async function prepareClaim(): Promise<ClaimFixture> {
  const unclaimed = { ...cached, liteUsername: undefined };
  const completion = Promise.withResolvers<InspectorIdentity>();
  let onProgress: ((progress: LocalIdentityProgress) => void) | undefined;
  wallet.getCachedIdentity = () => unclaimed;
  wallet.getIdentity = () => Promise.resolve(unclaimed);
  const claimUsername = vi.fn<Wallet['claimLiteUsername']>((_baseUsername, observer) => {
    onProgress = observer;
    return completion.promise;
  });
  wallet.claimLiteUsername = claimUsername;
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  );
  dispose = setupTruapiDebugPanel({ experimentalWallet: wallet });
  await Promise.resolve();
  const entry = query(document, '.td-wallet-entry', HTMLButtonElement);
  const status = query(document, '.td-wallet-username', HTMLElement);
  const input = query(document, '.td-wallet-username-input', HTMLInputElement);
  const claim = query(document, '.td-wallet-claim', HTMLButtonElement);
  entry.click();
  return {
    completion,
    entry,
    status,
    claim,
    claimUsername,
    start() {
      input.value = 'alice';
      input.dispatchEvent(new Event('input'));
      claim.click();
    },
    progress(progress: LocalIdentityProgress) {
      if (onProgress === undefined) {
        throw new Error('Missing claim observer');
      }
      onProgress(progress);
    },
  };
}

describe('wallet claim progress', () => {
  it('shows real stages and elapsed time without changing the entry or confirming early', async () => {
    vi.useFakeTimers();
    const claim = await prepareClaim();
    const entryBefore = claim.entry.outerHTML;
    claim.start();
    claim.progress({ stage: 'checking' });
    expect(claim.status.textContent).toMatch(/checking/i);
    await vi.advanceTimersByTimeAsync(7100);
    expect(claim.status.textContent).toMatch(/checking/i);
    expect(document.querySelector('.td-wallet-elapsed')?.textContent).toBe('7s elapsed');
    claim.progress({ stage: 'authenticating' });
    expect(claim.status.textContent).toMatch(/authenticating/i);
    claim.progress({ stage: 'submitting' });
    expect(claim.status.textContent).toMatch(/submitting/i);
    claim.progress({ stage: 'confirming' });
    expect(claim.status.textContent).toMatch(/waiting/i);
    expect(claim.status.dataset['state']).toBe('pending');
    expect(claim.claim.disabled).toBe(true);
    expect(claim.entry.outerHTML).toBe(entryBefore);

    claim.completion.resolve(cached);
    await claim.completion.promise;
    expect(claim.status.dataset['state']).toBe('claimed');
    expect(claim.entry.textContent).toBe(cached.liteUsername);
    expect(claim.status.textContent.split(cached.liteUsername).length).toBe(2);
    expect(document.querySelector<HTMLElement>('.td-wallet-elapsed')?.hidden).toBe(true);
    claim.progress({ stage: 'retrying', error: 'late event' });
    expect(claim.status.dataset['state']).toBe('claimed');
    expect(claim.status.textContent).not.toContain('late event');
  });

  it('keeps a retry pending with expandable diagnostics and continues after closing the tab', async () => {
    vi.useFakeTimers();
    const claim = await prepareClaim();
    claim.start();
    claim.progress({ stage: 'retrying', error: 'RPC connection reset' });
    const details = query(document, '.td-wallet-error', HTMLDetailsElement);
    expect(claim.status.textContent).toMatch(/retrying/i);
    expect(claim.status.textContent).not.toContain('RPC connection reset');
    expect(details.hidden).toBe(false);
    expect(details.open).toBe(false);
    details.open = true;
    expect(details.textContent).toContain('RPC connection reset');
    await vi.advanceTimersByTimeAsync(4000);
    expect(claim.status.dataset['state']).toBe('pending');
    expect(claim.claim.disabled).toBe(true);
    expect(claim.claimUsername).toHaveBeenCalledTimes(1);

    query(document, '.td-tab[data-view="list"]', HTMLButtonElement).click();
    expect(claim.entry.getAttribute('aria-expanded')).toBe('false');
    claim.progress({ stage: 'confirming' });
    expect(details.hidden).toBe(true);
    expect(claim.status.textContent).toMatch(/waiting/i);
    claim.completion.resolve(cached);
    await claim.completion.promise;
    expect(claim.entry.textContent).toBe(cached.liteUsername);
  });

  it('ignores claim events and completion after identity replacement', async () => {
    const claim = await prepareClaim();
    claim.start();
    claim.progress({ stage: 'submitting' });
    const replacement = {
      ...cached,
      identityAccountId: `0x${'cd'.repeat(32)}`,
      liteUsername: 'bob.02',
    };
    wallet.getCachedIdentity = () => replacement;
    const identity = Promise.withResolvers<InspectorIdentity>();
    wallet.getIdentity = () => identity.promise;
    dispatchAuthState({
      tag: 'Connected',
      session: {
        connected: true,
        identityAccountId: replacement.identityAccountId,
      },
    });
    const checkingReplacement = claim.status.textContent;
    claim.progress({ stage: 'retrying', error: 'old wallet error' });
    expect(claim.status.textContent).toBe(checkingReplacement);
    identity.resolve(replacement);
    await identity.promise;
    const replaced = claim.status.textContent;
    claim.progress({ stage: 'confirming' });
    expect(claim.status.textContent).toBe(replaced);
    claim.completion.resolve(cached);
    await claim.completion.promise;
    expect(claim.entry.textContent).toBe(replacement.liteUsername);
    expect(claim.status.dataset['state']).not.toBe('claimed');
    expect(claim.status.textContent).not.toContain(cached.liteUsername);
  });

  it('ignores events from the old network before its replacement identity is loaded', async () => {
    const claim = await prepareClaim();
    claim.start();
    claim.progress({ stage: 'submitting' });
    wallet.networkLabel = () => 'Polkadot';
    const before = claim.status.textContent;
    claim.progress({ stage: 'retrying', error: 'old network error' });
    expect(claim.status.textContent).toBe(before);
    claim.completion.resolve(cached);
    await claim.completion.promise;
    expect(claim.status.dataset['state']).not.toBe('claimed');
    expect(claim.entry.textContent).toBe('');
  });

  it('stops its timer on dispose and ignores late events and completion', async () => {
    vi.useFakeTimers();
    const claim = await prepareClaim();
    const idleTimers = vi.getTimerCount();
    claim.start();
    claim.progress({ stage: 'confirming' });
    expect(vi.getTimerCount()).toBe(idleTimers + 1);
    dispose?.();
    dispose = undefined;
    expect(vi.getTimerCount()).toBe(0);
    const before = claim.status.outerHTML;
    claim.progress({ stage: 'retrying', error: 'disposed observer' });
    claim.completion.resolve(cached);
    await claim.completion.promise;
    await vi.advanceTimersByTimeAsync(5000);
    expect(claim.status.outerHTML).toBe(before);
    expect(document.querySelector('.td-wallet-entry')).toBeNull();
  });
});

function unavailableSnapshot(reason: string): WalletAllowanceSnapshot {
  const unavailable = { status: 'unavailable' as const, reason };
  return {
    schemaVersion: 1,
    identityAccountId: cached.identityAccountId,
    networkSuffix: 'paseo',
    productIds: [],
    statementStore: unavailable,
    pgasClaims: unavailable,
    pgasBalances: unavailable,
    bulletinClaims: unavailable,
    bulletinQuotas: unavailable,
  };
}

describe('wallet allowance inspection', () => {
  it('preserves integer precision while independently reporting unavailable resources', () => {
    const snapshot = unavailableSnapshot('Claim capacity cannot be read');
    snapshot.productIds = ['example.paseo'];
    snapshot.pgasBalances = {
      status: 'available',
      observation: {
        genesisHash: `0x${'01'.repeat(32)}`,
        blockHash: `0x${'02'.repeat(32)}`,
        blockNumber: 42,
        specVersion: 1,
        chainTimestamp: 1_700_000_000,
      },
      value: {
        assetId: '1',
        decimals: null,
        symbol: null,
        accounts: [
          {
            productId: 'example.paseo',
            accountId: cached.identityAccountId,
            derivationIndex: 0,
            balance: '18446744073709551617',
          },
        ],
      },
    };
    renderAllowanceSnapshot(document.body, snapshot);
    expect(document.body.textContent).toContain('18,446,744,073,709,551,617');
    expect(document.body.textContent).toContain('Claim capacity cannot be read');
  });

  it('does not replace a reopened wallet snapshot with a late closed-view response', async () => {
    const oldRequest = Promise.withResolvers<WalletAllowanceSnapshot>();
    const currentRequest = Promise.withResolvers<WalletAllowanceSnapshot>();
    wallet.getIdentity = () => Promise.resolve(cached);
    const load = vi.fn().mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(currentRequest.promise);
    wallet.getAllowanceSnapshot = load;
    dispose = setupTruapiDebugPanel({ experimentalWallet: wallet });
    await vi.waitFor(() => {
      expect(button('Check username').disabled).toBe(false);
    });
    const entry = query(document, '.td-wallet-entry', HTMLButtonElement);
    entry.click();
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledTimes(1);
    });
    query(document, '.td-tab[data-view="list"]', HTMLButtonElement).click();
    entry.click();
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledTimes(2);
    });
    currentRequest.resolve(unavailableSnapshot('Current snapshot'));
    await vi.waitFor(() => {
      expect(document.querySelector('.td-wallet-allowance-results')?.textContent).toContain('Current snapshot');
    });
    oldRequest.resolve(unavailableSnapshot('Stale snapshot'));
    await oldRequest.promise;
    expect(document.querySelector('.td-wallet-allowance-results')?.textContent).toContain('Current snapshot');
    expect(document.querySelector('.td-wallet-allowance-results')?.textContent).not.toContain('Stale snapshot');
  });
});
