import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlacedAvatar, ProductContext } from '@parity/truapi-host';
import { fromHex } from '@dotli/shared';
import { createContactAvatars, createProfilePlatform } from '../src/host-callbacks/Profile.js';
import {
  InvalidProfileReferenceError,
  openSeityBlob,
  parseSeityBlobReference,
} from '../src/profile/seity-reference.js';
import { resetOverlays } from './helpers/overlays.js';
import type * as Content from '@dotli/content';
import type * as Config from '@dotli/config';

// Produced with profile-core's primitives (product-sdk-crypto AES-256-GCM,
// Blake2b-256 digest, CIDv1 raw/Blake2b-256) over a 1x1 PNG: the interop
// contract this host must read.
const VECTOR = {
  reference:
    'bafk2bzacebczvuhgd5yzd4s3r7e4chyrkxct4vd4aoyla3hupu6osyd2b5wjq#0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20a0a1a2a3a4a5a6a7a8a9aaab',
  digest: '0x459ad0e61f7191f25b8fc9c11f1155c53e547c03b0b06cf47d3ce9607a0f6c98',
  ciphertext:
    '30817321f0bf400e7f0ea266b8cd64d657d7b018586860852f5dd5fd5251cdf1b8d199c8e29bf475790e5cfac6364e2519b7246683c6fed548e4cab58c72a92accc0e0947f8f7b4c1bff0d251d4f61314e90',
  plaintext:
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
} as const;
const WRONG_KEY_REFERENCE = VECTOR.reference.replace('#01', '#ff');

const mocks = vi.hoisted(() => ({
  bitswapGet: vi.fn((): Promise<Uint8Array> => Promise.resolve(new Uint8Array())),
}));

vi.mock('@dotli/content', async importOriginal => ({
  ...(await importOriginal<typeof Content>()),
  bitswapGet: mocks.bitswapGet,
  fetchFromIpfs: vi.fn(),
}));
vi.mock('@dotli/config', async importOriginal => ({
  ...(await importOriginal<typeof Config>()),
  getBackend: () => 'smoldot-direct',
}));

const product: ProductContext = {
  productId: 'egui-chat.dot',
  executionKind: 'App',
};

function drawer(): HTMLElement | null {
  return document.querySelector('.profile-drawer');
}

async function settle(): Promise<void> {
  // Initial preimage poll, then the fetch, decrypt and render microtasks.
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => {
    expect(drawer()?.querySelector('.spinner')).toBeNull();
  });
}

describe('Seity blob references', () => {
  it('reads the reference profile-core writes', async () => {
    const parsed = parseSeityBlobReference(VECTOR.reference);

    expect(parsed.preimageKey).toBe(VECTOR.digest);
    const plaintext = await openSeityBlob(fromHex(VECTOR.ciphertext) as Uint8Array<ArrayBuffer>, parsed);
    expect(Array.from(plaintext)).toEqual(Array.from(fromHex(VECTOR.plaintext)));
  });

  it('refuses to yield bytes under the wrong key', async () => {
    await expect(
      openSeityBlob(
        fromHex(VECTOR.ciphertext) as Uint8Array<ArrayBuffer>,
        parseSeityBlobReference(WRONG_KEY_REFERENCE),
      ),
    ).rejects.toMatchObject({ name: 'OperationError' });
  });

  it.each([
    ['no fragment', VECTOR.reference.slice(0, VECTOR.reference.indexOf('#'))],
    ['a short fragment', VECTOR.reference.slice(0, -2)],
    ['two fragments', `${VECTOR.reference}#00`],
    [
      'a sha2-256 CID',
      `bafkreigh2akiscaildc6ybwhxslp6rx2u4m2vpbhgvzhpsfkyzxiezxcnq#${VECTOR.reference.slice(VECTOR.reference.indexOf('#') + 1)}`,
    ],
  ])('rejects %s without echoing the capability', (_case, reference) => {
    expect(() => parseSeityBlobReference(reference)).toThrow(InvalidProfileReferenceError);
    try {
      parseSeityBlobReference(reference);
    } catch (error) {
      expect(String(error)).not.toContain(VECTOR.reference.slice(VECTOR.reference.indexOf('#') + 1));
    }
  });
});

describe('profile drawer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.bitswapGet.mockReset();
  });

  afterEach(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    resetOverlays();
    vi.useRealTimers();
  });

  it('opens before the fetch completes, then shows the decrypted avatar', async () => {
    mocks.bitswapGet.mockResolvedValue(fromHex(VECTOR.ciphertext));

    await createProfilePlatform().presentProfile(product, {
      reference: VECTOR.reference,
    });

    expect(drawer()?.querySelector('.spinner')).not.toBeNull();
    expect(drawer()?.textContent).toContain('Shown by egui-chat.dot');
    await settle();
    const img = drawer()?.querySelector('img');
    expect(img?.getAttribute('src')).toMatch(/^blob:/);
    expect(mocks.bitswapGet).toHaveBeenCalledWith(VECTOR.reference.split('#')[0], expect.any(AbortSignal));
  });

  it('shows a failure in the drawer when the reference does not open', async () => {
    mocks.bitswapGet.mockResolvedValue(fromHex(VECTOR.ciphertext));

    await createProfilePlatform().presentProfile(product, {
      reference: WRONG_KEY_REFERENCE,
    });
    await settle();

    expect(drawer()?.querySelector('img')).toBeNull();
    expect(drawer()?.querySelector('.profile-drawer-status-error')).not.toBeNull();
  });

  it('rejects an unparseable reference without opening UI', async () => {
    await expect(createProfilePlatform().presentProfile(product, { reference: 'nope' })).rejects.toBeInstanceOf(
      InvalidProfileReferenceError,
    );
    expect(drawer()).toBeNull();
  });

  // Anything that reads as an address: a 0x prefix or a long hex run.
  const ADDRESS_LIKE = /0x|[0-9a-f]{8,}/i;

  it('names a contact by the username the host resolved, as plain text', async () => {
    mocks.bitswapGet.mockReturnValue(new Promise<Uint8Array>(() => undefined));
    const peerIdentity = Uint8Array.from({ length: 32 }, (_, i) => i);

    await createProfilePlatform().presentContactProfile(
      { ...product, productId: '<b>echat.paseo</b>' },
      {
        shared: { reference: VECTOR.reference, sharedAt: 1_700_000n },
        peerIdentity,
        username: 'alice.01',
      },
    );

    const attribution = drawer()?.querySelector('.profile-drawer-attribution');
    expect(drawer()?.querySelector('.profile-drawer-contact')?.textContent).toBe('alice.01');
    expect(attribution?.textContent).toContain('<b>echat.paseo</b>');
    expect(attribution?.children).toHaveLength(0);
    expect(drawer()?.textContent).not.toMatch(ADDRESS_LIKE);
  });

  it('names a contact generically, never by address, when the host knows no username', async () => {
    mocks.bitswapGet.mockReturnValue(new Promise<Uint8Array>(() => undefined));

    await createProfilePlatform().presentContactProfile(product, {
      shared: { reference: VECTOR.reference, sharedAt: 1_700_000n },
      peerIdentity: new Uint8Array(32).fill(0xab),
    });

    expect(drawer()?.textContent).not.toMatch(ADDRESS_LIKE);
  });

  it('rejects an unparseable contact reference without opening UI', async () => {
    await expect(
      createProfilePlatform().presentContactProfile(product, {
        shared: { reference: 'nope', sharedAt: 0n },
        peerIdentity: new Uint8Array(32),
      }),
    ).rejects.toBeInstanceOf(InvalidProfileReferenceError);
    expect(drawer()).toBeNull();
  });

  it('replaces a loaded profile with an empty contact drawer without fetching or leaking the old image', async () => {
    mocks.bitswapGet.mockResolvedValue(fromHex(VECTOR.ciphertext));
    const controller = new AbortController();
    const platform = createProfilePlatform(null, controller.signal);
    await platform.presentProfile(product, { reference: VECTOR.reference });
    await settle();
    expect(drawer()?.querySelector('img')).not.toBeNull();
    mocks.bitswapGet.mockClear();

    const contact = { peerIdentity: new Uint8Array(32).fill(0xab), username: '<b>alice.01</b>' };
    await platform.presentContactProfile(product, contact);
    expect(document.querySelectorAll('.profile-drawer')).toHaveLength(1);
    const name = drawer()?.querySelector('.profile-drawer-contact');
    expect(name?.textContent).toBe(contact.username);
    expect(name?.children).toHaveLength(0);
    expect(drawer()?.querySelector('img')).toBeNull();
    expect(drawer()?.querySelector('.spinner')).toBeNull();
    expect(drawer()?.querySelector('.profile-drawer-status-error')).toBeNull();
    expect(drawer()?.textContent).not.toMatch(ADDRESS_LIKE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.bitswapGet).not.toHaveBeenCalled();

    controller.abort();
    expect(drawer()).toBeNull();
    await expect(platform.presentContactProfile(product, contact)).rejects.toMatchObject({ name: 'AbortError' });
    expect(drawer()).toBeNull();
  });

  it('replaces the drawer on screen and closes on Escape', async () => {
    mocks.bitswapGet.mockReturnValue(new Promise<Uint8Array>(() => undefined));
    const platform = createProfilePlatform();

    await platform.presentProfile(product, { reference: VECTOR.reference });
    await platform.presentProfile(product, { reference: VECTOR.reference });
    expect(document.querySelectorAll('.profile-drawer')).toHaveLength(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(drawer()).toBeNull();
  });

  it('retires a presented profile and rejects late calls when its connection closes', async () => {
    mocks.bitswapGet.mockReturnValue(new Promise<Uint8Array>(() => undefined));
    const controller = new AbortController();
    const platform = createProfilePlatform(null, controller.signal);
    await platform.presentProfile(product, { reference: VECTOR.reference });
    expect(drawer()).not.toBeNull();

    controller.abort();
    expect(drawer()).toBeNull();
    await expect(platform.presentProfile(product, { reference: VECTOR.reference })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(drawer()).toBeNull();
  });
});

describe('placed contact avatars', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.bitswapGet.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('draws the shared photo over the frame and answers the product alike either way', async () => {
    mocks.bitswapGet.mockResolvedValue(fromHex(VECTOR.ciphertext));
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const avatars = createContactAvatars();
    avatars.attach(iframe, 'viewport');
    const at = (slot: number, reference: string): PlacedAvatar => ({
      slot,
      reference,
      sharedAt: 1n,
      rect: { x: 0, y: slot * 50, width: 44, height: 44 },
      clip: { x: 0, y: 0, width: 400, height: 800 },
    });
    const platform = createProfilePlatform(avatars);

    await expect(
      platform.placeContactAvatars(product, {
        surfaceWidth: 400,
        surfaceHeight: 800,
        avatars: [at(1, VECTOR.reference), at(2, 'not a reference')],
      }),
    ).resolves.toBeUndefined();
    await expect(
      platform.placeContactAvatars(product, {
        surfaceWidth: 400,
        surfaceHeight: 800,
        avatars: [at(2, 'not a reference')],
      }),
    ).resolves.toBeUndefined();
    await expect(
      createProfilePlatform().placeContactAvatars(product, {
        surfaceWidth: 400,
        surfaceHeight: 800,
        avatars: [at(1, VECTOR.reference)],
      }),
    ).resolves.toBeUndefined();
    expect(document.querySelector('.contact-avatar-overlay')).toBeNull();

    await platform.placeContactAvatars(product, {
      surfaceWidth: 400,
      surfaceHeight: 800,
      avatars: [at(1, VECTOR.reference), at(2, 'not a reference')],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.contact-avatar-overlay img')).toHaveLength(1);
    });
    expect(document.querySelector('.contact-avatar-overlay img')?.getAttribute('src')).toMatch(/^blob:/);

    avatars.dispose();
    iframe.remove();
  });
});
