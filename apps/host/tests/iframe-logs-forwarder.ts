// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Forwards console.* from every iframe and Web Worker to the top page.
 *
 * Playwright's `page.on("console")` only sees the top frame, so each
 * frame's logs are re-posted as `[FRAMELOG]<origin>[level]` strings the
 * top frame can echo for the test runner.
 */

export const IFRAME_FORWARDER = `
<script>
(function(){
  var KEY = "__dotli_framelog__";
  var frameTag = (function(){ try { return (location.host||"about:blank")+location.pathname; } catch(e){ return "unknown"; } })();
  var isTop = window.parent === window;
  var LEVELS = ["log","info","warn","error","debug"];
  var origs = {};
  LEVELS.forEach(function(l){ origs[l] = console[l].bind(console); });
  LEVELS.forEach(function(level){
    console[level] = function(){
      var args = Array.prototype.slice.call(arguments);
      origs[level].apply(null, args);
      if (typeof args[0] === "string" && args[0].indexOf("[FRAMELOG]") === 0) return;
      try {
        var text = args.map(function(a){
          if (typeof a === "string") return a;
          try { return JSON.stringify(a); } catch(e) { return String(a); }
        }).join(" ");
        var payload = {}; payload[KEY] = true; payload.frame = frameTag; payload.level = level; payload.text = text;
        if (!isTop) {
          window.parent.postMessage(payload, "*");
        } else {
          // Top frame has no parent. Emit the FRAMELOG line directly so
          // Playwright's page.on("console") captures it with the same
          // origin tagging as bridged child frames.
          origs.log("[FRAMELOG][" + frameTag + "][" + level + "]", text);
        }
      } catch(e) {}
    };
  });
  window.addEventListener("message", function(e){
    var d = e.data;
    if (!d || d[KEY] !== true) return;
    if (!isTop) { try { window.parent.postMessage(d, "*"); } catch(e) {} }
    else { origs.log("[FRAMELOG][" + String(d.frame) + "][" + String(d.level) + "]", String(d.text)); }
  });
  if (typeof window.Worker === "function") {
    var OriginalWorker = window.Worker;
    window.Worker = function(url, opts) {
      var w = new OriginalWorker(url, opts);
      w.addEventListener("message", function(e) {
        var d = e.data;
        if (!d || d[KEY] !== true) return;
        var payload = {}; payload[KEY] = true;
        payload.frame = frameTag + " → worker(" + String(url).split("/").pop() + ")";
        payload.level = d.level; payload.text = d.text;
        if (!isTop) { window.parent.postMessage(payload, "*"); }
        else { origs.log("[FRAMELOG][" + payload.frame + "][" + payload.level + "]", payload.text); }
      });
      return w;
    };
    window.Worker.prototype = OriginalWorker.prototype;
  }
  console.warn("[framelog-bridge ready: " + frameTag + "]");
})();
</script>
`;

export const WORKER_FORWARDER = `
(function(){
  var KEY = "__dotli_framelog__";
  var LEVELS = ["log","info","warn","error","debug"];
  LEVELS.forEach(function(level){
    var orig = console[level].bind(console);
    console[level] = function(){
      var args = Array.prototype.slice.call(arguments);
      orig.apply(null, args);
      try {
        var text = args.map(function(a){
          if (typeof a === "string") return a;
          try { return JSON.stringify(a); } catch(e) { return String(a); }
        }).join(" ");
        var payload = {}; payload[KEY] = true; payload.level = level; payload.text = text;
        self.postMessage(payload);
      } catch(e) {}
    };
  });
})();
`;

/**
 * Companion shim for the SharedWorker bundle. Unlike a regular Worker,
 * a SharedWorker cannot call `self.postMessage()`. Output is fanned out
 * across every connected MessagePort. Each `connect` event's port is
 * tracked, console.warn is hooked to broadcast a `__pw_sw_log__` envelope
 * to all ports, and a `__pw_sw_ping__/__pw_sw_pong__` round-trip lets the
 * test side verify the bridge is wired up.
 */
export const SHARED_WORKER_FORWARDER = `
const __pwOrigWarn = console.warn.bind(console);
const __pwPorts = [];
self.addEventListener('connect', (e) => {
  const port = e.ports[0];
  __pwPorts.push(port);
  port.addEventListener('message', (msg) => {
    if (msg.data && msg.data.__pw_sw_ping__) {
      port.postMessage({ __pw_sw_pong__: true });
    }
  });
  port.start();
});
console.warn = (...args) => {
  __pwOrigWarn(...args);
  const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  for (const p of __pwPorts) {
    try { p.postMessage({ __pw_sw_log__: true, text }); } catch (_) {}
  }
};
`;
