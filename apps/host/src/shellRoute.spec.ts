// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, type Mock } from 'vitest';
import { BASE_DOMAIN } from '@dotli/config';
import {
  getLocalTargetPath,
  leaveForLanding,
  readLocalhostUrl,
  readShellRoute,
  type LeaveForLandingParams,
  type ReadShellRouteParams,
  type ShellLocation,
} from './shellRoute.js';

type SetupLandingParams = {
  /** The page's origin. */
  origin: string;
  /** The page's path, the root by default. */
  pathname?: string;
  /** The local root the page runs under, `localhost` by default. */
  localRoot?: string | null;
};

/** A page leaving for the landing page, and the fakes it reaches. */
type Landing = {
  params: LeaveForLandingParams;
  replace: Mock;
};

const RELEASE: ReadShellRouteParams = { localhost: false, framed: false, readLocalhostProxyUrl: undefined };
const LOCAL_DEBUG: ReadShellRouteParams = { localhost: true, framed: false, readLocalhostProxyUrl: readLocalhostUrl };
const PREVIEW = 'https://abc123.webcontainer-api.io/';

describe('readShellRoute', () => {
  it('As a visitor on a product host, I open any path and get that product', () => {
    // When
    const route = readShellRoute(toLocation('http://doom.localhost:5173/localhost:3000/deep'), LOCAL_DEBUG);

    // Then
    expect(route).toEqual({ kind: 'product', label: 'doom', base: '' });
  });

  it('As a visitor on the bare host, I open a product by its name in the path and get it with or without .dot', () => {
    // When
    const plain = readShellRoute(toLocation('https://example.li/doom/level/2?skill=3#boss'), RELEASE);
    const dotted = readShellRoute(toLocation('https://example.li/Doom.dot'), RELEASE);

    // Then
    expect(plain).toEqual({ kind: 'product', label: 'doom', base: '/doom' });
    expect(dotted).toEqual({ kind: 'product', label: 'doom', base: '/Doom.dot' });
  });

  it('As a visitor on the bare host, I open a subname by its name in the path and get it with or without .dot', () => {
    // When
    const plain = readShellRoute(toLocation('https://example.li/pr16.back-me-up/deep'), RELEASE);
    const dotted = readShellRoute(toLocation('https://example.li/pr16.back-me-up.dot'), RELEASE);

    // Then
    expect(plain).toEqual({ kind: 'product', label: 'pr16.back-me-up', base: '/pr16.back-me-up' });
    expect(dotted).toEqual({ kind: 'product', label: 'pr16.back-me-up', base: '/pr16.back-me-up.dot' });
  });

  it('As a visitor on the bare host, I open a path that cannot be a name and get no product', () => {
    // When
    const route = readShellRoute(toLocation('https://example.li/not_a-name-/deep'), RELEASE);

    // Then
    expect(route).toEqual({ kind: 'landing' });
  });

  it('As a visitor on the bare host, I open a one-letter path in any spelling and get no product', () => {
    // Given one-letter paths, bare, with a slash, deeper, uppercased and with .dot
    const paths = ['/s', '/s/', '/s/anything', '/S/x', '/s.dot/x', '/p', '/p/', '/p/x', '/P/x', '/p.dot/x'];

    // When each is read on the bare host
    const routes = paths.map(path => readShellRoute(toLocation(`https://example.li${path}`), RELEASE));

    // Then none of them names a product
    expect(routes).toEqual(paths.map(() => ({ kind: 'landing' })));
  });

  it('As a visitor, I open a one-letter host and get no product', () => {
    // Given hosts of one-letter labels
    const locations = [toLocation('http://s.localhost:5173/s/auth'), toLocation('http://p.localhost:5173/')];

    // When each is read
    const routes = locations.map(location => readShellRoute(location, RELEASE));

    // Then none of them names a product
    expect(routes).toEqual([{ kind: 'landing' }, { kind: 'landing' }]);
  });

  it('As a visitor on the bare host, I open a subname with a one-letter label by path and get it', () => {
    // Given a link to a subname whose first label is one letter
    const location = toLocation('https://example.li/a.my-app/x');

    // When it is read
    const route = readShellRoute(location, RELEASE);

    // Then the subname is the product
    expect(route).toEqual({ kind: 'product', label: 'a.my-app', base: '/a.my-app' });
  });

  it('As a visitor on a sandbox host or the bare host, I open it and am given no product, so the shell can send me to the landing page', () => {
    // When
    const sandbox = readShellRoute(toLocation('http://bafy.app.localhost:5173/'), RELEASE);
    const bare = readShellRoute(toLocation('http://localhost:5173/'), RELEASE);

    // Then
    expect(sandbox).toEqual({ kind: 'landing' });
    expect(bare).toEqual({ kind: 'landing' });
  });

  it('As a developer on local.host, I open a product subdomain and get that product, while its sandbox or the bare host gets none', () => {
    // Given a product subdomain, a sandbox host and the bare host on local.host
    const productUrl = toLocation('https://doom.local.host:4321/deep');
    const sandboxUrl = toLocation('https://bafy.app.local.host:4322/');
    const bareUrl = toLocation('https://local.host:4321/');

    // When each is read
    const product = readShellRoute(productUrl, LOCAL_DEBUG);
    const sandbox = readShellRoute(sandboxUrl, LOCAL_DEBUG);
    const bare = readShellRoute(bareUrl, LOCAL_DEBUG);

    // Then only the product subdomain routes to its product
    expect(product).toEqual({ kind: 'product', label: 'doom', base: '' });
    expect(sandbox).toEqual({ kind: 'landing' });
    expect(bare).toEqual({ kind: 'landing' });
  });

  it('As a developer previewing a web container on localhost, I ask for a product id and get the preview with it', () => {
    // When
    const route = readShellRoute(toPreviewLocation(PREVIEW, '&dotliProductId=localhost%3A3000'), LOCAL_DEBUG);

    // Then
    expect(route).toEqual({
      kind: 'preview',
      url: PREVIEW,
      host: 'abc123.webcontainer-api.io',
      productId: 'localhost:3000',
    });
  });

  it('As a visitor off localhost, I open a preview that claims another product id and the claim is dropped', () => {
    // When
    const route = readShellRoute(toPreviewLocation(PREVIEW, '&dotliProductId=localhost%3A3000'), RELEASE);

    // Then
    expect(route).toMatchObject({ kind: 'preview', productId: undefined });
  });

  it('As a developer, I open my localhost target and it is proxied only in a debug build, without the host settings in its URL', () => {
    // Given
    const location = toLocation('http://localhost:5173/localhost:3000/game?level=2&network=previewnet&v=1#boss');

    // When
    const debug = readShellRoute(location, LOCAL_DEBUG);
    const release = readShellRoute(location, { ...LOCAL_DEBUG, readLocalhostProxyUrl: undefined });

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
    const route = readShellRoute(
      toLocation('http://localhost:5173/localhost:3000/?dotliProductId=evil.com'),
      LOCAL_DEBUG,
    );

    // Then
    expect(route).toMatchObject({ kind: 'localhost', productId: undefined });
  });

  it('As a visitor on a page framed by another page, I open it and it starts nothing unless it is a preview', () => {
    // When
    const nested = readShellRoute(toLocation('http://doom.localhost:5173/'), { ...RELEASE, framed: true });
    const preview = readShellRoute(toPreviewLocation(PREVIEW), { ...RELEASE, framed: true });

    // Then
    expect(nested).toEqual({ kind: 'nested' });
    expect(preview).toMatchObject({ kind: 'preview' });
  });
});

describe('getLocalTargetPath', () => {
  it('As a developer, I see the URL bar keep the preview target and drop the deep path of a local target', () => {
    // When
    const preview = getLocalTargetPath({ kind: 'preview', url: PREVIEW, host: 'x', productId: 'localhost:3000' });
    const local = getLocalTargetPath({
      kind: 'localhost',
      url: 'http://localhost:3000/game?level=2',
      host: 'localhost:3000',
      productId: undefined,
    });

    // Then
    expect(preview).toBe(`/__preview?url=${encodeURIComponent(PREVIEW)}&dotliProductId=localhost%3A3000`);
    expect(local).toBe('/localhost:3000');
  });

  it('As a developer, I give my local target a product id and the URL bar keeps it', () => {
    // When
    const path = getLocalTargetPath({
      kind: 'localhost',
      url: 'http://localhost:3000/game',
      host: 'localhost:3000',
      productId: 'doom.dot',
    });

    // Then
    expect(path).toBe('/localhost:3000?dotliProductId=doom.dot');
  });
});

describe('leaveForLanding', () => {
  it('As a visitor on a host that names no product, I leave and am sent to the landing page with my settings', () => {
    // Given
    const { params, replace } = setupLanding({ origin: 'http://bafy.app.localhost:5173' });

    // When
    leaveForLanding(params);

    // Then
    expect(replace).toHaveBeenCalledWith('http://localhost:5173/?network=previewnet');
  });

  it('As a visitor on a deployed sandbox host, I leave and am sent to the landing page on the base domain', () => {
    // Given
    const { params, replace } = setupLanding({ origin: `https://bafy.app.${BASE_DOMAIN}`, localRoot: null });

    // When
    leaveForLanding(params);

    // Then
    expect(replace).toHaveBeenCalledWith(`https://${BASE_DOMAIN}/?network=previewnet`);
  });

  it('As a developer on a local.host sandbox host, I leave and am sent to the landing page on local.host and my port', () => {
    // Given a page on a sandbox host of local.host
    const { params, replace } = setupLanding({ origin: 'https://bafy.app.local.host:4321', localRoot: 'local.host' });

    // When the page leaves for the landing page
    leaveForLanding(params);

    // Then it goes to local.host on the same port
    expect(replace).toHaveBeenCalledWith('https://local.host:4321/?network=previewnet');
  });

  it('As a visitor whose server answers the landing URL with the shell, I leave and see an error rather than a reload loop', () => {
    // Given
    const { params, replace } = setupLanding({ origin: 'http://localhost:5173' });

    // When
    const leave = () => {
      leaveForLanding(params);
    };

    // Then
    expect(leave).toThrow(
      new Error('leaveForLanding: http://localhost:5173/ answered with the shell, not the landing page'),
    );
    expect(replace).not.toHaveBeenCalled();
  });
});

function toLocation(url: string): ShellLocation {
  const { hostname, pathname, search, hash } = new URL(url);
  return { hostname, pathname, search, hash };
}

function toPreviewLocation(target: string, extra = ''): ShellLocation {
  return toLocation(`http://localhost:5173/__preview?url=${encodeURIComponent(target)}${extra}`);
}

/** Builds a page at `origin` that leaves for the landing page. */
function setupLanding({ origin, pathname = '/', localRoot = 'localhost' }: SetupLandingParams): Landing {
  const url = new URL(origin);
  const replace = vi.fn();
  return {
    params: {
      location: {
        protocol: url.protocol,
        port: url.port,
        pathname,
        search: '?network=previewnet',
        origin: url.origin,
        replace,
      },
      localRoot,
    },
    replace,
  };
}
