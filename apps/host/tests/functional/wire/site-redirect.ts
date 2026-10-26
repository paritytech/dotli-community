// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A third-party site that signs in by redirect, as a site that cannot keep a popup does. Its button makes a key pair
// for the round, keeps it in the tab's session storage, and goes to the sign-in window with its return address and
// public key in the request. Back on the return address, it opens the window's sealed answer with that key and marks
// the answer on its output by its type and reason. It speaks the wire protocol itself, with nothing of dot.li's own
// pages.

import { base64urlnopad, utf8 } from '@scure/base';
import { isValidNetwork } from '@dotli/config/networks';
import { PROTOCOL_VERSION, requestUrl } from '../../../src/runtime/session-handoff/session-protocol.js';

const X25519 = { name: 'X25519' } as const;
const KEPT_KEY = 'site-redirect:round';
const RETURN_PATH = '/back';

type KeptRound = {
  round: string;
  /** The round's private key, PKCS #8 in unpadded base64url. */
  privateKey: string;
};

type Envelope = {
  v: number;
  round: string;
  epk: string;
  iv: string;
  ct: string;
};

const button = document.querySelector<HTMLButtonElement>('[data-testid="opener-sign-in"]');
const output = document.querySelector<HTMLOutputElement>('[data-testid="site-reply"]');
if (button === null || output === null) {
  throw new Error('the site fixture page lacks its button or its output');
}

// WebCrypto takes bytes only over a plain ArrayBuffer, which a copy and TextEncoder give.
const bytes = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(base64urlnopad.decode(value));
const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

/** Opens the window's answer with the round's private key, as the client library does. */
async function openAnswer(kept: KeptRound, envelope: Envelope): Promise<Record<string, unknown>> {
  const privateKey = await crypto.subtle.importKey('pkcs8', bytes(kept.privateKey), X25519, false, ['deriveBits']);
  const epk = await crypto.subtle.importKey('raw', bytes(envelope.epk), X25519, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: epk }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: text(kept.round), info: text('dotli:s:v1:redirect') },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes(envelope.iv), additionalData: text(kept.round) },
    key,
    bytes(envelope.ct),
  );
  return JSON.parse(utf8.encode(new Uint8Array(plaintext))) as Record<string, unknown>;
}

/** Marks the answer the return address carries, once the page is back on it. */
async function readAnswer(answer: string, output: HTMLOutputElement): Promise<void> {
  const raw = sessionStorage.getItem(KEPT_KEY);
  if (raw === null) {
    throw new Error('the site fixture came back with no round kept');
  }
  const kept = JSON.parse(raw) as KeptRound;
  const envelope = JSON.parse(utf8.encode(base64urlnopad.decode(answer))) as Envelope;
  const message = await openAnswer(kept, envelope);
  output.dataset['type'] = String(message['type']);
  output.dataset['reason'] = String(message['reason']);
}

/** Makes the round's key pair, keeps it, and goes to the window with the request. */
async function signIn(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const net = query.get('net') ?? '';
  if (!isValidNetwork(net)) {
    throw new Error(`the site fixture needs a known network in ?net, got ${JSON.stringify(net)}`);
  }
  const windowOrigin = query.get('window') ?? '';
  if (!URL.canParse(windowOrigin)) {
    throw new Error(`the site fixture needs the window's origin in ?window, got ${JSON.stringify(windowOrigin)}`);
  }
  const round = crypto.randomUUID();
  const pair = await crypto.subtle.generateKey(X25519, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const kept: KeptRound = { round, privateKey: base64urlnopad.encode(privateKey) };
  sessionStorage.setItem(KEPT_KEY, JSON.stringify(kept));
  const params = {
    v: PROTOCOL_VERSION,
    net,
    round,
    return_to: `${location.origin}${RETURN_PATH}`,
    pub: base64urlnopad.encode(pub),
  };
  location.assign(requestUrl(windowOrigin, 'auth', params));
}

const answer = new URLSearchParams(location.hash.slice(1)).get('dotli-s');
if (location.pathname === RETURN_PATH && answer !== null) {
  readAnswer(answer, output).catch((error: unknown) => {
    // Marked on the output, so a test waiting for the answer fails with what went wrong.
    output.dataset['type'] = `failed: ${String(error)}`;
  });
}
button.addEventListener('click', () => {
  void signIn();
});
