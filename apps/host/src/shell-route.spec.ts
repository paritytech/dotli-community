// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_DOMAIN, configureModeStorage } from '@dotli/config';
import { memoryModeStorage } from '@dotli/config/testing';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import {
  leaveForLanding,
  localTargetPath,
  readLocalhostUrl,
  readShellRoute,
  runShell,
  type LandingDeps,
  type RouteOptions,
  type ShellDeps,
  type ShellLocation,
  type ShellRoute,
  type ShellServices,
} from './shell-route.js';

const RELEASE: RouteOptions = { localhost: false, framed: false, localhostProxy: undefined };
const LOCAL_DEBUG: RouteOptions = { localhost: true, framed: false, localhostProxy: readLocalhostUrl };
const PREVIEW = 'https://abc123.webcontainer-api.io/';

function at(url: string): ShellLocation {
  const { hostname, pathname, search, hash } = new URL(url);
  return { hostname, pathname, search, hash };
}

function previewAt(target: string, extra = ''): ShellLocation {
  return at(`http://localhost:5173/__preview?url=${encodeURIComponent(target)}${extra}`);
}

// Settings come from a memory store, not Node's localStorage, and the previous store is put back after each test.
beforeEach(() => configureModeStorage(memoryModeStorage()));

describe('readShellRoute', () => {
  it('As a visitor on a product host, I get that product, whatever the path says', () => {
    // When
    const route = readShellRoute(at('http://doom.localhost:5173/localhost:3000/deep'), LOCAL_DEBUG);

    // Then
    expect(route).toEqual({ kind: 'product', label: 'doom' });
  });

  it('As a visitor on a sandbox host or the bare host, I am given no product, so the shell can send me to the landing page', () => {
    // When
    const sandbox = readShellRoute(at('http://bafy.app.localhost:5173/'), RELEASE);
    const bare = readShellRoute(at('http://localhost:5173/'), RELEASE);

    // Then
    expect(sandbox).toEqual({ kind: 'landing' });
    expect(bare).toEqual({ kind: 'landing' });
  });

  it('As a developer previewing a web container, I get the preview with the product id I asked for on localhost', () => {
    // When
    const route = readShellRoute(previewAt(PREVIEW, '&dotliProductId=localhost%3A3000'), LOCAL_DEBUG);

    // Then
    expect(route).toEqual({
      kind: 'preview',
      url: PREVIEW,
      host: 'abc123.webcontainer-api.io',
      productId: 'localhost:3000',
    });
  });

  it('As a visitor off localhost, I cannot make a preview claim another product id', () => {
    // When
    const route = readShellRoute(previewAt(PREVIEW, '&dotliProductId=localhost%3A3000'), RELEASE);

    // Then
    expect(route).toMatchObject({ kind: 'preview', productId: undefined });
  });

  it('As a developer, I get my localhost proxied only in a debug build, without the host settings in its URL', () => {
    // Given
    const location = at('http://localhost:5173/localhost:3000/game?level=2&network=previewnet&v=1#boss');

    // When
    const debug = readShellRoute(location, LOCAL_DEBUG);
    const release = readShellRoute(location, { ...LOCAL_DEBUG, localhostProxy: undefined });

    // Then
    expect(debug).toEqual({
      kind: 'localhost',
      url: 'http://localhost:3000/game?level=2#boss',
      host: 'localhost:3000',
      productId: undefined,
    });
    expect(release).toEqual({ kind: 'landing' });
  });

  it('As a developer, I pass a product id that names no product and it is ignored', () => {
    // When
    const route = readShellRoute(at('http://localhost:5173/localhost:3000/?dotliProductId=evil.com'), LOCAL_DEBUG);

    // Then
    expect(route).toMatchObject({ kind: 'localhost', productId: undefined });
  });

  it('As a page framed by another page, I start nothing unless I am a preview', () => {
    // When
    const nested = readShellRoute(at('http://doom.localhost:5173/'), { ...RELEASE, framed: true });
    const preview = readShellRoute(previewAt(PREVIEW), { ...RELEASE, framed: true });

    // Then
    expect(nested).toEqual({ kind: 'nested' });
    expect(preview).toMatchObject({ kind: 'preview' });
  });
});

describe('localTargetPath', () => {
  it('As a developer, I see the URL bar keep the preview target and drop the deep path of a local target', () => {
    // When
    const preview = localTargetPath({ kind: 'preview', url: PREVIEW, host: 'x', productId: 'localhost:3000' });
    const local = localTargetPath({
      kind: 'localhost',
      url: 'http://localhost:3000/game?level=2',
      host: 'localhost:3000',
      productId: undefined,
    });

    // Then
    expect(preview).toBe(`/__preview?url=${encodeURIComponent(PREVIEW)}&dotliProductId=localhost%3A3000`);
    expect(local).toBe('/localhost:3000');
  });

  it('As a developer, I see the URL bar keep the product id I gave my local target', () => {
    // When
    const path = localTargetPath({
      kind: 'localhost',
      url: 'http://localhost:3000/game',
      host: 'localhost:3000',
      productId: 'doom.dot',
    });

    // Then
    expect(path).toBe('/localhost:3000?dotliProductId=doom.dot');
  });
});

interface ShellHarness {
  deps: ShellDeps<ShellServices>;
  calls: string[];
  debug: DotliDebugEvent[];
}

function shell(route: ShellRoute): ShellHarness {
  const calls: string[] = [];
  const debug: DotliDebugEvent[] = [];
  const services: ShellServices = {
    emit: event => {
      debug.push(event);
    },
    flowId: 'boot-1',
  };
  const record =
    (name: string) =>
    (arg?: unknown): Promise<void> => {
      calls.push(arg === undefined ? name : `${name} ${typeof arg === 'string' ? arg : JSON.stringify(arg)}`);
      return Promise.resolve();
    };
  return {
    deps: {
      route,
      showProductPill: label => {
        calls.push(`productPill ${label}`);
      },
      showLocalhostPill: host => {
        calls.push(`localhostPill ${host}`);
      },
      startShell: () => {
        calls.push('startShell');
        return Promise.resolve(services);
      },
      openLocalTarget: target => record('openLocalTarget')(target.kind),
      openProduct: label => record('openProduct')(label),
      leaveForLanding: () => record('leaveForLanding')(),
      deepPath: () => '/deep?x=1',
    },
    calls,
    debug,
  };
}

describe('runShell', () => {
  it('As a visitor on a product host, I see its name in the URL bar before the host starts, then the product loads', async () => {
    // Given
    const { deps, calls, debug } = shell({ kind: 'product', label: 'doom' });

    // When
    await runShell(deps);

    // Then
    expect(calls).toEqual(['productPill doom', 'startShell', 'openProduct doom']);
    expect(debug.map(event => event.payload)).toEqual([{ label: 'doom', localhostHost: null, deepPath: '/deep?x=1' }]);
  });

  it('As a developer previewing a web container, I see its host in the URL bar and the preview renders', async () => {
    // Given
    const { deps, calls, debug } = shell({ kind: 'preview', url: PREVIEW, host: 'abc.io', productId: undefined });

    // When
    await runShell(deps);

    // Then
    expect(calls).toEqual(['localhostPill abc.io', 'startShell', 'openLocalTarget preview']);
    expect(debug).toEqual([]);
  });

  it('As a developer on my localhost, I see it proxied after the host starts', async () => {
    // Given
    const { deps, calls, debug } = shell({
      kind: 'localhost',
      url: 'http://localhost:3000/',
      host: 'localhost:3000',
      productId: undefined,
    });

    // When
    await runShell(deps);

    // Then
    expect(calls).toEqual(['localhostPill localhost:3000', 'startShell', 'openLocalTarget localhost']);
    expect(debug.map(event => event.payload)).toEqual([
      { label: null, localhostHost: 'localhost:3000', deepPath: '/deep?x=1' },
    ]);
  });

  it('As a visitor on a URL that names no product, I am sent on to the landing page once the host has started', async () => {
    // Given
    const { deps, calls } = shell({ kind: 'landing' });

    // When
    await runShell(deps);

    // Then
    expect(calls).toEqual(['startShell', 'leaveForLanding']);
  });

  it('As a page framed by another page, I start nothing', async () => {
    // Given
    const { deps, calls } = shell({ kind: 'nested' });

    // When
    await runShell(deps);

    // Then
    expect(calls).toEqual([]);
  });

  it('As a visitor whose settings rewrite the URL as the host starts, I see the debug panel get the path after that rewrite', async () => {
    // Given a page whose path changes once the host has started and applied its settings
    const { deps, debug } = shell({ kind: 'product', label: 'doom' });
    let path = '/deep?network=previewnet&x=1';
    const startShell = deps.startShell;
    deps.startShell = async () => {
      const services = await startShell();
      path = '/deep?x=1';
      return services;
    };
    deps.deepPath = () => path;

    // When
    await runShell(deps);

    // Then
    expect(debug.map(event => event.payload)).toEqual([{ label: 'doom', localhostHost: null, deepPath: '/deep?x=1' }]);
  });

  it('As a visitor whose host fails to start, I get that failure reported and no product starts', async () => {
    // Given
    const { deps, calls } = shell({ kind: 'product', label: 'doom' });
    deps.startShell = () => Promise.reject(new Error('bridge chunk failed'));

    // When
    const outcome = await runShell(deps).catch((err: unknown) => err);

    // Then
    expect(outcome).toEqual(new Error('bridge chunk failed'));
    expect(calls).toEqual(['productPill doom']);
  });
});

function landing(
  origin: string,
  pathname: string,
  workers: number,
  localhost = true,
): { deps: LandingDeps; replace: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn> } {
  const url = new URL(origin);
  const replace = vi.fn();
  const unregister = vi.fn(() => Promise.resolve(true));
  return {
    deps: {
      location: {
        protocol: url.protocol,
        port: url.port,
        pathname,
        search: '?network=previewnet',
        origin: url.origin,
        replace,
      },
      localhost,
      workers: () => Promise.resolve(Array.from({ length: workers }, () => ({ unregister }))),
    },
    replace,
    unregister,
  };
}

describe('leaveForLanding', () => {
  it("As a visitor caught by an old release's service worker, I am freed of it and sent to the landing page", async () => {
    // Given
    const { deps, replace, unregister } = landing('http://localhost:5173', '/', 2);

    // When
    await leaveForLanding(deps);

    // Then
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith('http://localhost:5173/?network=previewnet');
  });

  it('As a visitor on a host that names no product, I am sent to the landing page with my settings', async () => {
    // Given
    const { deps, replace } = landing('http://bafy.app.localhost:5173', '/', 0);

    // When
    await leaveForLanding(deps);

    // Then
    expect(replace).toHaveBeenCalledWith('http://localhost:5173/?network=previewnet');
  });

  it('As a visitor on a deployed sandbox host, I am sent to the landing page on the base domain', async () => {
    // Given
    const { deps, replace } = landing(`https://bafy.app.${BASE_DOMAIN}`, '/', 0, false);

    // When
    await leaveForLanding(deps);

    // Then
    expect(replace).toHaveBeenCalledWith(`https://${BASE_DOMAIN}/?network=previewnet`);
  });

  it('As a visitor whose server answers the landing URL with the shell, I see an error rather than a reload loop', async () => {
    // Given
    const { deps, replace } = landing('http://localhost:5173', '/', 0);

    // When
    const outcome = await leaveForLanding(deps).catch((err: unknown) => err);

    // Then
    expect(outcome).toEqual(new Error('the server answered the landing page URL with the shell'));
    expect(replace).not.toHaveBeenCalled();
  });
});
