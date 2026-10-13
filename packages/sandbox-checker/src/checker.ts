// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Runs first in a product page of a checker build. It reports each use of an API a product should reach only through
// the host, and lets the call run. The product's HTML inlines it bundled, so it imports nothing.

/** The product page, as much of it as the checker wraps. */
export type CheckedPage = Window & typeof globalThis;

export type ReportViolation = (api: string, details?: Record<string, unknown>) => void;

// Wallet extensions write their globals while they bootstrap, so reads count only after this long.
const WALLET_READY_MS = 3000;
const WALLET_GLOBALS = ['injectedWeb3', 'polkadot', 'ethereum'] as const;

/** Posts each violation to the host page, which lists it. */
export function reportToParent(page: Pick<Window, 'parent'>): ReportViolation {
  return (api, details) => {
    try {
      page.parent.postMessage({ type: 'DOTLI_API_VIOLATION', api, details: details ?? {}, timestamp: Date.now() }, '*');
      // eslint-disable-next-line no-restricted-syntax -- a product page has no reporter of its own, and a failed report must not fail the product's call.
    } catch {
      // Not reported.
    }
  };
}

type AnyConstructor = new (...args: unknown[]) => unknown;

/** The page's globals by name, for the ones a browser may lack. */
function globalsOf(page: CheckedPage): Record<string, unknown> {
  return page as unknown as Record<string, unknown>;
}

/**
 * Replaces the global constructor `name` with one that reports, then constructs `original`. `instanceof` and the
 * listed static constants keep working.
 */
function wrapConstructor(
  page: CheckedPage,
  name: string,
  original: AnyConstructor,
  report: (args: unknown[]) => void,
  constants: readonly string[] = [],
): void {
  const wrapper = function (...args: unknown[]): unknown {
    report(args);
    return new original(...args);
  } as unknown as AnyConstructor & Record<string, unknown>;
  (wrapper as { prototype: unknown }).prototype = (original as { prototype: unknown }).prototype;
  Object.defineProperty(wrapper.prototype, 'constructor', { value: wrapper });
  const statics = original as unknown as Record<string, unknown>;
  for (const constant of constants) {
    wrapper[constant] = statics[constant];
  }
  globalsOf(page)[name] = wrapper;
}

function wrapFetch(page: CheckedPage, report: ReportViolation): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the caller's own `this`, as the page's fetch would be.
  const original = page.fetch;
  page.fetch = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    const [input, init] = args;
    try {
      const raw = typeof input === 'string' ? input : input instanceof page.Request ? input.url : String(input);
      const url = new URL(raw, page.location.href);
      if (url.origin !== page.location.origin) {
        report('fetch', { url: url.href, method: init?.method ?? 'GET' });
      }
    } catch {
      // An input no URL parses is still a fetch to report, and the call itself still runs.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- fetch stringifies any other input the same way.
      report('fetch', { url: String(input) });
    }
    return original.apply(this, args);
  };
}

function wrapXhr(page: CheckedPage, report: ReportViolation): void {
  const proto = page.XMLHttpRequest.prototype;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called on the request the product opens, as the original open would be.
  const original = proto.open;
  proto.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
    const [method, rawUrl] = args;
    try {
      const url = new URL(String(rawUrl), page.location.href);
      if (url.origin !== page.location.origin) {
        report('XMLHttpRequest', { url: url.href, method });
      }
    } catch {
      // An input no URL parses is still a request to report, and the call itself still runs.
      report('XMLHttpRequest', { url: String(rawUrl), method });
    }
    Reflect.apply(original, this, args);
  };
}

function wrapConstructors(page: CheckedPage, report: ReportViolation): void {
  const globals = globalsOf(page);
  const urlOf = (args: unknown[]): Record<string, unknown> => ({ url: String(args[0]) });
  const constructorOf = (name: string): AnyConstructor | undefined => globals[name] as AnyConstructor | undefined;

  const webSocket = constructorOf('WebSocket');
  if (webSocket) {
    wrapConstructor(
      page,
      'WebSocket',
      webSocket,
      args => {
        report('WebSocket', urlOf(args));
      },
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'],
    );
  }
  const rtc = constructorOf('RTCPeerConnection') ?? constructorOf('webkitRTCPeerConnection');
  if (rtc) {
    wrapConstructor(page, 'RTCPeerConnection', rtc, () => {
      report('RTCPeerConnection', {});
    });
  }
  const eventSource = constructorOf('EventSource');
  if (eventSource) {
    wrapConstructor(
      page,
      'EventSource',
      eventSource,
      args => {
        report('EventSource', urlOf(args));
      },
      ['CONNECTING', 'OPEN', 'CLOSED'],
    );
  }
  for (const name of ['Worker', 'SharedWorker']) {
    const worker = constructorOf(name);
    if (worker) {
      wrapConstructor(page, name, worker, args => {
        report(name, urlOf(args));
      });
    }
  }
}

function wrapNavigator(page: CheckedPage, report: ReportViolation): void {
  const { navigator } = page;
  // A browser may lack either, whatever the DOM types say.
  const optional = navigator as Partial<Pick<Navigator, 'sendBeacon' | 'serviceWorker'>>;
  if (optional.sendBeacon) {
    const sendBeacon = optional.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      report('sendBeacon', { url: String(url) });
      return sendBeacon(url, data);
    };
  }
  const container = optional.serviceWorker as Partial<ServiceWorkerContainer> | undefined;
  if (container?.register) {
    const register = container.register.bind(container);
    container.register = (scriptURL, options) => {
      report('ServiceWorker.register', { url: String(scriptURL) });
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
      report('createElement(iframe)', {});
    }
    return element;
  });
}

function wrapStorage(storage: Storage | null | undefined, label: string, report: ReportViolation): void {
  if (!storage) {
    return;
  }
  const api = `Direct storage access (${label})`;
  const getItem = storage.getItem.bind(storage);
  const setItem = storage.setItem.bind(storage);
  const removeItem = storage.removeItem.bind(storage);
  const clear = storage.clear.bind(storage);
  // The product may pass anything, so the keys are read as unknown.
  storage.getItem = (key: unknown) => {
    report(api, { method: 'getItem', key: String(key) });
    return getItem(key as string);
  };
  storage.setItem = (key: unknown, value: string) => {
    report(api, { method: 'setItem', key: String(key) });
    setItem(key as string, value);
  };
  storage.removeItem = (key: unknown) => {
    report(api, { method: 'removeItem', key: String(key) });
    removeItem(key as string);
  };
  storage.clear = () => {
    report(api, { method: 'clear' });
    clear();
  };
}

function wrapIndexedDb(page: CheckedPage, report: ReportViolation): void {
  const factory = page.indexedDB as Partial<IDBFactory> | null | undefined;
  if (!factory?.open) {
    return;
  }
  const open = factory.open.bind(factory);
  factory.open = (name: unknown, version?: number) => {
    report('Direct storage access (IndexedDB)', { method: 'open', name: String(name) });
    return open(name as string, version);
  };
}

function wrapCaches(page: CheckedPage, report: ReportViolation): void {
  const caches = page.caches as CacheStorage | undefined;
  if (!caches) {
    return;
  }
  const api = 'Direct storage access (CacheStorage)';
  const open = caches.open.bind(caches);
  const remove = caches.delete.bind(caches);
  const has = caches.has.bind(caches);
  caches.open = (name: unknown) => {
    report(api, { method: 'open', name: String(name) });
    return open(name as string);
  };
  caches.delete = (name: unknown) => {
    report(api, { method: 'delete', name: String(name) });
    return remove(name as string);
  };
  caches.has = (name: unknown) => {
    report(api, { method: 'has', name: String(name) });
    return has(name as string);
  };
}

function wrapCookie(page: CheckedPage, report: ReportViolation): void {
  const api = 'Direct storage access (cookie)';
  const cookie =
    Object.getOwnPropertyDescriptor(page.Document.prototype, 'cookie') ??
    Object.getOwnPropertyDescriptor(page.HTMLDocument.prototype, 'cookie');
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
      report(api, { action: 'read' });
      return get.call(document) as unknown;
    },
    set: (value: unknown) => {
      report(api, { action: 'write' });
      set.call(document, value);
    },
  });
}

/** Extensions write a wallet global once to register, so only later writes, and reads once they settle, count. */
function trapWallets(page: CheckedPage, report: ReportViolation): void {
  let ready = false;
  page.setTimeout(() => {
    ready = true;
  }, WALLET_READY_MS);
  const globals = globalsOf(page);
  for (const name of WALLET_GLOBALS) {
    let value = globals[name];
    let firstWrite = true;
    Object.defineProperty(page, name, {
      configurable: true,
      enumerable: true,
      get: () => {
        if (value !== undefined && ready) {
          report(`Direct wallet access (${name})`, { action: 'read' });
        }
        return value;
      },
      set: (next: unknown) => {
        if (firstWrite) {
          firstWrite = false;
        } else {
          report(`Direct wallet access (${name})`, { action: 'write' });
        }
        value = next;
      },
    });
  }
}

/** Wraps every API the checker watches on `page`, each reporting to `report` and then running. */
export function installSandboxChecker(page: CheckedPage, report: ReportViolation): void {
  wrapFetch(page, report);
  wrapXhr(page, report);
  wrapConstructors(page, report);
  wrapNavigator(page, report);
  wrapCreateElement(page, report);
  wrapStorage(page.localStorage, 'localStorage', report);
  wrapStorage(page.sessionStorage, 'sessionStorage', report);
  wrapIndexedDb(page, report);
  wrapCaches(page, report);
  wrapCookie(page, report);
  trapWallets(page, report);
}
