// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li app Service Worker.
//
// Archive serving only, no smoldot and no chain sync.
// Runs on <label>.app.dot.li to serve multi-file SPA archives from the
// in-memory and IndexedDB cache.

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

// Baked at build time by vite.config.ts (`define.__SW_VERSION__`). The page
// queries this via `GET_SW_VERSION` to detect stale workers.
declare const __SW_VERSION__: string;

import { getMimeType } from "@dotli/shared/mime";
import { computeArchiveDigest } from "@dotli/shared/archive-digest";
import { SW_ARCHIVE_CACHE_MAX } from "@dotli/config/config";

// Base path, derived at runtime from the SW script location.
const BASE = self.location.pathname.replace(/(?:src\/)?app-sw\.[jt]s$/, "");
const DOTLI_APP_PREFIX = `${BASE}dotli-app/`;

function hasExtension(path: string): boolean {
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  return lastDot > lastSlash;
}

// IndexedDB archive persistence (pooled connection).

const ARCHIVE_DB_NAME = "dotli-sw";
const ARCHIVE_DB_VERSION = 1;
const ARCHIVE_STORE = "archives";

interface ArchiveEntry {
  domain?: string;
  cid?: string;
  files?: Record<string, ArrayBuffer>;
  /**
   * Backend the archive was originally fetched under. Cache lookups only
   * return the entry if the user's current backend matches. Older entries
   * that lack this field are treated as misses.
   */
  contentBackend?: string;
  /**
   * Integrity tag over `files`, recomputed on cache read so a corrupted or
   * tampered IndexedDB entry is discarded instead of served. Defends against
   * storage corruption and passive tampering (an active same-origin attacker
   * who can rewrite the store can also rewrite this tag). Entries persisted
   * before this field existed lack it and are treated as misses.
   */
  digest?: string;
}

let archiveDbPromise: Promise<IDBDatabase> | null = null;

function getArchiveDB(): Promise<IDBDatabase> {
  if (archiveDbPromise !== null) {
    return archiveDbPromise;
  }
  archiveDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(ARCHIVE_DB_NAME, ARCHIVE_DB_VERSION);
    request.onerror = () => {
      archiveDbPromise = null;
      reject(new Error("Failed to open archive DB"));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => {
        archiveDbPromise = null;
      };
      resolve(db);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ARCHIVE_STORE)) {
        db.createObjectStore(ARCHIVE_STORE, { keyPath: "domain" });
      }
    };
  });
  return archiveDbPromise;
}

async function saveArchiveToDB(entry: {
  domain: string;
  cid: string;
  files: Record<string, ArrayBuffer>;
  contentBackend?: string;
}): Promise<void> {
  try {
    const digest = await computeArchiveDigest(entry.files);
    const db = await getArchiveDB();
    const tx = db.transaction(ARCHIVE_STORE, "readwrite");
    tx.objectStore(ARCHIVE_STORE).put({ ...entry, digest });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(new Error("Failed to save archive"));
      };
    });
  } catch (error) {
    console.error("Failed to save archive to IndexedDB:", error);
  }
}

async function loadArchiveFromDBByDomain(
  domain: string,
): Promise<ArchiveEntry | null> {
  try {
    const db = await getArchiveDB();
    const tx = db.transaction(ARCHIVE_STORE, "readonly");
    const request = tx.objectStore(ARCHIVE_STORE).get(domain);
    const entry = await new Promise<ArchiveEntry | null>((resolve, reject) => {
      request.onsuccess = () => {
        resolve((request.result as ArchiveEntry | undefined) ?? null);
      };
      request.onerror = () => {
        reject(new Error("Failed to load archive"));
      };
    });

    if (entry?.files === undefined) {
      return entry;
    }

    // Discard entries whose persisted bytes don't match their integrity tag
    // (corruption / tampering), and legacy entries that predate the tag. A
    // miss makes the page re-fetch (and re-persist with a digest), which is
    // the safe outcome — never serve unverifiable persisted content.
    const actual = await computeArchiveDigest(entry.files);
    if (entry.digest === undefined || entry.digest !== actual) {
      return null;
    }
    return entry;
  } catch (error) {
    console.error("Failed to load archive from IndexedDB:", error);
    return null;
  }
}

// Archive storage.

let archivePacked: ArrayBuffer | null = null;
let archiveFileIndex: Map<string, { o: number; l: number }> | null = null;

const archiveCache = new Map<string, ArchiveEntry>();

function archiveCacheSet(key: string, value: ArchiveEntry): void {
  archiveCache.delete(key);
  archiveCache.set(key, value);
  if (archiveCache.size > SW_ARCHIVE_CACHE_MAX) {
    const oldest = archiveCache.keys().next().value;
    if (oldest !== undefined) {
      archiveCache.delete(oldest);
    }
  }
}

function archiveCacheGet(key: string): ArchiveEntry | undefined {
  const entry = archiveCache.get(key);
  if (entry === undefined) {
    return undefined;
  }
  archiveCache.delete(key);
  archiveCache.set(key, entry);
  return entry;
}

function hasArchive(): boolean {
  return archivePacked !== null;
}

function getFile(path: string): ArrayBuffer | Uint8Array | undefined {
  if (archiveFileIndex === null || archivePacked === null) {
    return undefined;
  }
  const entry = archiveFileIndex.get(path);
  if (entry === undefined) {
    return undefined;
  }
  return new Uint8Array(archivePacked, entry.o, entry.l);
}

// SW lifecycle.

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Message handling.

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string; [key: string]: unknown } | null;
  if (data?.type === undefined || data.type === "") {
    return;
  }

  if (data.type === "SW_CLAIM_EVENT") {
    void self.clients.claim();
    return;
  }

  if (data.type === "GET_SW_VERSION") {
    // Reply synchronously via MessageChannel port so the caller doesn't have
    // to wire up a global listener. If no port was provided (older callers),
    // fall back to source.postMessage.
    const reply = { type: "SW_VERSION", version: __SW_VERSION__ } as const;
    if (event.ports.length > 0) {
      event.ports[0].postMessage(reply);
    } else if (event.source) {
      (event.source as Client).postMessage(reply);
    }
    return;
  }

  if (data.type === "SET_ARCHIVE") {
    // Reject malformed payloads loudly instead of ACKing as if it
    // worked. The sender will loop forever trying to serve archives
    // from an empty SW if we ACK without applying the payload.
    const packed = data.packed as ArrayBuffer | undefined;
    const idx = data.index as { p: string; o: number; l: number }[] | undefined;

    if (packed === undefined || idx === undefined) {
      if (event.source) {
        (event.source as Client).postMessage({
          type: "ARCHIVE_ERROR",
          reason: "SET_ARCHIVE missing packed/index payload",
        });
      }
      return;
    }

    archivePacked = packed;
    archiveFileIndex = new Map(idx.map((e) => [e.p, { o: e.o, l: e.l }]));

    const domain = data.domain as string | undefined;
    const cid = data.cid as string | undefined;
    const contentBackend = data.contentBackend as string | undefined;
    const source = event.source;

    // In-memory tables are live immediately (set above) so fetches can
    // be served. The ACK waits until the IDB persist completes: a reload
    // before IDB flush would otherwise find an empty archive store and
    // fall through to the network for every sub-resource. Splitting this
    // into two signals (ARCHIVE_INDEXED vs ARCHIVE_PERSISTED) would be
    // cleaner, but the page today only waits on ARCHIVE_READY, so we
    // gate ARCHIVE_READY on the slower, authoritative step.
    if (
      domain !== undefined &&
      domain !== "" &&
      cid !== undefined &&
      cid !== ""
    ) {
      const p = packed;
      const i = idx;
      const d = domain;
      const c = cid;
      const cb = contentBackend;
      const files: Record<string, ArrayBuffer> = {};
      for (const entry of i) {
        files[entry.p] = p.slice(entry.o, entry.o + entry.l);
      }
      const archiveEntry: ArchiveEntry = {
        domain: d,
        cid: c,
        files,
        contentBackend: cb,
      };
      archiveCacheSet(d, archiveEntry);
      void saveArchiveToDB({
        domain: d,
        cid: c,
        files,
        contentBackend: cb,
      })
        .then(() => {
          if (source) {
            (source as Client).postMessage({ type: "ARCHIVE_READY" });
          }
        })
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          if (source) {
            (source as Client).postMessage({
              type: "ARCHIVE_ERROR",
              reason: `Failed to persist archive: ${reason}`,
            });
          }
        });
      return;
    }

    // No domain/cid supplied: index is live but there's nothing to
    // persist. ACK immediately. IDB-lookup consumers will miss, which
    // is the correct behavior when the caller supplied no key.
    if (source) {
      (source as Client).postMessage({ type: "ARCHIVE_READY" });
    }
    return;
  }

  if (data.type === "SW_CACHE_LOOKUP_EVENT") {
    const domain = data.domain as string;
    // The SW returns `contentBackend` from the stored entry so the page-side
    // `getCachedArchive` can verify it matches the user's current backend.
    // (We don't filter here because the page-side check is authoritative
    // and the SW must remain backend-agnostic for older callers.)
    const cached = archiveCacheGet(domain);
    if (cached !== undefined) {
      for (const port of event.ports) {
        port.postMessage({
          found: true,
          cid: cached.cid,
          contentBackend: cached.contentBackend,
          files: cached.files,
        });
      }
      return;
    }
    void loadArchiveFromDBByDomain(domain)
      .then((entry) => {
        if (entry !== null && entry.cid !== "" && entry.files !== undefined) {
          archiveCacheSet(domain, entry);
        }
        for (const port of event.ports) {
          port.postMessage({
            found: entry !== null,
            cid: entry?.cid ?? null,
            contentBackend: entry?.contentBackend,
            files: entry?.files ?? null,
          });
        }
      })
      .catch((err: unknown) => {
        // Expose the IDB error to the page instead of pretending it was a
        // cache miss. Page-side code can decide whether to surface it.
        for (const port of event.ports) {
          port.postMessage({
            found: false,
            cid: null,
            files: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return;
  }
});

// Fetch interception (archive serving).

self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // SW infrastructure paths (the SW script itself, dev source,
  // node_modules, Vite virtual modules) are intentionally not served from
  // the archive. Let them reach the network. This excludes well-known
  // dApp filesystem paths only by accident. Future archives that legitimately
  // contain `node_modules/` will not be served. Documented for follow-up.
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

  // If the SW is active but the archive hasn't been set yet, sub-resource
  // requests for app paths must NOT fall through to nginx (which returns the
  // sandbox shell HTML and produces broken MIME types). Respond with a
  // deterministic 503 so the page sees a real failure instead of a nonsense
  // response.
  if (!hasArchive()) {
    if (url.pathname.startsWith(DOTLI_APP_PREFIX)) {
      event.respondWith(
        new Response(null, {
          status: 503,
          statusText: "App archive not yet loaded",
        }),
      );
    }
    return;
  }

  if (
    event.request.mode === "navigate" &&
    !url.pathname.startsWith(DOTLI_APP_PREFIX)
  ) {
    return;
  }

  const result = lookupArchive(url.pathname, event.request.mode);
  if (result !== null) {
    event.respondWith(result);
  }
});

/**
 * Look up `pathname` in the loaded archive.
 *
 * Return values:
 *   - `Response`: we own this path (either a file hit, or the SPA
 *     `index.html` fallback for a top-level navigation).
 *   - `null`: we don't own it, and the caller MUST let the request fall
 *     through to the network. The sandbox origin hosts BOTH the shell
 *     (`<label>.app.localhost/index.html` plus its vite-hashed `/assets/*.js`
 *     and `/assets/*.css`) AND, post-boot, whatever the currently-loaded
 *     dApp archive contains. Returning a 404 for shell asset requests
 *     just because they're not in the dApp archive breaks every refresh
 *     once a previous archive is in memory. Firefox surfaces a 404 on
 *     a module import as `NS_ERROR_CORRUPTED_CONTENT`, so the shell's
 *     own bundle fails to load and the page gets stuck on the loader.
 */
function lookupArchive(
  pathname: string,
  requestMode: RequestMode,
): Response | null {
  let filePath = pathname.startsWith(DOTLI_APP_PREFIX)
    ? pathname.slice(DOTLI_APP_PREFIX.length)
    : pathname.startsWith(BASE)
      ? pathname.slice(BASE.length)
      : pathname.slice(1);

  filePath = decodeURIComponent(filePath);

  let content = getFile(filePath);

  if (content === undefined && !hasExtension(filePath)) {
    const withIndex = filePath !== "" ? filePath + "/index.html" : "index.html";
    content = getFile(withIndex);
    if (content !== undefined) {
      filePath = withIndex;
    }
    if (content === undefined && filePath !== "") {
      const noSlash = filePath + "index.html";
      content = getFile(noSlash);
      if (content !== undefined) {
        filePath = noSlash;
      }
    }
  }

  if (content === undefined && (filePath === "" || filePath === "/")) {
    content = getFile("index.html");
    if (content !== undefined) {
      filePath = "index.html";
    }
  }

  if (content !== undefined) {
    const mime = getMimeType(filePath);
    if (mime === "text/html") {
      if (
        pathname === `${DOTLI_APP_PREFIX}index.html` ||
        pathname === DOTLI_APP_PREFIX
      ) {
        // Primary index.html: inject only the sandbox checker, no base or prefix rewrite.
        return makePrimaryHtmlResponse(content, mime);
      }
      return makeHtmlResponse(content, mime);
    }
    const body =
      content instanceof Uint8Array
        ? (content.buffer.slice(
            content.byteOffset,
            content.byteOffset + content.byteLength,
          ) as ArrayBuffer)
        : content;
    return new Response(body, archiveResponseInit(mime));
  }

  // SPA fallback, only for top-level navigations. Other requests fall
  // through to the network so shell assets (same origin, not in the
  // archive) reach nginx and load correctly.
  if (requestMode === "navigate") {
    const indexHtml = getFile("index.html");
    if (!hasExtension(filePath) && indexHtml !== undefined) {
      return makeHtmlResponse(indexHtml, "text/html");
    }
  }

  return null;
}

/** Inject the sandbox checker script into HTML, inlined for the SW context. */
function injectSandboxScript(html: string): string {
  if (
    (import.meta.env.VITE_SANDBOX_CHECKER as string | undefined) === undefined
  ) {
    return html;
  }
  // Inline the same IIFE as sandbox-checker.ts to avoid importing from main bundle.
  // The SW build is separate, so we duplicate the script string here.
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
  if (html.includes("<head>")) {
    return html.replace("<head>", "<head>" + script);
  }
  return script + html;
}

/**
 * Shared `ResponseInit` for SW-served archive content: 200 plus the security
 * header set. Single-sourced so any future header (e.g. CSP) lands on every
 * served body rather than a subset of the response builders.
 */
function archiveResponseInit(mime: string): ResponseInit {
  return {
    status: 200,
    headers: {
      "Content-Type": mime,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
    },
  };
}

/**
 * Response for the primary index.html, with only sandbox checker injection
 * and no base href or prefix stripping (those are only for sub-pages).
 */
function makePrimaryHtmlResponse(
  content: ArrayBuffer | Uint8Array,
  mime: string,
): Response {
  let html = new TextDecoder().decode(content);
  html = injectSandboxScript(html);
  return new Response(
    new TextEncoder().encode(html),
    archiveResponseInit(mime),
  );
}

function makeHtmlResponse(
  content: ArrayBuffer | Uint8Array,
  mime: string,
): Response {
  let html = new TextDecoder().decode(content);
  const prefixNoSlash = DOTLI_APP_PREFIX.slice(0, -1);
  const prefixLen = String(prefixNoSlash.length);
  const stripPrefix = `<script>if(location.pathname.startsWith('${prefixNoSlash}')){history.replaceState(null,'',(location.pathname.slice(${prefixLen})||'/')+location.search+location.hash)}</script>`;
  html = html.replace(
    "<head>",
    `<head><base href="${DOTLI_APP_PREFIX}">${stripPrefix}`,
  );
  html = injectSandboxScript(html);
  return new Response(
    new TextEncoder().encode(html),
    archiveResponseInit(mime),
  );
}
