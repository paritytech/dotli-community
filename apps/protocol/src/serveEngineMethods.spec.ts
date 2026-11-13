// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { protocolSchema } from '@dotli/protocol';
import { err, ok, unsupported } from '@dotli/transport';
import { serveEngineMethods, type EngineMethods } from './serveEngineMethods.js';
import { closeHostLinks, linkHost } from './testing/linkHost.js';

afterEach(closeHostLinks);

const { frame } = protocolSchema.sections;

/** Methods that answer at once, so a call that reaches them succeeds. */
function createServed(): EngineMethods {
  return {
    warmup: () => Promise.resolve(ok()),
    resolveDotName: () => () => undefined,
    resolveOwner: () => Promise.resolve(ok(null)),
    resolveExecutableManifest: () => Promise.resolve(ok({ kind: 'empty' })),
    resolveRootManifest: () => Promise.resolve(ok({ kind: 'empty' })),
    connect: () => () => undefined,
    send: () => Promise.resolve(ok()),
  };
}

describe('serving the engine methods', () => {
  it("As a frame that stops serving the engine, I stop the served methods and the host's next call is refused", async () => {
    // Given the engine methods served to a host
    const { serving, host } = linkHost();
    const stop = serveEngineMethods(serving, createServed());
    const served = await host.request(frame.warmup, undefined);

    // When the frame stops serving them
    stop();
    const refused = await host.request(frame.warmup, undefined);

    // Then the host's next call is refused as an unserved method
    expect(served).toEqual(ok());
    expect(refused).toEqual(err(unsupported()));
  });
});
