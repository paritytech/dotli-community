// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { BASE_DOMAIN, isSandboxOrigin } from '@dotli/config';

import { startSandboxChannel, type SandboxMessageType, type StartedSandboxChannel } from './sandbox-channel.js';

const SANDBOX = `https://doom.app.${BASE_DOMAIN}`;

// Stands in for the host window the channel listens on.
const hostWindow = new EventTarget();

// A sender the event can carry. Node's MessageEvent only takes a port as its source.
const { port1: sandboxFrame } = new MessageChannel();

afterAll(() => {
  sandboxFrame.close();
});

function post(data: unknown, origin: string, source: MessageEventSource | null = null): void {
  hostWindow.dispatchEvent(new MessageEvent('message', { data, origin, source }));
}

let channel: StartedSandboxChannel | null = null;

/** As the host starts it, with the real origin rule. A handler that throws fails the test unless it passes `report`. */
function startChannel(
  onUntrusted?: (type: string, origin: string) => void,
  report: (error: unknown, type: SandboxMessageType) => void = error => {
    throw error;
  },
): StartedSandboxChannel {
  channel = startSandboxChannel({
    target: hostWindow,
    isTrustedOrigin: isSandboxOrigin,
    report,
    ...(onUntrusted !== undefined ? { onUntrusted } : {}),
  });
  return channel;
}

afterEach(() => {
  channel?.stop();
  channel = null;
});

describe('sandbox channel', () => {
  it('As the host, I hand a sandbox message to the consumer of its type with who sent it', () => {
    // Given
    const heard: unknown[] = [];
    startChannel().on('dotli:bitswap-get', (message, sender) => {
      heard.push([message, sender.origin, sender.source]);
    });

    // When
    post({ type: 'dotli:bitswap-get', id: 'r-1', cid: 'bafyX' }, SANDBOX, sandboxFrame);

    // Then
    expect(heard).toEqual([[{ type: 'dotli:bitswap-get', id: 'r-1', cid: 'bafyX' }, SANDBOX, sandboxFrame]]);
  });

  it('As the host, a sandbox message handler that throws does not keep the next handler from hearing the message, and the failure is reported with its type', () => {
    // Given two handlers for one type, the first throwing
    const failure = new Error('handler broke');
    const reported: [unknown, SandboxMessageType][] = [];
    const heard: unknown[] = [];
    const started = startChannel(undefined, (error, type) => {
      reported.push([error, type]);
    });
    started.on('dotli:loading-status', () => {
      throw failure;
    });
    started.on('dotli:loading-status', message => {
      heard.push(message);
    });

    // When
    post({ type: 'dotli:loading-status', done: true }, SANDBOX);

    // Then
    expect(heard).toEqual([{ type: 'dotli:loading-status', done: true }]);
    expect(reported).toEqual([[failure, 'dotli:loading-status']]);
  });

  it('As the host, I do not hand a message to the consumers of other types', () => {
    // Given
    const heard: unknown[] = [];
    startChannel().on('dotli:sandbox-recover', message => {
      heard.push(message);
    });

    // When
    post({ type: 'dotli:loading-status', done: true }, SANDBOX);

    // Then
    expect(heard).toEqual([]);
  });

  it.each([
    ['another site', 'https://evil.example'],
    ['the host origin itself', `https://${BASE_DOMAIN}`],
    ['a look-alike of a sandbox origin', `https://doom.app.${BASE_DOMAIN}.evil.example`],
  ])('As the host, I drop a sandbox message posted by %s and report it', (_sender, origin) => {
    // Given
    const heard: unknown[] = [];
    const untrusted: unknown[] = [];
    startChannel((type, from) => {
      untrusted.push([type, from]);
    }).on('dotli:loading-status', message => {
      heard.push(message);
    });

    // When
    post({ type: 'dotli:loading-status', done: true, outcome: 'loaded' }, origin);

    // Then
    expect(heard).toEqual([]);
    expect(untrusted).toEqual([['dotli:loading-status', origin]]);
  });

  it('As the host, I ignore traffic that is not a sandbox message without reporting it', () => {
    // Given
    const untrusted: unknown[] = [];
    startChannel((type, from) => {
      untrusted.push([type, from]);
    });

    // When
    post({ __pw_sw_log__: true, text: 'hello' }, 'https://evil.example');

    // Then
    expect(untrusted).toEqual([]);
  });

  it('As a consumer, I unsubscribe and later messages no longer reach me', () => {
    // Given
    const heard: unknown[] = [];
    const unsubscribe = startChannel().on('dotli:sandbox-recover', message => {
      heard.push(message);
    });

    // When
    unsubscribe();
    post({ type: 'dotli:sandbox-recover' }, SANDBOX);

    // Then
    expect(heard).toEqual([]);
  });

  it('As the host, I stop the channel and it stops listening to the window', () => {
    // Given
    const heard: unknown[] = [];
    startChannel().on('dotli:sandbox-recover', message => {
      heard.push(message);
    });

    // When
    channel?.stop();
    post({ type: 'dotli:sandbox-recover' }, SANDBOX);

    // Then
    expect(heard).toEqual([]);
  });
});
