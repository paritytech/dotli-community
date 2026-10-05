import { bitswapGet, loadFetch } from '@dotli/content';
import { getBackend } from '@dotli/config';
import type { BrowserReceivingExecution, ReceivingAuthority } from '@parity/truapi-host/browser-receiving';
import { receivingAccount, receivingClient, receivingEnvironment, receivingGenesis } from './receiving.js';

export interface ReceivingExecution {
  command(productId: string, action: number, payload: Uint8Array): Promise<Uint8Array | undefined>;
  ready(): void;
  close(): void;
  matches(authority: ReceivingAuthority): boolean;
}

/** Host verification, never a product frame's claimed CID, account or digest. */
export function createReceivingExecution(
  productId: string,
  archiveCid?: string,
  isCurrentExecution?: () => boolean,
): ReceivingExecution {
  const account = receivingAccount();
  const environment = receivingEnvironment();
  const genesis = receivingGenesis();
  const abort = new AbortController();
  let execution: BrowserReceivingExecution | undefined;
  let authority: ReceivingAuthority | undefined;
  let verified = false;
  let productReady = false;
  let ready = false;
  let failure: Error | undefined;
  let supported = archiveCid !== undefined && account !== undefined;
  const live = (): boolean =>
    !abort.signal.aborted &&
    isCurrentExecution?.() !== false &&
    account === receivingAccount() &&
    environment === receivingEnvironment() &&
    genesis === receivingGenesis();
  function recordFailure(error: unknown): void {
    failure = error instanceof Error ? error : new Error('Background receiving execution failed', { cause: error });
  }
  async function markReady(): Promise<void> {
    if (!execution || !productReady || !live()) {
      return;
    }
    await execution.ready();
    if (live()) {
      ready = true;
      window.dispatchEvent(new CustomEvent('dotli:receiving-ready', { detail: { authority, archiveCid } }));
    }
  }
  if (archiveCid !== undefined && account !== undefined) {
    const timer = setTimeout(() => {
      abort.abort();
    }, 25_000);
    void (async () => {
      const { fetchArchive } = await loadFetch();
      if (!live()) {
        return;
      }
      // Verify in the trusted page. Sandbox messages are not evidence: a product
      // could retain origin state or navigate its frame before sending them.
      const content = await fetchArchive(
        archiveCid,
        undefined,
        getBackend() === 'rpc-gateway'
          ? { useGateway: true }
          : { bitswapBlockSource: cid => bitswapGet(cid, abort.signal) },
      );
      verified = true;
      if (!live()) {
        return;
      }
      const artifact = content.verifiedArtifact;
      if (artifact === undefined || artifact === '') {
        supported = false;
        return;
      }
      const client = await receivingClient();
      await navigator.locks.request('dotli:receiving-authority', { signal: abort.signal }, async () => {
        if (!live()) {
          return;
        }
        const previous = await client.getAuthority(productId);
        if (!live()) {
          return;
        }
        const same =
          previous !== undefined &&
          !previous.revoked &&
          previous.account === account &&
          previous.environment === environment &&
          previous.genesis === genesis &&
          previous.artifact === artifact;
        authority = {
          productId,
          account,
          environment,
          genesis,
          artifact,
          generation: same ? previous.generation : (previous?.generation ?? 0n) + 1n,
          osPermission: Notification.permission === 'granted',
          transportReady: false,
        };
        await client.updateAuthority(authority);
        if (!live()) {
          return;
        }
        const bound = await client.bindExecution(authority);
        if (!live()) {
          bound.close();
          return;
        }
        execution = bound;
      });
      await markReady();
    })()
      .catch(recordFailure)
      .finally(() => {
        clearTimeout(timer);
      });
  }
  return {
    async command(requestProductId, action, payload) {
      if (!supported || !verified) {
        return undefined;
      }
      if (requestProductId !== productId || !live()) {
        throw new Error('Receiving execution expired; reopen the verified product.');
      }
      if (failure !== undefined) {
        throw failure;
      }
      if (!execution) {
        throw new Error('Receiving is waiting for trusted content verification and host service worker readiness.');
      }
      return execution.command(action, payload);
    },
    ready() {
      productReady = true;
      void markReady().catch(recordFailure);
    },
    close() {
      abort.abort();
      ready = false;
      execution?.close();
    },
    matches(expected) {
      if (!ready || !live() || authority === undefined) {
        return false;
      }
      return (
        authority.productId === expected.productId &&
        authority.account === expected.account &&
        authority.environment === expected.environment &&
        authority.genesis === expected.genesis &&
        authority.artifact === expected.artifact &&
        authority.generation === expected.generation
      );
    },
  };
}
