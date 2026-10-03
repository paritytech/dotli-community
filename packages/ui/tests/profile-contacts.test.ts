import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductContext } from '@parity/truapi-host';
import { fromHex } from '@dotli/shared';
import { hashToCid } from '@dotli/content';
import { createProfilePlatform } from '../src/host-callbacks/Profile.js';
import { parseContactsReference } from '../src/profile/contacts-reference.js';
import { InvalidProfileReferenceError } from '../src/profile/seity-reference.js';
import { resetOverlays } from './helpers/overlays.js';
import type * as Content from '@dotli/content';
import type * as Config from '@dotli/config';
import type * as Protocol from '@dotli/protocol';
import type * as Resolver from '@dotli/resolver';

// Produced by Seity's profile-core (`test/vectors/contacts-v1.json`): the
// reference a contact's host is handed, the registry slot it names, the two
// blobs it fetches (sealed record, re-sealed avatar), and what it must draw.
const VECTOR = JSON.parse(
  // happy-dom replaces import.meta.url, so resolve from the package root vitest runs in.
  readFileSync(join(process.cwd(), 'tests/fixtures/seity-contacts-v1.json'), 'utf8'),
) as {
  reference: string;
  registry: {
    lookupKey: `0x${string}`;
    cidDigest: `0x${string}`;
    version: number;
  };
  blobs: Record<string, string>;
  expect: {
    avatarPlaintext: string;
    mood: { kind: string; intensity: string; setAt: number; ttlSecs: number };
  };
};

const mocks = vi.hoisted(() => ({
  backend: 'smoldot-direct',
  bitswapGet: vi.fn((_cid: string): Promise<Uint8Array> => Promise.resolve(new Uint8Array())),
  resolveSeitySlotRemote: vi.fn(),
  resolveSeitySlotViaRpc: vi.fn(),
}));

vi.mock('@dotli/content', async importOriginal => ({
  ...(await importOriginal<typeof Content>()),
  bitswapGet: mocks.bitswapGet,
  fetchFromIpfs: async (cid: string) => ({ data: await mocks.bitswapGet(cid) }),
}));
vi.mock('@dotli/config', async importOriginal => ({
  ...(await importOriginal<typeof Config>()),
  getBackend: () => mocks.backend,
}));
vi.mock('@dotli/protocol', async importOriginal => ({
  ...(await importOriginal<typeof Protocol>()),
  resolveSeitySlotRemote: mocks.resolveSeitySlotRemote,
}));
vi.mock('@dotli/resolver', async importOriginal => ({
  ...(await importOriginal<typeof Resolver>()),
  loadRpcResolve: () =>
    Promise.resolve({
      resolveSeitySlotViaRpc: mocks.resolveSeitySlotViaRpc,
    }),
}));

const product: ProductContext = {
  productId: 'egui-chat.dot',
  executionKind: 'App',
};
const BLOBS_BY_CID = new Map(
  Object.entries(VECTOR.blobs).map(([digest, hex]) => [hashToCid(digest).toString(), fromHex(hex)]),
);

function drawer(): HTMLElement | null {
  return document.querySelector('.profile-drawer');
}

/**
 * Two preimage polls (record, then avatar), each after the poller's first delay.
 * WebCrypto and the envelope decode run on real time, not the fake clock, so
 * each check advances the fake timers a little and then yields real time.
 */
async function settle(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(drawer()?.querySelector('.spinner')).toBeNull();
    },
    { timeout: 10_000, interval: 50 },
  );
}

describe('Seity contacts references', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.backend = 'smoldot-direct';
    mocks.resolveSeitySlotViaRpc.mockReset();
    // An hour after the vector's mood was set, so it is still current.
    vi.setSystemTime((VECTOR.expect.mood.setAt + 3600) * 1000);
    mocks.bitswapGet.mockReset();
    mocks.bitswapGet.mockImplementation((cid: string) => {
      const bytes = BLOBS_BY_CID.get(cid);
      return bytes === undefined ? Promise.reject(new Error(`no blob for ${cid}`)) : Promise.resolve(bytes);
    });
    mocks.resolveSeitySlotRemote.mockReset();
    mocks.resolveSeitySlotRemote.mockImplementation((lookupKey: string) =>
      Promise.resolve(
        lookupKey === VECTOR.registry.lookupKey
          ? {
              owner: `0x${'aa'.repeat(20)}`,
              cidDigest: VECTOR.registry.cidDigest,
              version: '1',
            }
          : {
              owner: `0x${'00'.repeat(20)}`,
              cidDigest: `0x${'00'.repeat(32)}`,
              version: '0',
            },
      ),
    );
  });

  afterEach(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    resetOverlays();
    vi.useRealTimers();
  });

  it('parses the reference profile-core writes', () => {
    expect(parseContactsReference(VECTOR.reference).lookupKey).toBe(VECTOR.registry.lookupKey);
  });

  it('resolves the slot, opens the record and draws the avatar with its mood', async () => {
    await createProfilePlatform().presentProfile(product, {
      reference: VECTOR.reference,
    });
    await settle();

    expect(mocks.resolveSeitySlotRemote).toHaveBeenCalledWith(VECTOR.registry.lookupKey);
    expect(drawer()?.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
    expect(drawer()?.querySelector('.profile-drawer-mood')?.textContent).toBe('Hyped · loud · 23 h left');
    expect(drawer()?.querySelector('.profile-mood-ring')).not.toBeNull();
  });

  it('hides a lapsed mood but still draws the avatar', async () => {
    vi.setSystemTime((VECTOR.expect.mood.setAt + VECTOR.expect.mood.ttlSecs + 1) * 1000);
    await createProfilePlatform().presentProfile(product, {
      reference: VECTOR.reference,
    });
    await settle();

    expect(drawer()?.querySelector('img')).not.toBeNull();
    expect(drawer()?.querySelector('.profile-mood-ring')).toBeNull();
  });

  it('reads the slot over the gateway RPC on the Trusted Providers backend', async () => {
    mocks.backend = 'rpc-gateway';
    mocks.resolveSeitySlotViaRpc.mockResolvedValue({
      owner: `0x${'aa'.repeat(20)}`,
      cidDigest: VECTOR.registry.cidDigest,
      version: 1n,
    });
    await createProfilePlatform().presentProfile(product, {
      reference: VECTOR.reference,
    });
    await settle();

    expect(mocks.resolveSeitySlotViaRpc).toHaveBeenCalledWith(VECTOR.registry.lookupKey);
    expect(mocks.resolveSeitySlotRemote).not.toHaveBeenCalled();
    expect(drawer()?.querySelector('img')).not.toBeNull();
    expect(drawer()?.querySelector('.profile-mood-ring')).not.toBeNull();
  });

  it('keeps the mood when the avatar cannot be opened', async () => {
    // The record opens; the avatar's decrypt (the second one) fails, as a
    // re-sealed avatar would.
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let calls = 0;
    const spy = vi
      .spyOn(crypto.subtle, 'decrypt')
      .mockImplementation((...args: Parameters<SubtleCrypto['decrypt']>) =>
        ++calls === 2 ? Promise.reject(new DOMException('bad tag', 'OperationError')) : decrypt(...args),
      );
    try {
      await createProfilePlatform().presentProfile(product, {
        reference: VECTOR.reference,
      });
      await settle();
    } finally {
      spy.mockRestore();
    }

    expect(calls).toBe(2);
    expect(drawer()?.querySelector('img')).toBeNull();
    expect(drawer()?.querySelector('.profile-mood-ring')).not.toBeNull();
    expect(drawer()?.querySelector('.profile-drawer-mood')?.textContent).toBe('Hyped · loud · 23 h left');
  });

  it('accepts a contacts reference spelled in uppercase hex', () => {
    const prefix = 'seity-contacts:v1:';
    const body = VECTOR.reference.slice(prefix.length);
    expect(parseContactsReference(prefix + body.toUpperCase()).lookupKey).toBe(VECTOR.registry.lookupKey);
  });

  it('rejects a malformed contacts reference without opening UI or echoing the seed', async () => {
    const bad = VECTOR.reference.slice(0, -2);
    const call = createProfilePlatform().presentProfile(product, {
      reference: bad,
    });
    await expect(call).rejects.toBeInstanceOf(InvalidProfileReferenceError);
    await expect(call).rejects.not.toThrow(bad.slice(-64));
    expect(drawer()).toBeNull();
  });
});
