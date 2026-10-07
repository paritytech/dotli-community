// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the archive the page hands it. The iframe is credentialless, so this origin's storage lasts only as long as
// the host page, and the host keeps the content blocks instead.

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

// The page reads it through `GET_SW_VERSION` to detect a stale worker.
declare const __SW_VERSION__: string;

import { getMimeType } from '@dotli/shared';

const BASE = self.location.pathname.replace(/(?:src\/)?app-sw\.[jt]s$/, '');
const DOTLI_APP_PREFIX = `${BASE}dotli-app/`;

function hasExtension(path: string): boolean {
  const lastSlash = path.lastIndexOf('/');
  const lastDot = path.lastIndexOf('.');
  return lastDot > lastSlash;
}

// The browser stops an idle worker after about 30s, so the archive is also kept in IndexedDB and read back on the
// first fetch after a restart.

type ArchiveIndex = { p: string; o: number; l: number }[];

interface PersistedArchive {
  packed: ArrayBuffer;
  index: ArchiveIndex;
}

const ARCHIVE_DB_NAME = 'dotli-app-sw';
const ARCHIVE_STORE = 'archive';
const CURRENT_ARCHIVE_KEY = 'current';

let servedFiles: Record<string, ArrayBuffer> | null = null;

/** Started by the first fetch that finds no archive in memory. */
let restoring: Promise<void> | null = null;

/** The read-back found nothing, so the page has not sent an archive yet. */
let nothingPersisted = false;

function unpackArchive(packed: ArrayBuffer, index: ArchiveIndex): Record<string, ArrayBuffer> {
  const files: Record<string, ArrayBuffer> = {};
  for (const entry of index) {
    files[entry.p] = packed.slice(entry.o, entry.o + entry.l);
  }
  return files;
}

function openArchiveDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ARCHIVE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(ARCHIVE_STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('Failed to open the archive database'));
    };
  });
}

async function persistArchive(archive: PersistedArchive): Promise<void> {
  const db = await openArchiveDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ARCHIVE_STORE, 'readwrite');
      tx.objectStore(ARCHIVE_STORE).put(archive, CURRENT_ARCHIVE_KEY);
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('Failed to persist the archive'));
      };
    });
  } finally {
    db.close();
  }
}

async function loadPersistedArchive(): Promise<PersistedArchive | null> {
  const db = await openArchiveDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(ARCHIVE_STORE, 'readonly').objectStore(ARCHIVE_STORE).get(CURRENT_ARCHIVE_KEY);
      request.onsuccess = () => {
        resolve((request.result as PersistedArchive | undefined) ?? null);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('Failed to read the archive'));
      };
    });
  } finally {
    db.close();
  }
}

/** The worker has no error reporting, and a failed write otherwise shows only when a restart has nothing to serve. */
function reportArchiveFailure(clients: readonly Client[], stage: 'persist' | 'restore', err: unknown): void {
  const message = {
    type: 'ARCHIVE_FAILURE',
    stage,
    name: err instanceof Error ? err.name : 'NonErrorThrow',
    message: err instanceof Error ? err.message : String(err),
  } as const;
  for (const client of clients) {
    client.postMessage(message);
  }
}

function restoreArchive(): Promise<void> {
  restoring ??= loadPersistedArchive().then(
    archive => {
      if (archive === null) {
        nothingPersisted = true;
        return;
      }
      // A SET_ARCHIVE that landed while the read was in flight is newer.
      servedFiles ??= unpackArchive(archive.packed, archive.index);
    },
    (err: unknown) => {
      console.error('Failed to restore the archive after a worker restart:', err);
      nothingPersisted = true;
      // Not awaited: the fetch waiting on this read-back must not wait on the report too.
      void self.clients.matchAll({ type: 'window' }).then(
        clients => {
          reportArchiveFailure(clients, 'restore', err);
        },
        () => undefined,
      );
    },
  );
  return restoring;
}

function hasArchive(): boolean {
  return servedFiles !== null;
}

function getFile(path: string): ArrayBuffer | undefined {
  return servedFiles !== null && Object.hasOwn(servedFiles, path) ? servedFiles[path] : undefined;
}

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string; [key: string]: unknown } | null;
  if (data?.type === undefined || data.type === '') {
    return;
  }

  if (data.type === 'SW_CLAIM_EVENT') {
    void self.clients.claim();
    return;
  }

  if (data.type === 'GET_SW_VERSION') {
    // On the caller's MessageChannel port, so it needs no global listener. Older callers send no port.
    const reply = { type: 'SW_VERSION', version: __SW_VERSION__ } as const;
    const [port] = event.ports;
    if (port !== undefined) {
      port.postMessage(reply);
    } else if (event.source) {
      (event.source as Client).postMessage(reply);
    }
    return;
  }

  if (data.type === 'SET_ARCHIVE') {
    // An ACK without a payload would leave the sender looping forever against an empty SW.
    const packed = data['packed'] as ArrayBuffer | undefined;
    const idx = data['index'] as ArchiveIndex | undefined;

    if (packed === undefined || idx === undefined) {
      if (event.source) {
        (event.source as Client).postMessage({
          type: 'ARCHIVE_ERROR',
          reason: 'SET_ARCHIVE missing packed/index payload',
        });
      }
      return;
    }

    servedFiles = unpackArchive(packed, idx);
    // The write matters only to the next instance, so it does not hold up the ACK. `waitUntil` keeps this one alive.
    const sender = event.source as Client | null;
    event.waitUntil(
      persistArchive({ packed, index: idx }).catch((err: unknown) => {
        console.error('Failed to persist the archive; a restarted worker will not serve it:', err);
        if (sender !== null) {
          reportArchiveFailure([sender], 'persist', err);
        }
      }),
    );
    if (event.source) {
      (event.source as Client).postMessage({ type: 'ARCHIVE_READY' });
    }
    return;
  }
});

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // SW infrastructure goes to the network. An archive that ships its own `node_modules/` is not served from it.
  if (
    url.pathname === BASE ||
    url.pathname === BASE.slice(0, -1) ||
    url.pathname === `${BASE}app-sw.js` ||
    url.pathname.startsWith(`${BASE}src/`) ||
    url.pathname.startsWith(`${BASE}node_modules/`) ||
    url.pathname.startsWith(`${BASE}@`)
  ) {
    return;
  }

  if (event.request.mode === 'navigate' && !url.pathname.startsWith(DOTLI_APP_PREFIX)) {
    return;
  }

  if (hasArchive()) {
    const result = lookupArchive(url.pathname, event.request.mode);
    if (result !== null) {
      event.respondWith(result);
    }
    return;
  }

  if (nothingPersisted) {
    const result = noArchiveResponse(url.pathname);
    if (result !== null) {
      event.respondWith(result);
    }
    return;
  }

  // A restarted worker reads the archive back first, since nginx answers every path with the shell as `text/html`.
  const { request } = event;
  event.respondWith(
    restoreArchive().then(
      () =>
        (hasArchive() ? lookupArchive(url.pathname, request.mode) : noArchiveResponse(url.pathname)) ?? fetch(request),
    ),
  );
});

/**
 * App paths get a 503 rather than nginx's shell HTML under the wrong MIME type. `null` lets the sandbox's own assets
 * reach the network.
 */
function noArchiveResponse(pathname: string): Response | null {
  if (!pathname.startsWith(DOTLI_APP_PREFIX)) {
    return null;
  }
  return new Response(null, {
    status: 503,
    statusText: 'App archive not yet loaded',
  });
}

/**
 * `null` means the path is not the archive's and must reach the network: the origin also serves the shell's own
 * assets, and a 404 for them strands a refresh on the loader.
 */
function lookupArchive(pathname: string, requestMode: RequestMode): Response | null {
  let filePath = pathname.startsWith(DOTLI_APP_PREFIX)
    ? pathname.slice(DOTLI_APP_PREFIX.length)
    : pathname.startsWith(BASE)
      ? pathname.slice(BASE.length)
      : pathname.slice(1);

  filePath = decodeURIComponent(filePath);

  let content = getFile(filePath);

  if (content === undefined && !hasExtension(filePath)) {
    const withIndex = filePath !== '' ? filePath + '/index.html' : 'index.html';
    content = getFile(withIndex);
    if (content !== undefined) {
      filePath = withIndex;
    }
    if (content === undefined && filePath !== '') {
      const noSlash = filePath + 'index.html';
      content = getFile(noSlash);
      if (content !== undefined) {
        filePath = noSlash;
      }
    }
  }

  if (content === undefined && (filePath === '' || filePath === '/')) {
    content = getFile('index.html');
    if (content !== undefined) {
      filePath = 'index.html';
    }
  }

  if (content !== undefined) {
    const mime = getMimeType(filePath);
    if (mime === 'text/html') {
      if (pathname === `${DOTLI_APP_PREFIX}index.html` || pathname === DOTLI_APP_PREFIX) {
        return makePrimaryHtmlResponse(content, mime);
      }
      return makeHtmlResponse(content, mime);
    }
    return new Response(content, archiveResponseInit(mime));
  }

  // Only navigations fall back to the SPA index, so shell assets still reach nginx.
  if (requestMode === 'navigate') {
    const indexHtml = getFile('index.html');
    if (!hasExtension(filePath) && indexHtml !== undefined) {
      return makeHtmlResponse(indexHtml, 'text/html');
    }
  }

  return null;
}

function injectSandboxScript(html: string): string {
  if (import.meta.env.VITE_SANDBOX_CHECKER === undefined) {
    return html;
  }
  // A copy of the sandbox-checker IIFE, since the SW build cannot import from the main bundle.
  const script = `<script>(function(){
"use strict";
function __dotliReport(a,d){try{window.parent.postMessage({type:"DOTLI_API_VIOLATION",api:a,details:d||{},timestamp:Date.now()},"*")}catch(e){}}
var _fetch=window.fetch;window.fetch=function(i,n){try{var u=new URL(typeof i==="string"?i:i instanceof Request?i.url:String(i),location.href);if(u.origin!==location.origin){__dotliReport("fetch",{url:u.href,method:(n&&n.method||"GET")})}}catch(e){__dotliReport("fetch",{url:String(i)})}return _fetch.apply(this,arguments)};
var _xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{var r=new URL(String(u),location.href);if(r.origin!==location.origin){__dotliReport("XMLHttpRequest",{url:r.href,method:m})}}catch(e){__dotliReport("XMLHttpRequest",{url:String(u),method:m})}return _xo.apply(this,arguments)};
var _WS=window.WebSocket;if(_WS){window.WebSocket=function(u,p){__dotliReport("WebSocket",{url:String(u)});return new _WS(u,p)};window.WebSocket.prototype=_WS.prototype;Object.defineProperty(window.WebSocket.prototype,"constructor",{value:window.WebSocket});window.WebSocket.CONNECTING=_WS.CONNECTING;window.WebSocket.OPEN=_WS.OPEN;window.WebSocket.CLOSING=_WS.CLOSING;window.WebSocket.CLOSED=_WS.CLOSED}
var _RTC=window.RTCPeerConnection||window.webkitRTCPeerConnection;if(_RTC){window.RTCPeerConnection=function(c,o){__dotliReport("RTCPeerConnection",{});return new _RTC(c,o)};window.RTCPeerConnection.prototype=_RTC.prototype;Object.defineProperty(window.RTCPeerConnection.prototype,"constructor",{value:window.RTCPeerConnection})}
var _ES=window.EventSource;if(_ES){window.EventSource=function(u,o){__dotliReport("EventSource",{url:String(u)});return new _ES(u,o)};window.EventSource.prototype=_ES.prototype;Object.defineProperty(window.EventSource.prototype,"constructor",{value:window.EventSource});window.EventSource.CONNECTING=_ES.CONNECTING;window.EventSource.OPEN=_ES.OPEN;window.EventSource.CLOSED=_ES.CLOSED}
if(navigator.sendBeacon){var _sb=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){__dotliReport("sendBeacon",{url:String(u)});return _sb(u,d)}}
var _W=window.Worker;if(_W){window.Worker=function(u,o){__dotliReport("Worker",{url:String(u)});return new _W(u,o)};window.Worker.prototype=_W.prototype;Object.defineProperty(window.Worker.prototype,"constructor",{value:window.Worker})}
var _SW=window.SharedWorker;if(_SW){window.SharedWorker=function(u,o){__dotliReport("SharedWorker",{url:String(u)});return new _SW(u,o)};window.SharedWorker.prototype=_SW.prototype;Object.defineProperty(window.SharedWorker.prototype,"constructor",{value:window.SharedWorker})}
if(navigator.serviceWorker&&navigator.serviceWorker.register){var _sr=navigator.serviceWorker.register.bind(navigator.serviceWorker);navigator.serviceWorker.register=function(u,o){__dotliReport("ServiceWorker.register",{url:String(u)});return _sr(u,o)}}
var _ce=document.createElement.bind(document);document.createElement=function(t,o){var el=_ce(t,o);if(typeof t==="string"&&t.toLowerCase()==="iframe"){__dotliReport("createElement(iframe)",{})}return el};
var _ls=window.localStorage;if(_ls){var _lsG=_ls.getItem.bind(_ls);var _lsS=_ls.setItem.bind(_ls);var _lsR=_ls.removeItem.bind(_ls);var _lsC=_ls.clear.bind(_ls);_ls.getItem=function(k){__dotliReport("Direct storage access (localStorage)",{method:"getItem",key:String(k)});return _lsG(k)};_ls.setItem=function(k,v){__dotliReport("Direct storage access (localStorage)",{method:"setItem",key:String(k)});return _lsS(k,v)};_ls.removeItem=function(k){__dotliReport("Direct storage access (localStorage)",{method:"removeItem",key:String(k)});return _lsR(k)};_ls.clear=function(){__dotliReport("Direct storage access (localStorage)",{method:"clear"});return _lsC()}}
var _ss=window.sessionStorage;if(_ss){var _ssG=_ss.getItem.bind(_ss);var _ssS=_ss.setItem.bind(_ss);var _ssR=_ss.removeItem.bind(_ss);var _ssC=_ss.clear.bind(_ss);_ss.getItem=function(k){__dotliReport("Direct storage access (sessionStorage)",{method:"getItem",key:String(k)});return _ssG(k)};_ss.setItem=function(k,v){__dotliReport("Direct storage access (sessionStorage)",{method:"setItem",key:String(k)});return _ssS(k,v)};_ss.removeItem=function(k){__dotliReport("Direct storage access (sessionStorage)",{method:"removeItem",key:String(k)});return _ssR(k)};_ss.clear=function(){__dotliReport("Direct storage access (sessionStorage)",{method:"clear"});return _ssC()}}
if(window.indexedDB&&window.indexedDB.open){var _io=window.indexedDB.open.bind(window.indexedDB);window.indexedDB.open=function(n,v){__dotliReport("Direct storage access (IndexedDB)",{method:"open",name:String(n)});return _io(n,v)}}
if(window.caches){var _co=window.caches.open.bind(window.caches);var _cd=window.caches.delete.bind(window.caches);var _ch=window.caches.has.bind(window.caches);window.caches.open=function(n){__dotliReport("Direct storage access (CacheStorage)",{method:"open",name:String(n)});return _co(n)};window.caches.delete=function(n){__dotliReport("Direct storage access (CacheStorage)",{method:"delete",name:String(n)});return _cd(n)};window.caches.has=function(n){__dotliReport("Direct storage access (CacheStorage)",{method:"has",name:String(n)});return _ch(n)}}
var _ck=Object.getOwnPropertyDescriptor(Document.prototype,"cookie")||Object.getOwnPropertyDescriptor(HTMLDocument.prototype,"cookie");if(_ck){Object.defineProperty(document,"cookie",{configurable:true,enumerable:true,get:function(){__dotliReport("Direct storage access (cookie)",{action:"read"});return _ck.get.call(document)},set:function(v){__dotliReport("Direct storage access (cookie)",{action:"write"});return _ck.set.call(document,v)}})}
var __wr=false;setTimeout(function(){__wr=true},3000);["injectedWeb3","polkadot","ethereum"].forEach(function(p){var s=window[p];var fw=true;Object.defineProperty(window,p,{configurable:true,enumerable:true,get:function(){if(s!==undefined&&__wr){__dotliReport("Direct wallet access ("+p+")",{action:"read"})}return s},set:function(v){if(fw){fw=false}else{__dotliReport("Direct wallet access ("+p+")",{action:"write"})}s=v}})});
})()</script>`;
  if (html.includes('<head>')) {
    return html.replace('<head>', '<head>' + script);
  }
  return script + html;
}

/** One source, so a new header lands on every served body. */
function archiveResponseInit(mime: string): ResponseInit {
  return {
    status: 200,
    headers: {
      'Content-Type': mime,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    },
  };
}

/** No base href or prefix stripping, which only sub-pages need. */
function makePrimaryHtmlResponse(content: ArrayBuffer | Uint8Array, mime: string): Response {
  let html = new TextDecoder().decode(content);
  html = injectSandboxScript(html);
  return new Response(new TextEncoder().encode(html), archiveResponseInit(mime));
}

function makeHtmlResponse(content: ArrayBuffer | Uint8Array, mime: string): Response {
  let html = new TextDecoder().decode(content);
  const prefixNoSlash = DOTLI_APP_PREFIX.slice(0, -1);
  const prefixLen = String(prefixNoSlash.length);
  const stripPrefix = `<script>if(location.pathname.startsWith('${prefixNoSlash}')){history.replaceState(null,'',(location.pathname.slice(${prefixLen})||'/')+location.search+location.hash)}</script>`;
  html = html.replace('<head>', `<head><base href="${DOTLI_APP_PREFIX}">${stripPrefix}`);
  html = injectSandboxScript(html);
  return new Response(new TextEncoder().encode(html), archiveResponseInit(mime));
}
