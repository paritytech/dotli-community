import type { CoreStorage, NativeChatContactsSnapshot, ProductContext } from '@parity/truapi-host';
import { afterEach, describe, expect, it } from 'vitest';
import { createContactsPlatform, NativeChatContactsDirectory } from '../src/host-callbacks/Contacts.js';
import { createBlockingModalCoordinator } from '../src/blocking-modal-queue.js';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';
import { must } from './support.js';

const walletPublicKey = `0x${'11'.repeat(32)}` as const;
const genesisHash = `0x${'55'.repeat(32)}` as const;
const alice = `0x${'22'.repeat(32)}` as const;
const bob = `0x${'33'.repeat(32)}` as const;
const handleKey = `0x${'44'.repeat(32)}` as const;
// Independently calculated with Python hashlib.blake2b(key=..., digest_size=32).
const aliceHandle = '0xa8c0dc7c8c1e82224a2c7be7fd3b8d79e29269c9dd39e644f06baaeef89c3dfb';
const bobHandle = '0xfc326af887cd38c6306da9ee43cc7499eea214bdb364b3545550fa332fecfa87';
const product: ProductContext = {
  productId: 'chat-client.paseo',
  executionKind: 'App',
};
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetOverlays();
  document.body.replaceChildren();
});

function fixture() {
  let snapshot: NativeChatContactsSnapshot = {
    walletPublicKey,
    genesisHash,
    contacts: [{ peerIdentity: alice, username: 'alice.paseo' }, { peerIdentity: bob }],
  };
  let current = true;
  let read: () => Promise<NativeChatContactsSnapshot> = () => Promise.resolve(snapshot);
  const directory = new NativeChatContactsDirectory(() => current);
  directory.bind(
    {
      getNativeChatContacts: () => read(),
      notifyContactsChanged: () => undefined,
    },
    walletPublicKey,
    genesisHash,
  );
  const coordinator = createBlockingModalCoordinator();
  const scope = coordinator.createScope();
  const adapter = createContactsPlatform(directory, scope);
  cleanups.push(() => {
    adapter.dispose();
    directory.dispose();
    scope.dispose();
  });
  return {
    directory,
    adapter,
    coordinator,
    get snapshot() {
      return snapshot;
    },
    set snapshot(value: NativeChatContactsSnapshot) {
      snapshot = value;
    },
    setRead(value: () => Promise<NativeChatContactsSnapshot>) {
      read = value;
    },
    switchSession() {
      current = false;
      directory.invalidate();
    },
  };
}

async function choices(): Promise<HTMLButtonElement[]> {
  await overlaysReady();
  await expect.poll(() => document.querySelector('.contacts-picker-choice')).not.toBeNull();
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.contacts-picker-choice'));
}

describe('native Chat contacts', () => {
  it("matches keyed handles in request order without accepting another session's key", async () => {
    const { adapter } = fixture();
    const unknown = `0x${'66'.repeat(32)}` as const;
    await expect(
      adapter.callbacks.contacts({
        handleKey,
        handles: [bobHandle, unknown, aliceHandle, bobHandle],
      }),
    ).resolves.toEqual({ accounts: [bob, undefined, alice, bob] });
    await expect(
      adapter.callbacks.contacts({
        handleKey: walletPublicKey,
        handles: [aliceHandle],
      }),
    ).resolves.toEqual({ accounts: [undefined] });
  });

  it('rejects malformed lookup keys and handles', async () => {
    const { adapter } = fixture();
    await expect(adapter.callbacks.contacts({ handleKey: '0x00', handles: [] })).rejects.toThrow();
    await expect(
      adapter.callbacks.contacts({
        handleKey,
        handles: [`0x${aliceHandle.slice(2).toUpperCase()}`],
      }),
    ).rejects.toThrow();
    await expect(adapter.callbacks.contacts({ handleKey, handles: [] })).resolves.toEqual({ accounts: [] });
  });

  it('renders verified names as text, identifies unnamed peers, and revalidates the choice', async () => {
    const state = fixture();
    must(state.snapshot.contacts[0]).username = '<img src=x onerror=alert(1)>';
    const picked = state.adapter.callbacks.pickContact(product);
    const buttons = await choices();
    expect(must(buttons[0]).textContent).toContain('<img src=x onerror=alert(1)>');
    expect(must(buttons[0]).querySelector('img')).toBeNull();
    expect(must(buttons[1]).textContent).toContain(bob);
    expect(document.querySelector('[role=dialog]')?.textContent).toContain(product.productId);
    must(buttons[1]).click();
    await expect(picked).resolves.toEqual({
      tag: 'Picked',
      value: { account: bob },
    });
    await overlaysReady();
    expect(document.querySelector('[role=dialog]')).toBeNull();
  });

  it('does not return a contact removed while the picker was open', async () => {
    const state = fixture();
    const picked = state.adapter.callbacks.pickContact(product);
    const buttons = await choices();
    state.snapshot = { ...state.snapshot, contacts: [{ peerIdentity: bob }] };
    must(buttons[0]).click();
    await expect(picked).rejects.toThrow();
    await expect(state.adapter.callbacks.contacts({ handleKey, handles: [aliceHandle] })).resolves.toEqual({
      accounts: [undefined],
    });
  });

  it.each(['walletPublicKey', 'genesisHash'] as const)('refuses a snapshot for a different %s', async field => {
    const state = fixture();
    state.snapshot = { ...state.snapshot, [field]: `0x${'77'.repeat(32)}` };
    await expect(state.adapter.callbacks.pickContact(product)).rejects.toThrow();
    await expect(state.adapter.callbacks.contacts({ handleKey, handles: [aliceHandle] })).rejects.toThrow();
    expect(document.querySelector('[role=dialog]')).toBeNull();
  });

  it('distinguishes an authenticated empty roster from an unavailable signing session', async () => {
    const state = fixture();
    state.snapshot = { ...state.snapshot, contacts: [] };
    await expect(state.adapter.callbacks.pickContact(product)).resolves.toEqual({ tag: 'NoContacts' });
    state.setRead(() => Promise.reject(new Error('No signed-in session')));
    await expect(state.adapter.callbacks.pickContact(product)).rejects.toThrow();
  });

  it('cancels an outstanding lookup immediately on signout and never accepts its late snapshot', async () => {
    const state = fixture();
    const pending = Promise.withResolvers<NativeChatContactsSnapshot>();
    state.setRead(() => pending.promise);
    const lookup = state.adapter.callbacks.contacts({
      handleKey,
      handles: [aliceHandle],
    });
    const rejected = expect(lookup).rejects.toMatchObject({
      name: 'AbortError',
    });
    state.switchSession();
    await rejected;
    pending.resolve(state.snapshot);
    await expect(state.adapter.callbacks.pickContact(product)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it("cancels an open picker when its provider closes without closing another provider's directory", async () => {
    const state = fixture();
    const picked = state.adapter.callbacks.pickContact(product);
    await choices();
    const rejected = expect(picked).rejects.toMatchObject({
      name: 'AbortError',
    });
    state.adapter.dispose();
    await rejected;
    await overlaysReady();
    expect(document.querySelector('[role=dialog]')).toBeNull();
    const other = createContactsPlatform(state.directory, state.coordinator.createScope());
    cleanups.push(() => other.dispose());
    await expect(other.callbacks.contacts({ handleKey, handles: [aliceHandle] })).resolves.toEqual({
      accounts: [alice],
    });
  });

  it('never opens a queued picker under a replacement wallet', async () => {
    const state = fixture();
    const blocker = Promise.withResolvers<void>();
    const blockerScope = state.coordinator.createScope();
    const blocking = blockerScope.enqueue(() => blocker.promise);
    const picked = state.adapter.callbacks.pickContact(product);
    const rejected = expect(picked).rejects.toMatchObject({
      name: 'AbortError',
    });
    state.switchSession();
    await rejected;
    blocker.resolve();
    await blocking;
    expect(document.querySelector('[role=dialog]')).toBeNull();
    blockerScope.dispose();
  });

  it('invalidates active selections and late lookups at both trusted roster-write boundaries', async () => {
    const state = fixture();
    const stored = Promise.withResolvers<void>();
    const backing: CoreStorage = {
      readCoreStorage: () => Promise.resolve(undefined),
      writeCoreStorage: () => stored.promise,
      clearCoreStorage: () => Promise.resolve(),
    };
    const storage = state.directory.observeStorage(backing);
    const picked = state.adapter.callbacks.pickContact(product);
    await choices();
    const rejectedPick = expect(picked).rejects.toMatchObject({
      name: 'AbortError',
    });
    const writing = storage.writeCoreStorage(
      {
        tag: 'NativeChatDevice',
        value: {
          rootPublicKey: new Uint8Array(32),
          genesisHash: new Uint8Array(32),
          productId: 'chat.paseo',
        },
      },
      new Uint8Array([1]),
    );
    await rejectedPick;
    await overlaysReady();
    expect(document.querySelector('[role=dialog]')).toBeNull();
    const pending = Promise.withResolvers<NativeChatContactsSnapshot>();
    state.setRead(() => pending.promise);
    const lookup = state.adapter.callbacks.contacts({
      handleKey,
      handles: [aliceHandle],
    });
    const rejectedLookup = expect(lookup).rejects.toMatchObject({
      name: 'AbortError',
    });
    stored.resolve();
    await writing;
    await rejectedLookup;
    pending.resolve(state.snapshot);
    state.snapshot = { ...state.snapshot, contacts: [] };
    state.setRead(() => Promise.resolve(state.snapshot));
    await expect(state.adapter.callbacks.contacts({ handleKey, handles: [aliceHandle] })).resolves.toEqual({
      accounts: [undefined],
    });
  });

  it('dismisses by Escape and confines keyboard focus to the host picker', async () => {
    const state = fixture();
    const picked = state.adapter.callbacks.pickContact(product);
    const buttons = await choices();
    must(buttons[0]).dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(document.querySelector('.signing-btn-cancel'));
    must(document.activeElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(picked).resolves.toEqual({ tag: 'Dismissed' });
  });
});
