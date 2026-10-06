import type {
  ContactsPlatform,
  CoreStorage,
  NativeChatContactsSnapshot,
  PlacedContactLabels,
  ProductContext,
} from '@parity/truapi-host';
import { afterEach, describe, expect, it } from 'vitest';
import { createContactsPlatform, NativeChatContactsDirectory } from '../src/host-callbacks/Contacts.js';
import { createBlockingModalCoordinator, type BlockingModalCoordinator } from '../src/blocking-modal-queue.js';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';
import { settle } from './helpers/solid.js';
import { must } from './support.js';
import { createContactLabelOverlay, type ContactLabelOverlay } from '../src/contacts/label-overlay.js';

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
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  resetOverlays();
  document.body.replaceChildren();
});

interface ContactsFixture {
  directory: NativeChatContactsDirectory;
  adapter: { callbacks: Required<ContactsPlatform>; dispose(): void };
  coordinator: BlockingModalCoordinator;
  snapshot: NativeChatContactsSnapshot;
  setRead(value: () => Promise<NativeChatContactsSnapshot>): void;
  switchSession(): void;
}

function fixture(labels?: ContactLabelOverlay): ContactsFixture {
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
  const adapter = createContactsPlatform(directory, scope, labels);
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

async function choices(): Promise<HTMLElement[]> {
  await overlaysReady();
  await expect.poll(() => document.querySelector('.contacts-picker-choice')).not.toBeNull();
  return Array.from(document.querySelectorAll<HTMLElement>('.contacts-picker-choice'));
}

async function labelFixture(): Promise<{
  state: ContactsFixture;
  adapter: ContactsFixture['adapter'];
  frame: HTMLIFrameElement;
  placed: PlacedContactLabels;
}> {
  const frame = document.createElement('iframe');
  Object.defineProperties(frame, {
    clientWidth: { value: 200 },
    clientHeight: { value: 120 },
  });
  const loaded = new Promise<void>(resolve => {
    frame.addEventListener(
      'load',
      () => {
        resolve();
      },
      { once: true },
    );
  });
  document.body.append(frame);
  // Place into the loaded document, not the initial about:blank navigation.
  await loaded;
  const labels = createContactLabelOverlay();
  labels.attach(frame, 'contain');
  cleanups.push(() => {
    labels.dispose();
  });
  const state = fixture(labels);
  const placed: PlacedContactLabels = {
    surfaceWidth: 200,
    surfaceHeight: 120,
    labels: [
      {
        slot: 0,
        account: alice,
        rect: { x: 0, y: 20, width: 100, height: 32 },
        clip: { x: 0, y: 0, width: 200, height: 120 },
      },
      {
        slot: 1,
        account: bob,
        rect: { x: 100, y: 20, width: 100, height: 32 },
        clip: { x: 0, y: 0, width: 200, height: 120 },
      },
    ],
  };
  return { state, adapter: state.adapter, frame, placed };
}

async function redraw(): Promise<void> {
  await new Promise<void>(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
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

  it('renders verified names as text without exposing account IDs and revalidates the choice', async () => {
    const state = fixture();
    must(state.snapshot.contacts[0], 'Alice contact').username = '<img src=x onerror=alert(1)>';
    const picked = state.adapter.callbacks.pickContact(product);
    const buttons = await choices();
    expect(must(buttons[0], 'Alice choice').textContent).toContain('<img src=x onerror=alert(1)>');
    expect(must(buttons[0], 'Alice choice').querySelector('img')).toBeNull();
    expect(document.querySelector('[role=dialog]')?.textContent).not.toMatch(/0x[0-9a-f]{64}/i);
    expect(document.querySelector('[role=dialog]')?.textContent).toContain(product.productId);
    must(buttons[1], 'Bob choice').click();
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
    must(buttons[0], 'Removed Alice choice').click();
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
    cleanups.push(() => {
      other.dispose();
    });
    await expect(other.callbacks.contacts({ handleKey, handles: [aliceHandle] })).resolves.toEqual({
      accounts: [alice],
    });
  });

  it('never opens a queued picker under a replacement wallet', async () => {
    const state = fixture();
    const blocker = Promise.withResolvers<undefined>();
    const blockerScope = state.coordinator.createScope();
    const blocking = blockerScope.enqueue(() => blocker.promise);
    const picked = state.adapter.callbacks.pickContact(product);
    const rejected = expect(picked).rejects.toMatchObject({
      name: 'AbortError',
    });
    state.switchSession();
    await rejected;
    blocker.resolve(undefined);
    await blocking;
    expect(document.querySelector('[role=dialog]')).toBeNull();
    blockerScope.dispose();
  });

  it('invalidates active selections and late lookups at both trusted roster-write boundaries', async () => {
    const state = fixture();
    const stored = Promise.withResolvers<undefined>();
    const backing: CoreStorage = {
      readCoreStorage: () => Promise.resolve(undefined),
      writeCoreStorage: () => stored.promise,
      clearCoreStorage: () => Promise.resolve(),
      compareExchangeCoreStorage: () => Promise.resolve(false),
      coreStorageChanged: () => undefined,
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
    stored.resolve(undefined);
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
    must(buttons[0], 'First contact choice').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(document.querySelector('.signing-btn-cancel'));
    must(document.activeElement, 'Focused picker action').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await expect(picked).resolves.toEqual({ tag: 'Dismissed' });
  });

  it('keeps preselected contacts when search hides them and confirms multiple people', async () => {
    const { adapter, snapshot } = fixture();
    must(snapshot.contacts[1], 'Bob contact').username = 'bob.paseo';
    const picked = adapter.callbacks.pickContacts(product, {
      selected: [alice],
    });
    const rows = await choices();
    expect(document.querySelector('[role=dialog]')?.textContent).not.toMatch(/0x[0-9a-f]{64}/i);
    const firstRow = must(rows[0], 'First contact choice');
    const secondRow = must(rows[1], 'Second contact choice');
    const first = must(firstRow.querySelector<HTMLInputElement>('input[type="checkbox"]'), 'First contact checkbox');
    const second = must(secondRow.querySelector<HTMLInputElement>('input[type="checkbox"]'), 'Second contact checkbox');
    expect(first.checked).toBe(true);
    expect(second.checked).toBe(false);
    const search = must(document.querySelector<HTMLInputElement>('input[type="search"]'), 'Contact search');
    search.value = 'bob';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await expect.poll(() => firstRow.hidden).toBe(true);
    expect(secondRow.hidden).toBe(false);
    second.click();
    await settle();
    must(document.querySelector<HTMLButtonElement>('.signing-btn-sign'), 'Confirm selection').click();
    await expect(picked).resolves.toEqual({
      tag: 'Picked',
      value: { accounts: [alice, bob] },
    });
  });

  it('distinguishes confirmed empty selection from canceled checkbox edits', async () => {
    const { adapter } = fixture();
    const cleared = adapter.callbacks.pickContacts(product, {
      selected: [alice],
    });
    const rows = await choices();
    must(
      must(rows[0], 'First contact choice').querySelector<HTMLInputElement>('input[type="checkbox"]'),
      'First contact checkbox',
    ).click();
    await settle();
    must(document.querySelector<HTMLButtonElement>('.signing-btn-sign'), 'Confirm selection').click();
    await expect(cleared).resolves.toEqual({
      tag: 'Picked',
      value: { accounts: [] },
    });

    const canceled = adapter.callbacks.pickContacts(product, {
      selected: [alice],
    });
    const reopened = await choices();
    expect(
      must(
        must(reopened[0], 'First reopened contact').querySelector<HTMLInputElement>('input[type="checkbox"]'),
        'First reopened checkbox',
      ).checked,
    ).toBe(true);
    must(
      must(reopened[1], 'Second reopened contact').querySelector<HTMLInputElement>('input[type="checkbox"]'),
      'Second reopened checkbox',
    ).click();
    await settle();
    must(document.querySelector<HTMLButtonElement>('.signing-btn-cancel'), 'Cancel selection').click();
    await expect(canceled).resolves.toEqual({ tag: 'Dismissed' });
  });

  it('does not memoize a failed label-directory read', async () => {
    const { state, adapter, placed } = await labelFixture();
    state.setRead(() => Promise.reject(new Error('Directory temporarily unavailable')));
    await expect(adapter.callbacks.placeContactLabels(product, placed)).rejects.toThrow(
      'Directory temporarily unavailable',
    );
    state.setRead(() => Promise.resolve(state.snapshot));
    await adapter.callbacks.placeContactLabels(product, placed);
    await expect.poll(() => document.querySelector('.contact-label')?.textContent).toBe('alice.paseo');
  });

  it('refreshes the latest labels after a same-wallet directory change without another placement', async () => {
    const { state, adapter, placed } = await labelFixture();
    await adapter.callbacks.placeContactLabels(product, placed);
    await expect.poll(() => document.querySelector('.contact-label')?.textContent).toBe('alice.paseo');
    expect(document.querySelectorAll('.contact-label')[1]?.getAttribute('aria-label')).toBe(bob);
    state.snapshot = {
      ...state.snapshot,
      contacts: [{ peerIdentity: alice, username: 'renamed.paseo' }],
    };
    state.directory.invalidate();
    expect(document.querySelector('.contact-label')).toBeNull();
    await expect.poll(() => document.querySelector('.contact-label')?.textContent).toBe('renamed.paseo');
    expect(document.querySelector(`[aria-label="${bob}"]`)).toBeNull();
  });

  it.each(['navigation', 'empty placement', 'provider close', 'wallet switch'])(
    'does not replay an in-flight directory refresh after %s',
    async ending => {
      const { state, adapter, placed, frame } = await labelFixture();
      await adapter.callbacks.placeContactLabels(product, placed);
      await expect.poll(() => document.querySelector('.contact-label')?.textContent).toBe('alice.paseo');
      const pending = Promise.withResolvers<NativeChatContactsSnapshot>();
      const started = Promise.withResolvers<undefined>();
      state.setRead(() => {
        started.resolve(undefined);
        return pending.promise;
      });
      state.directory.invalidate();
      await started.promise;
      if (ending === 'navigation') {
        frame.dispatchEvent(new Event('load'));
      } else if (ending === 'empty placement') {
        await adapter.callbacks.placeContactLabels(product, {
          ...placed,
          labels: [],
        });
      } else if (ending === 'provider close') {
        adapter.dispose();
      } else {
        state.switchSession();
      }
      expect(document.querySelector('.contact-label')).toBeNull();
      pending.resolve(state.snapshot);
      await redraw();
      expect(document.querySelector('.contact-label')).toBeNull();
    },
  );

  it('does not replay a queued directory refresh after navigation', async () => {
    const { state, adapter, placed, frame } = await labelFixture();
    await adapter.callbacks.placeContactLabels(product, placed);
    await expect.poll(() => document.querySelector('.contact-label')?.textContent).toBe('alice.paseo');
    state.directory.invalidate();
    frame.dispatchEvent(new Event('load'));
    await redraw();
    expect(document.querySelector('.contact-label')).toBeNull();
  });
});
