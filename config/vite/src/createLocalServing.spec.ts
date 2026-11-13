// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createLocalServing } from './createLocalServing.js';
import { getRootPage } from './siteRoutes.js';

/** The roots a development server answers on. */
const ROOTS = ['localhost', 'local.host'];

describe('getRoute', () => {
  it('As a visitor, I open the bare host and get the host build with the landing page at its root', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const hostname = 'localhost';

    // When
    const route = serving.getRoute(hostname, '/');
    const rootPage = getRootPage(route);

    // Then
    expect(route).toEqual({ site: 'host', bare: true });
    expect(rootPage).toBe('landing.html');
  });

  it('As a visitor, I open a product subdomain and get the shell', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const hostname = 'browse.localhost';

    // When
    const route = serving.getRoute(hostname, '/');
    const rootPage = getRootPage(route);

    // Then
    expect(route).toEqual({ site: 'host', bare: false });
    expect(rootPage).toBe('index.html');
  });

  it('As a product page, I load my sandbox origin and get the app build', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const sandbox = 'myapp.app.localhost';

    // When the sandbox origin's root is routed
    const route = serving.getRoute(sandbox, '/');

    // Then the app build serves it
    expect(route.site).toBe('app');
  });

  it('As a visitor, I open a host outside the local roots that holds .app. and get the bare host build', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When a public host that holds .app. is routed
    const route = serving.getRoute('myapp.app.example.com', '/');

    // Then the bare host build serves it
    expect(route).toEqual({ site: 'host', bare: true });
  });

  it('As a page on localhost, I load /p/assets/x.js and get the protocol build', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When a protocol asset is routed on localhost
    const route = serving.getRoute('localhost', '/p/assets/x.js');

    // Then the protocol build serves it
    expect(route).toEqual({ site: 'protocol', bare: false });
  });

  it("As a product page, I load /p/ on my host and get the host build, since the path is the product's own", () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When the protocol path is routed on a product host
    const route = serving.getRoute('browse.localhost', '/p/');

    // Then the host build serves it
    expect(route).toEqual({ site: 'host', bare: false });
  });

  it('As a visitor, I open /p without a trailing slash on localhost and get the host build', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When the protocol path without its trailing slash is routed on localhost
    const route = serving.getRoute('localhost', '/p');

    // Then the bare host build serves it
    expect(route).toEqual({ site: 'host', bare: true });
  });

  it('As a developer on local.host, I open a product subdomain of it and get the shell', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When a product subdomain of local.host is routed and its root page is read
    const route = serving.getRoute('browse.local.host', '/');
    const rootPage = getRootPage(route);

    // Then the host build serves the shell
    expect(route).toEqual({ site: 'host', bare: false });
    expect(rootPage).toBe('index.html');
  });

  it('As a visitor, I open a host that only ends like a local root and get the bare host', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When a host that only ends like local.host is routed
    const route = serving.getRoute('browse.notlocal.host', '/');

    // Then it is the bare host
    expect(route).toEqual({ site: 'host', bare: true });
  });
});

describe('createLocalServing', () => {
  it('As a user of a server for localhost alone, I open a product subdomain of local.host and get the bare host, and no local.host page may frame a sandbox', () => {
    // Given a server for localhost alone
    const serving = createLocalServing(['localhost']);

    // When a product subdomain of local.host is routed
    const route = serving.getRoute('browse.local.host', '/');

    // Then
    expect(route).toEqual({ site: 'host', bare: true });
    expect(serving.frameAncestors).not.toContain('local.host');
  });
});

describe('getResponseHeaders', () => {
  it('As a maintainer, I serve a hashed asset from the release server and it goes out with its type, immutable caching and the private network header', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const pathname = '/assets/a.js';

    // When
    const headers = serving.getResponseHeaders({ filePath: '/dist/host/assets/a.js', pathname, policy: 'worker-coep' });

    // Then
    expect(headers).toMatchObject({
      'Content-Type': 'text/javascript',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Private-Network': 'true',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    });
  });

  it('As a dotli developer, I serve a file of an unknown type from the test server and it goes out as bytes', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When
    const headers = serving.getResponseHeaders({
      filePath: '/dist/app/blob.bin',
      pathname: '/blob.bin',
      policy: 'isolated',
    });

    // Then
    expect(headers['Content-Type']).toBe('application/octet-stream');
  });
});

describe('getDevHeaders', () => {
  it('As a developer, I open the session window on the dev server and no page may frame it', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When the dev server's headers for each session path are built
    const headers = ['/s/auth', '/s/signout', '/s/sign'].map(path => serving.getDevHeaders('localhost', path));

    // Then no page may frame any of them
    expect(headers).toEqual([
      { 'Content-Security-Policy': "frame-ancestors 'none'" },
      { 'Content-Security-Policy': "frame-ancestors 'none'" },
      { 'Content-Security-Policy': "frame-ancestors 'none'" },
    ]);
  });

  it('As a developer, I open a percent-encoded session path on the dev server and no page may frame it', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When the dev server's headers for the encoded session path are built
    const headers = serving.getDevHeaders('localhost', '/s/%61uth');

    // Then no page may frame it
    expect(headers).toEqual({ 'Content-Security-Policy': "frame-ancestors 'none'" });
  });

  it('As a developer, I open /__preview and a shell page on the dev server, and only the preview is isolated', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When the dev server's headers for the preview and a shell page, and the isolated policy's headers, are built
    const preview = serving.getDevHeaders('localhost', '/__preview');
    const shell = serving.getDevHeaders('browse.localhost', '/');
    const isolated = serving.getSecurityHeaders('isolated');

    // Then only the preview carries the isolation headers
    expect(preview).toEqual(isolated);
    expect(shell).toEqual({});
  });

  it('As a developer, I open a sandbox and a page under either local root on any port and scheme may frame it', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When the dev server's headers for a local.host sandbox are built
    const headers = serving.getDevHeaders('myapp.app.local.host', '/');

    // Then its frame ancestors cover both local roots on any port and scheme
    expect(headers['Content-Security-Policy']?.split(' ')).toEqual([
      'frame-ancestors',
      'http://localhost:*',
      'http://*.localhost:*',
      'http://local.host:*',
      'http://*.local.host:*',
      'https://localhost:*',
      'https://*.localhost:*',
      'https://local.host:*',
      'https://*.local.host:*',
    ]);
  });
});

describe('getProtocolProxyBypass', () => {
  it('As a page on localhost, I load /p/?mode=direct and the dev proxy hands it to the protocol app', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When the proxy asks whether to skip the request
    const bypass = serving.getProtocolProxyBypass({ url: '/p/?mode=direct', headers: { host: 'localhost:4001' } });

    // Then it does not skip it
    expect(bypass).toBeUndefined();
  });

  it('As a product page, I load /p/x?y=1 on my host and the dev proxy leaves it to my host', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When the proxy asks whether to skip the request
    const bypass = serving.getProtocolProxyBypass({ url: '/p/x?y=1', headers: { host: 'browse.localhost:4001' } });

    // Then the request goes on unchanged
    expect(bypass).toBe('/p/x?y=1');
  });
});
