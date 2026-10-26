// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { BASE_DOMAIN } from '@dotli/config';
import {
  leaveForLanding,
  localTargetPath,
  readLocalhostUrl,
  readShellRoute,
  type LandingDeps,
  type RouteOptions,
  type ShellLocation,
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

describe('readShellRoute', () => {
  it('As a visitor on a product host, I get that product, whatever the path says', () => {
    // When
    const route = readShellRoute(at('http://doom.localhost:5173/localhost:3000/deep'), LOCAL_DEBUG);

    // Then
    expect(route).toEqual({ kind: 'product', label: 'doom', base: '' });
  });

  it('As a visitor on the bare host, I open a product by its name in the path, with or without .dot', () => {
    // When
    const plain = readShellRoute(at('https://example.li/doom/level/2?skill=3#boss'), RELEASE);
    const dotted = readShellRoute(at('https://example.li/Doom.dot'), RELEASE);

    // Then
    expect(plain).toEqual({ kind: 'product', label: 'doom', base: '/doom' });
    expect(dotted).toEqual({ kind: 'product', label: 'doom', base: '/Doom.dot' });
  });

  it('As a visitor on the bare host, I open a subname by its name in the path, with or without .dot', () => {
    // When
    const plain = readShellRoute(at('https://example.li/pr16.back-me-up/deep'), RELEASE);
    const dotted = readShellRoute(at('https://example.li/pr16.back-me-up.dot'), RELEASE);

    // Then
    expect(plain).toEqual({ kind: 'product', label: 'pr16.back-me-up', base: '/pr16.back-me-up' });
    expect(dotted).toEqual({ kind: 'product', label: 'pr16.back-me-up', base: '/pr16.back-me-up.dot' });
  });

  it('As a visitor on the bare host, a path that cannot be a name gets me no product', () => {
    // When
    const route = readShellRoute(at('https://example.li/not_a-name-/deep'), RELEASE);

    // Then
    expect(route).toEqual({ kind: 'landing' });
  });

  it('As a visitor on a sandbox host or the bare host, I am given no product, so the shell can send me to the landing page', () => {
    // When
    const sandbox = readShellRoute(at('http://bafy.app.localhost:5173/'), RELEASE);
    const bare = readShellRoute(at('http://localhost:5173/'), RELEASE);

    // Then
    expect(sandbox).toEqual({ kind: 'landing' });
    expect(bare).toEqual({ kind: 'landing' });
  });

  it('As a developer on local.host, I open a product subdomain and get that product, while its sandbox or the bare host gets none', () => {
    // Given a product subdomain, a sandbox host and the bare host on local.host
    const productUrl = at('https://doom.local.host:4321/deep');
    const sandboxUrl = at('https://bafy.app.local.host:4322/');
    const bareUrl = at('https://local.host:4321/');

    // When each is read
    const product = readShellRoute(productUrl, LOCAL_DEBUG);
    const sandbox = readShellRoute(sandboxUrl, LOCAL_DEBUG);
    const bare = readShellRoute(bareUrl, LOCAL_DEBUG);

    // Then only the product subdomain routes to its product
    expect(product).toEqual({ kind: 'product', label: 'doom', base: '' });
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

function landing(
  origin: string,
  pathname: string,
  workers: number,
  localRoot: string | null = 'localhost',
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
      localRoot,
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
    const { deps, replace } = landing(`https://bafy.app.${BASE_DOMAIN}`, '/', 0, null);

    // When
    await leaveForLanding(deps);

    // Then
    expect(replace).toHaveBeenCalledWith(`https://${BASE_DOMAIN}/?network=previewnet`);
  });

  it('As a developer on a local.host sandbox host, I am sent to the landing page on local.host and my port', async () => {
    // Given a page on a sandbox host of local.host
    const { deps, replace } = landing('https://bafy.app.local.host:4321', '/', 0, 'local.host');

    // When the page leaves for the landing page
    await leaveForLanding(deps);

    // Then it goes to local.host on the same port
    expect(replace).toHaveBeenCalledWith('https://local.host:4321/?network=previewnet');
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
