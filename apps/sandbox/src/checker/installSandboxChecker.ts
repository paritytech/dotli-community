// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Runs first in a product page of a checker build. It reports each use of an API a product should reach only through
// the host, and lets the call run. The product's HTML inlines it bundled with what it imports.

import type { ReportViolation } from './createParentReporter.js';
import { trapWallets } from './trapWallets.js';

/** The product page, as much of it as the checker wraps. */
export type CheckedPage = Window & typeof globalThis;

type AnyConstructor = new (...args: unknown[]) => unknown;

/** The constructors the checker reports, whether a report names the URL in their first argument, and their statics. */
const WATCHED_CONSTRUCTORS: readonly { name: string; reportsUrl: boolean; constants: readonly string[] }[] = [
  { name: 'WebSocket', reportsUrl: true, constants: ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] },
  { name: 'RTCPeerConnection', reportsUrl: false, constants: [] },
  { name: 'EventSource', reportsUrl: true, constants: ['CONNECTING', 'OPEN', 'CLOSED'] },
  { name: 'Worker', reportsUrl: true, constants: [] },
  { name: 'SharedWorker', reportsUrl: true, constants: [] },
];

/** Wraps every API the checker watches on `page`, each reporting to `report` and then running. Never throws. */
export function installSandboxChecker(page: CheckedPage, report: ReportViolation): void {
  wrapFetch(page, report);
  wrapXhr(page, report);
  wrapConstructors(page, report);
  wrapNavigator(page, report);
  wrapCreateElement(page, report);
  wrapStorage(page, 'localStorage', report);
  wrapStorage(page, 'sessionStorage', report);
  wrapIndexedDb(page, report);
  wrapCaches(page, report);
  wrapCookie(page, report);
  trapWallets(page, report);
}

/** The page's globals by name, for the ones a browser may lack. */
function getGlobals(page: CheckedPage): Record<string, unknown> {
  return page as unknown as Record<string, unknown>;
}

function wrapFetch(page: CheckedPage, report: ReportViolation): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the caller's own `this`, as the page's fetch would be.
  const original = page.fetch;
  page.fetch = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    const [input, init] = args;
    try {
      const url = new URL(getRequestUrl(page, input), page.location.href);
      if (url.origin !== page.location.origin) {
        report('fetch', { details: { url: url.href, method: init?.method ?? 'GET' } });
      }
    } catch {
      // An input no URL parses is still a fetch to report, and the call itself still runs.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- fetch stringifies any other input the same way.
      report('fetch', { details: { url: String(input) } });
    }
    return original.apply(this, args);
  };
}

/** The URL a fetch input names. */
function getRequestUrl(page: CheckedPage, input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof page.Request) {
    return input.url;
  }
  return String(input);
}

function wrapXhr(page: CheckedPage, report: ReportViolation): void {
  const prototype = page.XMLHttpRequest.prototype;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called on the request the product opens, as the original open would be.
  const original = prototype.open;
  prototype.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
    const [method, rawUrl] = args;
    try {
      const url = new URL(String(rawUrl), page.location.href);
      if (url.origin !== page.location.origin) {
        report('XMLHttpRequest', { details: { url: url.href, method: String(method) } });
      }
    } catch {
      // An input no URL parses is still a request to report, and the call itself still runs.
      report('XMLHttpRequest', { details: { url: String(rawUrl), method: String(method) } });
    }
    Reflect.apply(original, this, args);
  };
}

/**
 * Replaces each watched global constructor with one that reports, then constructs the original. `instanceof` and the
 * listed static constants keep working.
 */
function wrapConstructors(page: CheckedPage, report: ReportViolation): void {
  const globals = getGlobals(page);
  for (const { name, reportsUrl, constants } of WATCHED_CONSTRUCTORS) {
    // A global the page has under `name` is that constructor.
    const original = globals[name] as AnyConstructor | undefined;
    if (original === undefined) {
      continue;
    }
    // A plain function that constructs, so `new` on it works as on the original.
    const wrapper = function (...args: unknown[]): unknown {
      report(name, reportsUrl ? { details: { url: String(args[0]) } } : {});
      return new original(...args);
    } as unknown as AnyConstructor & Record<string, unknown>;
    // Every function and constructor has a prototype, which its type does not let a write reach.
    (wrapper as { prototype: unknown }).prototype = (original as { prototype: unknown }).prototype;
    Object.defineProperty(wrapper.prototype, 'constructor', { value: wrapper });
    // The static constants are read by name.
    const statics = original as unknown as Record<string, unknown>;
    for (const constant of constants) {
      wrapper[constant] = statics[constant];
    }
    globals[name] = wrapper;
  }
}

function wrapNavigator(page: CheckedPage, report: ReportViolation): void {
  const { navigator } = page;
  // A browser may lack either, whatever the DOM types say.
  const optional = navigator as Partial<Pick<Navigator, 'sendBeacon' | 'serviceWorker'>>;
  if (optional.sendBeacon) {
    const sendBeacon = optional.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      report('sendBeacon', { details: { url: String(url) } });
      return sendBeacon(url, data);
    };
  }
  // A browser may lack `register` too.
  const container = optional.serviceWorker as Partial<ServiceWorkerContainer> | undefined;
  if (container?.register) {
    const register = container.register.bind(container);
    container.register = (scriptURL, options) => {
      report('ServiceWorker.register', { details: { url: String(scriptURL) } });
      return register(scriptURL, options);
    };
  }
}

function wrapCreateElement(page: CheckedPage, report: ReportViolation): void {
  const { document } = page;
  // Through Reflect, since the DOM types mark the string overload deprecated.
  const createElement = Reflect.get(document, 'createElement') as (this: Document, ...args: unknown[]) => unknown;
  Reflect.set(document, 'createElement', (...args: unknown[]): unknown => {
    const element = createElement.apply(document, args);
    const [tagName] = args;
    if (typeof tagName === 'string' && tagName.toLowerCase() === 'iframe') {
      report('createElement(iframe)');
    }
    return element;
  });
}

function wrapStorage(page: CheckedPage, name: 'localStorage' | 'sessionStorage', report: ReportViolation): void {
  // A browser with storage turned off has none, whatever the DOM types say.
  const optional = page as Partial<Record<typeof name, Storage | null>>;
  let storage: Storage | null | undefined;
  try {
    storage = optional[name];
  } catch {
    // A browser that blocks the origin's storage throws on the read. The product's own reads throw the same, so there
    // is nothing to wrap.
    return;
  }
  if (!storage) {
    return;
  }
  const api = `Direct storage access (${name})`;
  const getItem = storage.getItem.bind(storage);
  const setItem = storage.setItem.bind(storage);
  const removeItem = storage.removeItem.bind(storage);
  const clear = storage.clear.bind(storage);
  // The product may pass anything, so the keys are read as unknown and passed on as the original would take them.
  storage.getItem = (key: unknown) => {
    report(api, { details: { method: 'getItem', key: String(key) } });
    return getItem(key as string);
  };
  storage.setItem = (key: unknown, value: string) => {
    report(api, { details: { method: 'setItem', key: String(key) } });
    setItem(key as string, value);
  };
  storage.removeItem = (key: unknown) => {
    report(api, { details: { method: 'removeItem', key: String(key) } });
    removeItem(key as string);
  };
  storage.clear = () => {
    report(api, { details: { method: 'clear' } });
    clear();
  };
}

function wrapIndexedDb(page: CheckedPage, report: ReportViolation): void {
  // A browser may lack it, whatever the DOM types say, and the product may pass any name.
  const factory = page.indexedDB as Partial<IDBFactory> | null | undefined;
  if (!factory?.open) {
    return;
  }
  const open = factory.open.bind(factory);
  factory.open = (name: unknown, version?: number) => {
    report('Direct storage access (IndexedDB)', { details: { method: 'open', name: String(name) } });
    return open(name as string, version);
  };
}

function wrapCaches(page: CheckedPage, report: ReportViolation): void {
  // A browser may lack it, whatever the DOM types say, and the product may pass any name.
  const caches = page.caches as CacheStorage | undefined;
  if (!caches) {
    return;
  }
  const api = 'Direct storage access (CacheStorage)';
  const open = caches.open.bind(caches);
  const remove = caches.delete.bind(caches);
  const has = caches.has.bind(caches);
  caches.open = (name: unknown) => {
    report(api, { details: { method: 'open', name: String(name) } });
    return open(name as string);
  };
  caches.delete = (name: unknown) => {
    report(api, { details: { method: 'delete', name: String(name) } });
    return remove(name as string);
  };
  caches.has = (name: unknown) => {
    report(api, { details: { method: 'has', name: String(name) } });
    return has(name as string);
  };
}

function wrapCookie(page: CheckedPage, report: ReportViolation): void {
  const api = 'Direct storage access (cookie)';
  const cookie = Object.getOwnPropertyDescriptor(page.Document.prototype, 'cookie');
  if (!cookie?.get || !cookie.set) {
    return;
  }
  // eslint-disable-next-line @typescript-eslint/unbound-method -- an accessor pair, called on the document below.
  const { get, set } = cookie;
  const { document } = page;
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    enumerable: true,
    get: () => {
      report(api, { details: { action: 'read' } });
      // The getter's value, whatever the page set.
      return get.call(document) as unknown;
    },
    set: (value: unknown) => {
      report(api, { details: { action: 'write' } });
      set.call(document, value);
    },
  });
}
