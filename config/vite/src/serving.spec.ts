// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createLocalServing,
  fileHeaders,
  headerPolicy,
  pathInBuild,
  policyHeaders,
  requestHostname,
  resolveFile,
  rootPage,
} from './serving.js';
import { nginxHeaders } from './testing/nginx.js';

const NGINX_ANCESTORS = '$csp_ancestors';

/** The roots a development server answers on. */
const ROOTS = ['localhost', 'local.host'];

describe('requestHostname', () => {
  it('As a visitor on the https dev server, I send an HTTP/2 request whose :authority names the host and reach my product', () => {
    // Given an HTTP/2 request's headers
    const headers = { ':authority': 'browse.localhost:4321' };

    // When the host is read from them
    const hostname = requestHostname(headers);

    // Then it is the :authority host without its port
    expect(hostname).toBe('browse.localhost');
  });

  it('As a visitor over HTTP/1.1, I send a request and its Host header names the host', () => {
    // Given an HTTP/1.1 request's headers
    const headers = { host: 'browse.localhost:5173' };

    // When the host is read from them
    const hostname = requestHostname(headers);

    // Then it is the Host header without its port
    expect(hostname).toBe('browse.localhost');
  });
});

describe('routeFor', () => {
  it('As a visitor, I open the bare host and get the host build with the landing page at its root', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const hostname = 'localhost';

    // When
    const route = serving.routeFor(hostname, '/');

    // Then
    expect(route).toEqual({ site: 'host', bare: true });
    expect(rootPage(route)).toBe('landing.html');
  });

  it('As a visitor, I open a product subdomain and get the shell', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const hostname = 'browse.localhost';

    // When
    const route = serving.routeFor(hostname, '/');

    // Then
    expect(route).toEqual({ site: 'host', bare: false });
    expect(rootPage(route)).toBe('index.html');
  });

  it('As a product page, I load my sandbox origin and get the app build', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const sandbox = 'myapp.app.localhost';

    // When the sandbox origin's root is routed
    const route = serving.routeFor(sandbox, '/');

    // Then the app build serves it
    expect(route.site).toBe('app');
  });

  it('As a page on localhost, I load /__protocol/assets/x.js and get the protocol build', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When a protocol asset is routed on localhost
    const route = serving.routeFor('localhost', '/__protocol/assets/x.js');

    // Then the protocol build serves it
    expect(route).toEqual({ site: 'protocol', bare: false });
  });

  it('As a product page, I load /__protocol/ on my host and get the protocol build', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When the protocol path is routed on a product host
    const route = serving.routeFor('browse.localhost', '/__protocol/');

    // Then the protocol build serves it
    expect(route.site).toBe('protocol');
  });

  it("As a user, I open /__session on localhost and get the host build's session page", () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When the session path is routed on localhost
    const route = serving.routeFor('localhost', '/__session');

    // Then the bare host build serves it
    expect(route).toEqual({ site: 'host', bare: true });
  });

  it('As a user on an old shell, I open host.localhost for its frame and get the protocol build for one more release', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When host.localhost is routed
    const route = serving.routeFor('host.localhost', '/');

    // Then the protocol build serves it
    expect(route).toEqual({ site: 'protocol', bare: false });
  });

  it('As a developer on local.host, I open the bare local.host and get the host build with the landing page', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When the bare local.host is routed
    const route = serving.routeFor('local.host', '/');

    // Then the host build serves its landing page
    expect(route).toEqual({ site: 'host', bare: true });
    expect(rootPage(route)).toBe('landing.html');
  });

  it('As a developer on local.host, I open a product subdomain of it and get the shell', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When a product subdomain of local.host is routed
    const route = serving.routeFor('browse.local.host', '/');

    // Then the host build serves the shell
    expect(route).toEqual({ site: 'host', bare: false });
    expect(rootPage(route)).toBe('index.html');
  });

  it('As a product page on local.host, I load my sandbox on its app subdomain and get the app build', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When a sandbox on an app subdomain of local.host is routed
    const route = serving.routeFor('myapp.app.local.host', '/');

    // Then the app build serves it
    expect(route).toEqual({ site: 'app', bare: false });
  });

  it('As a user on an old shell on local.host, I open host.local.host for its frame and get the protocol build', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When host.local.host is routed
    const route = serving.routeFor('host.local.host', '/');

    // Then the protocol build serves it
    expect(route).toEqual({ site: 'protocol', bare: false });
  });

  it('As a visitor on a host that only ends like a local root, I get the bare host', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When a host that only ends like local.host is routed
    const route = serving.routeFor('browse.notlocal.host', '/');

    // Then it is the bare host
    expect(route).toEqual({ site: 'host', bare: true });
  });
});

describe('createLocalServing', () => {
  it('As a user of a server for localhost alone, I open a product subdomain of local.host and get the bare host, and no local.host page may frame a sandbox', () => {
    // Given a server for localhost alone
    const serving = createLocalServing(['localhost']);

    // When a product subdomain of local.host is routed
    const route = serving.routeFor('browse.local.host', '/');

    // Then
    expect(route).toEqual({ site: 'host', bare: true });
    expect(serving.frameAncestors).not.toContain('local.host');
  });
});

describe('pathInBuild', () => {
  it('As a page on localhost, I load a protocol file and it is looked up without the prefix its base adds', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const route = serving.routeFor('localhost', '/__protocol/assets/x.js');

    // When the protocol paths are looked up
    const paths = [pathInBuild(route, '/__protocol/assets/x.js'), pathInBuild(route, '/__protocol/')];

    // Then the prefix is gone
    expect(paths).toEqual(['/assets/x.js', '/']);
  });

  it('As a user on an old shell on host.localhost, I ask for the protocol build at its root and the lookup keeps my path', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const route = serving.routeFor('host.localhost', '/host_version.json');

    // When the version file is looked up
    const path = pathInBuild(route, '/host_version.json');

    // Then the path is kept
    expect(path).toBe('/host_version.json');
  });

  it('As a page on localhost, I load a host file and it is looked up under its own path', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When a host file is looked up
    const path = pathInBuild(serving.routeFor('localhost', '/a'), '/a');

    // Then the path is kept
    expect(path).toBe('/a');
  });
});

describe('headerPolicy', () => {
  it('As a sandbox page, I am served from my origin and every response is isolated', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const sandbox = serving.routeFor('myapp.app.localhost', '/');
    const protocol = serving.routeFor('localhost', '/__protocol/assets/a.js');

    // When
    const policies = [headerPolicy(sandbox, '/'), headerPolicy(protocol, '/__protocol/assets/a.js')];

    // Then
    expect(policies).toEqual(['isolated', 'isolated']);
  });

  it("As a preview embedder, I open /__preview and only the bare host's page is isolated", () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const bare = serving.routeFor('localhost', '/');
    const shell = serving.routeFor('browse.localhost', '/');

    // When
    const policies = [headerPolicy(bare, '/__preview'), headerPolicy(shell, '/__preview')];

    // Then
    expect(policies).toEqual(['isolated', 'plain']);
  });

  it('As a user, I open the sign-in window on the bare host and no page may frame it', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const bare = serving.routeFor('localhost', '/__session');
    const shell = serving.routeFor('browse.localhost', '/__session');

    // When the session path's policy is read on both hosts
    const policies = [headerPolicy(bare, '/__session'), headerPolicy(shell, '/__session')];

    // Then only the bare host's session page is unframed
    expect(policies).toEqual(['unframed', 'plain']);
  });

  it('As a product host, my assets carry no COEP', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const shell = serving.routeFor('browse.localhost', '/');

    // When
    const policy = headerPolicy(shell, '/assets/w.js');

    // Then
    expect(policy).toBe('plain');
  });

  it('As the bare host, my assets carry COEP so /__preview can start their workers', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const bare = serving.routeFor('localhost', '/');

    // When
    const policy = headerPolicy(bare, '/assets/w.js');

    // Then
    expect(policy).toBe('worker-coep');
  });
});

describe('responseHeaders', () => {
  it('As the release server, I send a hashed asset with its type, immutable caching and the private network header', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const pathname = '/assets/a.js';

    // When
    const headers = serving.responseHeaders('/dist/host/assets/a.js', pathname, 'worker-coep');

    // Then
    expect(headers).toMatchObject({
      'Content-Type': 'text/javascript',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Private-Network': 'true',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    });
  });

  it('As the test server, I send a file of an unknown type as bytes', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When
    const headers = serving.responseHeaders('/dist/app/blob.bin', '/blob.bin', 'isolated');

    // Then
    expect(headers['Content-Type']).toBe('application/octet-stream');
  });
});

describe('resolveFile', () => {
  const DIR = '/srv/host';

  /** A build folder holding `paths`, which records every path a lookup asks for. */
  function build(...paths: string[]): { asked: string[]; isFile: (path: string) => boolean } {
    const present = new Set(paths.map(path => join(DIR, path)));
    const asked: string[] = [];
    return {
      asked,
      isFile: path => {
        asked.push(path);
        return present.has(path);
      },
    };
  }

  it('As a visitor, I open the bare host and get the landing page', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const disk = build('landing.html', 'index.html');

    // When
    const resolved = resolveFile(DIR, serving.routeFor('localhost', '/'), '/', disk.isFile);

    // Then
    expect(resolved).toEqual({ file: join(DIR, 'landing.html'), pathname: '/landing.html' });
  });

  it('As a visitor, I follow a deep link on a product host and get the shell', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const disk = build('index.html');

    // When
    const resolved = resolveFile(DIR, serving.routeFor('browse.localhost', '/'), '/some/page', disk.isFile);

    // Then
    expect(resolved).toEqual({ file: join(DIR, 'index.html'), pathname: '/index.html' });
  });

  it('As a page, I load an asset that exists and get the file under its own path', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const disk = build('index.html', 'assets/index-A.js');

    // When
    const resolved = resolveFile(DIR, serving.routeFor('browse.localhost', '/'), '/assets/index-A.js', disk.isFile);

    // Then
    expect(resolved).toEqual({ file: join(DIR, 'assets/index-A.js'), pathname: '/assets/index-A.js' });
  });

  it('As a page after a deploy, I ask for an asset, a worker or the version file that is gone and get a 404, not the shell', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const disk = build('index.html');

    // When
    const answers = ['/assets/gone.js', '/host-sw.js', '/host_version.json'].map(path =>
      resolveFile(DIR, serving.routeFor('browse.localhost', '/'), path, disk.isFile),
    );

    // Then
    expect(answers).toEqual([undefined, undefined, undefined]);
  });

  it('As an attacker, I ask for a path that climbs out of the build and am answered from inside it', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const disk = build('index.html');

    // When
    const answers = ['/..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/a%00b', '..', '../x'].map(path =>
      resolveFile(DIR, serving.routeFor('browse.localhost', '/'), path, disk.isFile),
    );

    // Then
    expect(answers.every(answer => answer?.file === join(DIR, 'index.html'))).toBe(true);
    expect(disk.asked.every(path => path.startsWith(`${DIR}${sep}`))).toBe(true);
  });

  it('As a visitor, I send a malformed escape and get a 404', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const disk = build('index.html');

    // When
    const resolved = resolveFile(DIR, serving.routeFor('browse.localhost', '/'), '/%E0%A4%A', disk.isFile);

    // Then
    expect(resolved).toBeUndefined();
  });

  it('As a visitor, I open a folder on the bare host and get its index', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const disk = build('landing.html', 'index.html', 'docs/index.html');

    // When the folder is resolved on the bare host
    const resolved = resolveFile(DIR, serving.routeFor('localhost', '/'), '/docs/', disk.isFile);

    // Then the folder's index answers
    expect(resolved).toEqual({ file: join(DIR, 'docs/index.html'), pathname: '/docs/' });
  });

  it('As a user, I open /__session on the bare host and get the session page', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const disk = build('landing.html', 'index.html', 'session.html');

    // When the session path is resolved on the bare host
    const resolved = resolveFile(DIR, serving.routeFor('localhost', '/__session'), '/__session', disk.isFile);

    // Then the session page is served
    expect(resolved).toEqual({ file: join(DIR, 'session.html'), pathname: '/__session' });
  });

  it('As a user on a build without the session page, I open the sign-in window and get a 404, not the shell', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const disk = build('landing.html', 'index.html');

    // When the session path is resolved on the bare host
    const resolved = resolveFile(DIR, serving.routeFor('localhost', '/__session'), '/__session', disk.isFile);

    // Then no file is served
    expect(resolved).toBeUndefined();
  });

  it('As a page framing the sign-in window, I ask for its built file and get a 404 on any host', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);
    const disk = build('landing.html', 'index.html', 'session.html');

    // When the built session file is asked for on each host and spelling
    const answers = [
      ['localhost', '/session.html'],
      ['browse.localhost', '/session.html'],
      ['localhost', '//session.html'],
      ['localhost', '/./session.html'],
      ['localhost', '/%73ession.html'],
    ].map(([host = '', path = '']) => resolveFile(DIR, serving.routeFor(host, path), path, disk.isFile));

    // Then no file is served for any of them
    expect(answers).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe('the table against nginx', () => {
  it('As an operator, I run a Node server and a shell page carries the headers nginx sends', () => {
    // Given the headers nginx sends with a shell page
    const nginx = nginxHeaders('nginx/snippets/dotli-headers-host.conf');

    // When
    const headers = policyHeaders('plain', NGINX_ANCESTORS);

    // Then they match nginx
    expect(headers).toEqual(nginx);
  });

  it('As an operator, I run a Node server and the sign-in window carries the headers nginx sends', () => {
    // Given the headers nginx sends with the sign-in window
    const nginx = nginxHeaders('nginx/snippets/dotli-session-page.conf');

    // When the Node server's unframed headers are built
    const headers = policyHeaders('unframed', NGINX_ANCESTORS);

    // Then
    expect(headers).toEqual(nginx);
  });

  it('As an operator, I run a Node server and a sandbox page carries the isolation headers nginx sends', () => {
    // Given the headers nginx sends with a sandbox page
    const nginx = nginxHeaders('nginx/snippets/dotli-headers-iframeable.conf');

    // When
    const headers = policyHeaders('isolated', NGINX_ANCESTORS);

    // Then
    expect(headers).toEqual(nginx);
  });

  it('As an operator, I run a Node server and host and sandbox assets carry the headers nginx sends', () => {
    // Given the headers nginx sends with host, preview and sandbox assets
    const nginx = [
      nginxHeaders('nginx/snippets/dotli-assets-host.conf'),
      nginxHeaders('nginx/snippets/dotli-assets-preview.conf'),
      nginxHeaders('nginx/snippets/dotli-assets-iframeable.conf'),
    ];

    // When
    const headers = [
      { ...policyHeaders('plain', NGINX_ANCESTORS), ...fileHeaders('/assets/a.js') },
      { ...policyHeaders('worker-coep', NGINX_ANCESTORS), ...fileHeaders('/assets/a.js') },
      { ...policyHeaders('isolated', NGINX_ANCESTORS), ...fileHeaders('/assets/a.js') },
    ];

    // Then
    expect(headers).toEqual(nginx);
  });

  it('As an operator, I run a Node server and each service worker carries the headers nginx sends', () => {
    // Given the headers nginx sends with each service worker
    const nginx = [nginxHeaders('nginx/snippets/dotli-sw-app.conf'), nginxHeaders('nginx/snippets/dotli-sw-host.conf')];

    // When
    const headers = [
      { ...policyHeaders('isolated', NGINX_ANCESTORS), ...fileHeaders('/app-sw.js') },
      { ...policyHeaders('plain', NGINX_ANCESTORS), ...fileHeaders('/host-sw.js') },
    ];

    // Then
    expect(headers).toEqual(nginx);
  });
});

describe('devHeaders', () => {
  it('As a developer, I open the sign-in window on the dev server and no page may frame it', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When the dev server's headers for the session path are built
    const headers = serving.devHeaders('localhost', '/__session');

    // Then no page may frame it
    expect(headers).toEqual({ 'Content-Security-Policy': "frame-ancestors 'none'" });
  });

  it('As a developer, I open /__preview and a shell page on the dev server, and only the preview is isolated', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When the dev server's headers for the preview and a shell page are built
    const preview = serving.devHeaders('localhost', '/__preview');
    const shell = serving.devHeaders('browse.localhost', '/');

    // Then only the preview carries the isolation headers
    expect(preview).toEqual(serving.securityHeaders('isolated'));
    expect(shell).toEqual({});
  });

  it('As a developer, I open a sandbox and a page under either local root on any port and scheme may frame it', () => {
    // Given a server for both local roots
    const serving = createLocalServing(ROOTS);

    // When the dev server's headers for a local.host sandbox are built
    const headers = serving.devHeaders('myapp.app.local.host', '/');

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
