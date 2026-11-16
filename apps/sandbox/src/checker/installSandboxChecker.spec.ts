// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { installSandboxChecker, type CheckedPage } from './installSandboxChecker.js';

type Violation = {
  api: string;
  details: Record<string, unknown> | undefined;
};

class FakeDocument {
  cookies = '';
  created: string[] = [];
  get cookie(): string {
    return this.cookies;
  }
  set cookie(value: string) {
    this.cookies = value;
  }
  createElement(tagName: string): { tagName: string } {
    this.created.push(tagName);
    return { tagName };
  }
}

class FakeXhr {
  opened: unknown[][] = [];
  open(...args: unknown[]): void {
    this.opened.push(args);
  }
}

class FakeWebSocket {
  static readonly OPEN = 1;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
}

/** A product page on https://app.example with the APIs the checker wraps, and the violations it reported. */
function createProductPage({
  globals = {},
  lockedGlobals = {},
  storageDenied = false,
}: {
  globals?: Record<string, unknown>;
  /** Globals an extension defined as non-configurable before the checker ran. */
  lockedGlobals?: Record<string, unknown>;
  /** The browser blocks this origin's storage, so reading either storage throws. */
  storageDenied?: boolean;
} = {}) {
  const fetched: unknown[] = [];
  const timers: (() => void)[] = [];
  const page = {
    location: { href: 'https://app.example/', origin: 'https://app.example' },
    Request,
    fetch(input: unknown) {
      fetched.push(input);
      return Promise.resolve(new Response());
    },
    XMLHttpRequest: FakeXhr,
    navigator: {},
    document: new FakeDocument(),
    Document: FakeDocument,
    HTMLDocument: FakeDocument,
    localStorage: null,
    sessionStorage: null,
    setTimeout(run: () => void) {
      timers.push(run);
      return 0;
    },
    ...globals,
  };
  for (const [name, value] of Object.entries(lockedGlobals)) {
    Object.defineProperty(page, name, { value, writable: true, configurable: false });
  }
  if (storageDenied) {
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(page, name, {
        get: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    }
  }
  const violations: Violation[] = [];
  // The checker wraps a whole page, and the fake carries only the globals it reaches.
  installSandboxChecker(page as unknown as CheckedPage, (api, { details } = {}) => {
    violations.push({ api, details });
  });
  return {
    // The same fake, typed as the page the product sees.
    page: page as unknown as CheckedPage & { document: FakeDocument },
    // The wallet globals are no members of the page's type, so the product reaches them by name.
    wallets: page as unknown as Record<string, unknown>,
    fetched,
    violations,
    elapse: () => {
      for (const run of timers.splice(0)) {
        run();
      }
    },
  };
}

describe('the sandbox checker', () => {
  it('As a product developer, I fetch from another origin and from my own and only the first is reported, while both go out', async () => {
    // Given
    const { page, fetched, violations } = createProductPage();

    // When
    await page.fetch('https://tracker.example/pixel', { method: 'POST' });
    await page.fetch('/api/self');

    // Then
    expect(fetched).toEqual(['https://tracker.example/pixel', '/api/self']);
    expect(violations).toEqual([{ api: 'fetch', details: { url: 'https://tracker.example/pixel', method: 'POST' } }]);
  });

  it('As a product developer, I create an iframe and write a cookie and both are reported', () => {
    // Given
    const { page, violations } = createProductPage();

    // When
    page.document.createElement('IFRAME');
    page.document.cookie = 'a=1';

    // Then both still happened
    expect(page.document.created).toEqual(['IFRAME']);
    expect(page.document.cookies).toBe('a=1');
    expect(violations.map(v => v.api)).toEqual(['createElement(iframe)', 'Direct storage access (cookie)']);
  });

  it('As a product developer, I open a cross-origin request with a method the page cannot post, and it is reported as text', () => {
    // Given
    const { page, violations } = createProductPage();
    const request = new page.XMLHttpRequest();

    // When the method is a function, which a page message cannot carry
    // The product may pass anything, which the DOM types refuse.
    Reflect.apply(request.open.bind(request), request, [() => 'GET', 'https://tracker.example/pixel']);

    // Then
    expect(violations.map(v => typeof v.details?.['method'])).toEqual(['string']);
  });

  it('As a product developer, I open a socket to another origin and it is reported while it stays a WebSocket', () => {
    // Given a page with WebSocket
    const { page, violations } = createProductPage({ globals: { WebSocket: FakeWebSocket } });

    // When
    const socket = new page.WebSocket('wss://relay.example');

    // Then
    expect(violations).toEqual([{ api: 'WebSocket', details: { url: 'wss://relay.example' } }]);
    expect(socket).toBeInstanceOf(page.WebSocket);
    expect(page.WebSocket.OPEN).toBe(1);
  });

  it('As a product developer whose browser blocks storage, I write a cookie and it is still reported', () => {
    // Given a page whose storage the browser blocks
    const { page, violations } = createProductPage({ storageDenied: true });

    // When
    page.document.cookie = 'a=1';

    // Then
    expect(violations.map(v => v.api)).toEqual(['Direct storage access (cookie)']);
  });

  it('As a product developer, I use a wallet extension once it registered and only my use is reported, not its registration', () => {
    // Given an extension that registers while the page loads, and reads it back
    const { wallets: globals, violations, elapse } = createProductPage();
    globals['injectedWeb3'] = { wallet: {} };
    const readWhileLoading = globals['injectedWeb3'];
    const reportedWhileLoading = [...violations];

    // When the product reads it once the page settled, and writes it
    elapse();
    const read = globals['injectedWeb3'];
    globals['injectedWeb3'] = {};

    // Then
    expect(readWhileLoading).toEqual({ wallet: {} });
    expect(reportedWhileLoading).toEqual([]);
    expect(read).toEqual({ wallet: {} });
    expect(violations).toEqual([
      { api: 'Direct wallet access (injectedWeb3)', details: { action: 'read' } },
      { api: 'Direct wallet access (injectedWeb3)', details: { action: 'write' } },
    ]);
  });

  it('As a product developer, I open a page where two extensions register into injectedWeb3 and neither registration is reported', () => {
    // Given a page whose first extension registered into a fresh injectedWeb3
    const { wallets: globals, violations } = createProductPage();
    const register = (name: string): void => {
      globals['injectedWeb3'] = globals['injectedWeb3'] ?? {};
      (globals['injectedWeb3'] as Record<string, unknown>)[name] = { enable: true };
    };
    register('polkadot-js');

    // When a second extension registers into the same injectedWeb3
    register('talisman');

    // Then
    expect(violations).toEqual([]);
  });

  it('As a product developer, I overwrite a wallet global an extension set before the checker ran and my write is reported', () => {
    // Given a page whose ethereum an extension set before the checker installed
    const {
      wallets: pageGlobals,
      violations,
      elapse,
    } = createProductPage({ globals: { ethereum: { extension: true } } });

    // When the page settles and the product writes ethereum
    elapse();
    pageGlobals['ethereum'] = {};

    // Then only the write is reported
    expect(violations).toEqual([{ api: 'Direct wallet access (ethereum)', details: { action: 'write' } }]);
  });

  it('As a product developer, I open a page where an extension locked one wallet global and the other wallet globals are still trapped', () => {
    // Given a page whose injectedWeb3 an extension defined as non-configurable before the checker installed
    const {
      wallets: pageGlobals,
      violations,
      elapse,
    } = createProductPage({
      lockedGlobals: { injectedWeb3: { extension: true } },
    });
    pageGlobals['ethereum'] = { extension: true };

    // When the page settles and the product writes ethereum
    elapse();
    pageGlobals['ethereum'] = {};

    // Then the write is reported
    expect(violations).toEqual([{ api: 'Direct wallet access (ethereum)', details: { action: 'write' } }]);
  });
});
