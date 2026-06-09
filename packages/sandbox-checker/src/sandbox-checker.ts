// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Sandbox API Checker.
//
// Generates a self-contained IIFE script that monkey-patches restricted
// browser APIs inside the dApp iframe. Violations are reported to the
// parent window via postMessage (log-and-forward: the call still proceeds).
//
// Activated only when VITE_SANDBOX_CHECKER is set at build time.

/**
 * Self-contained vanilla JS IIFE injected into dApp HTML.
 * Monkey-patches network, worker, service-worker, DOM, and wallet APIs.
 * Reports violations to parent via postMessage but lets calls proceed.
 */
export const SANDBOX_CHECKER_SCRIPT = `<script>(function(){
"use strict";
function __dotliReport(api,details){
try{window.parent.postMessage({type:"DOTLI_API_VIOLATION",api:api,details:details||{},timestamp:Date.now()},"*")}catch(e){}
}

// ── Network: fetch (skip same-origin) ──
var _fetch=window.fetch;
window.fetch=function(input,init){
try{
var u=new URL(typeof input==="string"?input:input instanceof Request?input.url:String(input),location.href);
if(u.origin!==location.origin){__dotliReport("fetch",{url:u.href,method:(init&&init.method||"GET")})}
}catch(e){__dotliReport("fetch",{url:String(input)})}
return _fetch.apply(this,arguments);
};

// ── Network: XMLHttpRequest (skip same-origin) ──
var _xhrOpen=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url){
try{
var u=new URL(String(url),location.href);
if(u.origin!==location.origin){__dotliReport("XMLHttpRequest",{url:u.href,method:method})}
}catch(e){__dotliReport("XMLHttpRequest",{url:String(url),method:method})}
return _xhrOpen.apply(this,arguments);
};

// ── Network: WebSocket ──
var _WebSocket=window.WebSocket;
if(_WebSocket){
window.WebSocket=function(url,protocols){
__dotliReport("WebSocket",{url:String(url)});
return new _WebSocket(url,protocols);
};
window.WebSocket.prototype=_WebSocket.prototype;
Object.defineProperty(window.WebSocket.prototype,"constructor",{value:window.WebSocket});
window.WebSocket.CONNECTING=_WebSocket.CONNECTING;
window.WebSocket.OPEN=_WebSocket.OPEN;
window.WebSocket.CLOSING=_WebSocket.CLOSING;
window.WebSocket.CLOSED=_WebSocket.CLOSED;
}

// ── Network: RTCPeerConnection ──
var _RTC=window.RTCPeerConnection||window.webkitRTCPeerConnection;
if(_RTC){
window.RTCPeerConnection=function(config,constraints){
__dotliReport("RTCPeerConnection",{});
return new _RTC(config,constraints);
};
window.RTCPeerConnection.prototype=_RTC.prototype;
Object.defineProperty(window.RTCPeerConnection.prototype,"constructor",{value:window.RTCPeerConnection});
}

// ── Network: EventSource ──
var _EventSource=window.EventSource;
if(_EventSource){
window.EventSource=function(url,eventSourceInitDict){
__dotliReport("EventSource",{url:String(url)});
return new _EventSource(url,eventSourceInitDict);
};
window.EventSource.prototype=_EventSource.prototype;
Object.defineProperty(window.EventSource.prototype,"constructor",{value:window.EventSource});
window.EventSource.CONNECTING=_EventSource.CONNECTING;
window.EventSource.OPEN=_EventSource.OPEN;
window.EventSource.CLOSED=_EventSource.CLOSED;
}

// ── Network: navigator.sendBeacon ──
if(navigator.sendBeacon){
var _sendBeacon=navigator.sendBeacon.bind(navigator);
navigator.sendBeacon=function(url,data){
__dotliReport("sendBeacon",{url:String(url)});
return _sendBeacon(url,data);
};
}

// ── Workers: Worker ──
var _Worker=window.Worker;
if(_Worker){
window.Worker=function(scriptURL,options){
__dotliReport("Worker",{url:String(scriptURL)});
return new _Worker(scriptURL,options);
};
window.Worker.prototype=_Worker.prototype;
Object.defineProperty(window.Worker.prototype,"constructor",{value:window.Worker});
}

// ── Workers: SharedWorker ──
var _SharedWorker=window.SharedWorker;
if(_SharedWorker){
window.SharedWorker=function(scriptURL,options){
__dotliReport("SharedWorker",{url:String(scriptURL)});
return new _SharedWorker(scriptURL,options);
};
window.SharedWorker.prototype=_SharedWorker.prototype;
Object.defineProperty(window.SharedWorker.prototype,"constructor",{value:window.SharedWorker});
}

// ── SW: ServiceWorkerContainer.register ──
if(navigator.serviceWorker&&navigator.serviceWorker.register){
var _swRegister=navigator.serviceWorker.register.bind(navigator.serviceWorker);
navigator.serviceWorker.register=function(scriptURL,options){
__dotliReport("ServiceWorker.register",{url:String(scriptURL)});
return _swRegister(scriptURL,options);
};
}

// ── DOM: document.createElement('iframe') ──
var _createElement=document.createElement.bind(document);
document.createElement=function(tagName,options){
var el=_createElement(tagName,options);
if(typeof tagName==="string"&&tagName.toLowerCase()==="iframe"){
__dotliReport("createElement(iframe)",{});
}
return el;
};

// ── Storage: localStorage ──
var _localStorage=window.localStorage;
if(_localStorage){
var _lsGetItem=_localStorage.getItem.bind(_localStorage);
var _lsSetItem=_localStorage.setItem.bind(_localStorage);
var _lsRemoveItem=_localStorage.removeItem.bind(_localStorage);
var _lsClear=_localStorage.clear.bind(_localStorage);
_localStorage.getItem=function(k){__dotliReport("Direct storage access (localStorage)",{method:"getItem",key:String(k)});return _lsGetItem(k)};
_localStorage.setItem=function(k,v){__dotliReport("Direct storage access (localStorage)",{method:"setItem",key:String(k)});return _lsSetItem(k,v)};
_localStorage.removeItem=function(k){__dotliReport("Direct storage access (localStorage)",{method:"removeItem",key:String(k)});return _lsRemoveItem(k)};
_localStorage.clear=function(){__dotliReport("Direct storage access (localStorage)",{method:"clear"});return _lsClear()};
}

// ── Storage: sessionStorage ──
var _sessionStorage=window.sessionStorage;
if(_sessionStorage){
var _ssGetItem=_sessionStorage.getItem.bind(_sessionStorage);
var _ssSetItem=_sessionStorage.setItem.bind(_sessionStorage);
var _ssRemoveItem=_sessionStorage.removeItem.bind(_sessionStorage);
var _ssClear=_sessionStorage.clear.bind(_sessionStorage);
_sessionStorage.getItem=function(k){__dotliReport("Direct storage access (sessionStorage)",{method:"getItem",key:String(k)});return _ssGetItem(k)};
_sessionStorage.setItem=function(k,v){__dotliReport("Direct storage access (sessionStorage)",{method:"setItem",key:String(k)});return _ssSetItem(k,v)};
_sessionStorage.removeItem=function(k){__dotliReport("Direct storage access (sessionStorage)",{method:"removeItem",key:String(k)});return _ssRemoveItem(k)};
_sessionStorage.clear=function(){__dotliReport("Direct storage access (sessionStorage)",{method:"clear"});return _ssClear()};
}

// ── Storage: IndexedDB ──
if(window.indexedDB&&window.indexedDB.open){
var _idbOpen=window.indexedDB.open.bind(window.indexedDB);
window.indexedDB.open=function(name,version){__dotliReport("Direct storage access (IndexedDB)",{method:"open",name:String(name)});return _idbOpen(name,version)};
}

// ── Storage: Cache API ──
if(window.caches){
var _cachesOpen=window.caches.open.bind(window.caches);
var _cachesDelete=window.caches.delete.bind(window.caches);
var _cachesHas=window.caches.has.bind(window.caches);
window.caches.open=function(name){__dotliReport("Direct storage access (CacheStorage)",{method:"open",name:String(name)});return _cachesOpen(name)};
window.caches.delete=function(name){__dotliReport("Direct storage access (CacheStorage)",{method:"delete",name:String(name)});return _cachesDelete(name)};
window.caches.has=function(name){__dotliReport("Direct storage access (CacheStorage)",{method:"has",name:String(name)});return _cachesHas(name)};
}

// ── Storage: document.cookie ──
var _cookieDesc=Object.getOwnPropertyDescriptor(Document.prototype,"cookie")||Object.getOwnPropertyDescriptor(HTMLDocument.prototype,"cookie");
if(_cookieDesc){
Object.defineProperty(document,"cookie",{
configurable:true,enumerable:true,
get:function(){__dotliReport("Direct storage access (cookie)",{action:"read"});return _cookieDesc.get.call(document)},
set:function(v){__dotliReport("Direct storage access (cookie)",{action:"write"});return _cookieDesc.set.call(document,v)}
});
}

// ── Wallet traps ──
// Browser wallet extensions inject themselves into every page by writing to
// these globals early during load, then read them back to check registration.
// To avoid false positives: skip the first write (extension bootstrapping)
// and only report reads after a delay (3s after load), when actual dApp
// access is more likely.
var __walletReady=false;
setTimeout(function(){__walletReady=true},3000);
var walletProps=["injectedWeb3","polkadot","ethereum"];
walletProps.forEach(function(prop){
var store=window[prop];
var firstWrite=true;
Object.defineProperty(window,prop,{
configurable:true,enumerable:true,
get:function(){if(store!==undefined&&__walletReady){__dotliReport("Direct wallet access ("+prop+")",{action:"read"})}return store;},
set:function(v){if(firstWrite){firstWrite=false}else{__dotliReport("Direct wallet access ("+prop+")",{action:"write"})}store=v;}
});
});
})()</script>`;

/**
 * Inject the sandbox checker script into HTML content.
 * Inserts after `<head>` if present, otherwise prepends to the HTML.
 */
export function injectSandboxChecker(html: string): string {
  if (html.includes("<head>")) {
    return html.replace("<head>", "<head>" + SANDBOX_CHECKER_SCRIPT);
  }
  return SANDBOX_CHECKER_SCRIPT + html;
}
