import { getActiveServicesConfig, getNetwork } from '@dotli/config';
import { createBrowserReceivingClient, type BrowserReceivingClient, type ReceivingAuthority } from '@parity/truapi-host/browser-receiving';
import type { ReceivingEvent } from '@parity/truapi';

export interface ReceivingStatus { supported: boolean; enabled: boolean; message: string }
let client: Promise<BrowserReceivingClient> | undefined;
let account: string | undefined;
let scopeFailure: string | undefined;
let activate: (authority: ReceivingAuthority, event: ReceivingEvent) => Promise<boolean> = async () => false;
export const receivingAccount = (): string | undefined => account;
export const receivingEnvironment = (): string => getNetwork();
export const receivingGenesis = (): string => getActiveServicesConfig().people.genesis.replace(/^0x/, '').toLowerCase();
export function setReceivingActivation(handler: typeof activate): void { activate = handler; }

export function setReceivingAccount(value: string | undefined): void {
  const next = value?.replace(/^0x/, '').toLowerCase();
  const authenticated = next && /^[0-9a-f]{64}$/.test(next) ? next : undefined;
  if (account === authenticated) return;
  account = authenticated;
  if (client || import.meta.env.VITE_RECEIVING_RELAY_URL) {
    void receivingClient().then(value => value.setActiveAccount(account, receivingEnvironment(), receivingGenesis()))
      .then(() => { scopeFailure = undefined; })
      .catch(error => {
        scopeFailure = `Receiving account synchronization failed: ${String(error)}`;
        window.dispatchEvent(new CustomEvent('dotli:receiving-error', { detail: scopeFailure }));
      });
  }
  window.dispatchEvent(new Event('dotli:receiving-account-changed'));
}

if (typeof window !== 'undefined') window.addEventListener('dotli:receiving-registration', () => {
  if (account === undefined) return;
  void receivingClient().then(value => value.setActiveAccount(account, receivingEnvironment(), receivingGenesis()))
    .then(() => { scopeFailure = undefined; })
    .catch(error => { scopeFailure = `Receiving account synchronization failed: ${String(error)}`; });
});

export function receivingClient(): Promise<BrowserReceivingClient> {
  if (!import.meta.env.VITE_RECEIVING_RELAY_URL || !import.meta.env.VITE_RECEIVING_PUSH_ORIGIN ||
      import.meta.env.VITE_RECEIVING_PUSH_ORIGIN !== location.origin || !navigator.serviceWorker || !navigator.locks ||
      !('Notification' in window) || !('PushManager' in window)) {
    return Promise.reject(new Error('Background receiving is unsupported: this host has no configured receiving transport.'));
  }
  client ??= (async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (!registration?.active) throw new Error('Background receiving requires the installed host service worker. Reload after installation.');
    const result = createBrowserReceivingClient({
      registration,
      consent: async (authority, watches) => {
        if (authority.account !== account || authority.environment !== receivingEnvironment() || authority.genesis !== receivingGenesis()) return false;
        return window.confirm(`Allow ${authority.productId} to receive background notifications for this account?\n\nThis separately authorizes ${watches.length} encrypted channel watch(es), even while the product is closed. You can revoke receiving in Settings. Message contents remain encrypted.`);
      },
      activate: (authority, event) => authority.account === account && authority.environment === receivingEnvironment() && authority.genesis === receivingGenesis()
        ? activate(authority, event) : Promise.resolve(false),
    });
    if (account !== undefined) await result.setActiveAccount(account, receivingEnvironment(), receivingGenesis());
    return result;
  })().catch(error => { client = undefined; throw error; });
  return client;
}

export async function receivingStatus(): Promise<ReceivingStatus> {
  try {
    await receivingClient();
    if (scopeFailure) throw new Error(scopeFailure);
    const registration = await navigator.serviceWorker.getRegistration('/');
    const subscription = await registration?.pushManager.getSubscription();
    return { supported: true, enabled: Boolean(subscription), message: subscription
      ? 'Web Push is enabled. Each verified product still requires separate receiving consent and enrollment.'
      : 'Web Push is disabled. Enable it here, then authorize receiving inside a verified product.' };
  } catch (error) {
    return { supported: false, enabled: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function enableReceivingPush(): Promise<void> {
  // Client preparation belongs to the settings status load, not the gesture path.
  if (!client) throw new Error('Receiving is not ready. Reopen Settings and try again.');
  const key = import.meta.env.VITE_RECEIVING_VAPID_PUBLIC_KEY;
  if (!key) throw new Error('This host has no Web Push public key configured.');
  await (await client).enableWebPush(key);
}

export async function revokeReceiving(): Promise<void> {
  const receiver = await receivingClient();
  await receiver.revokeAll();
}

/** Explicit disconnect/erase only; close and suspension retain enrollment. */
export async function revokeReceivingOnLogout(): Promise<void> {
  setReceivingAccount(undefined);
  if (!import.meta.env.VITE_RECEIVING_RELAY_URL) {
    if (typeof indexedDB.databases === 'function' &&
        (await indexedDB.databases()).some(database => database.name === 'truapi-browser-receiving')) {
      throw new Error('Restore this host’s receiving configuration before revoking its retained registrations.');
    }
    return;
  }
  await revokeReceiving();
}
