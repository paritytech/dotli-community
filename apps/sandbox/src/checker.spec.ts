// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { installSandboxChecker, type CheckedPage } from './checker.js';

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

/** A product page on https://app.example with the APIs the checker wraps, and the violations it reported. */
function productPage() {
  const fetched: unknown[] = [];
  const timers: (() => void)[] = [];
  const page = {
    location: { href: 'https://app.example/', origin: 'https://app.example' },
    Request,
    fetch: (input: unknown) => {
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
    setTimeout: (run: () => void) => {
      timers.push(run);
      return 0;
    },
  };
  const violations: Violation[] = [];
  installSandboxChecker(page as unknown as CheckedPage, (api, details) => {
    violations.push({ api, details });
  });
  return {
    page: page as unknown as CheckedPage & { document: FakeDocument },
    fetched,
    violations,
    elapse: () => {
      timers.splice(0).forEach(run => {
        run();
      });
    },
  };
}

describe('the sandbox checker', () => {
  it('As a product developer, a fetch to another origin is reported and still goes out, a same-origin one is not', async () => {
    // Given
    const { page, fetched, violations } = productPage();

    // When
    await page.fetch('https://tracker.example/pixel', { method: 'POST' });
    await page.fetch('/api/self');

    // Then
    expect(fetched).toEqual(['https://tracker.example/pixel', '/api/self']);
    expect(violations).toEqual([{ api: 'fetch', details: { url: 'https://tracker.example/pixel', method: 'POST' } }]);
  });

  it('As a product developer, creating an iframe and writing a cookie are reported', () => {
    // Given
    const { page, violations } = productPage();

    // When
    page.document.createElement('IFRAME');
    page.document.cookie = 'a=1';

    // Then both still happened
    expect(page.document.created).toEqual(['IFRAME']);
    expect(page.document.cookies).toBe('a=1');
    expect(violations.map(v => v.api)).toEqual(['createElement(iframe)', 'Direct storage access (cookie)']);
  });

  it("As a product developer, a wallet extension's own registration is not reported, my later use of it is", () => {
    // Given an extension that registers while the page loads
    const { page, violations, elapse } = productPage();
    const globals = page as unknown as Record<string, unknown>;
    globals['injectedWeb3'] = { wallet: {} };
    expect(globals['injectedWeb3']).toEqual({ wallet: {} });
    expect(violations).toEqual([]);

    // When the product reads it once the page settled, and writes it
    elapse();
    const read = globals['injectedWeb3'];
    globals['injectedWeb3'] = {};

    // Then
    expect(read).toEqual({ wallet: {} });
    expect(violations).toEqual([
      { api: 'Direct wallet access (injectedWeb3)', details: { action: 'read' } },
      { api: 'Direct wallet access (injectedWeb3)', details: { action: 'write' } },
    ]);
  });
});
