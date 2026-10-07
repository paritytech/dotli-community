// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { withActiveTld } from '@dotli/config';
import type { StoredSystemEvent } from './event-store.js';

export function summariseSystemEvent(ev: StoredSystemEvent): string {
  const p = ev.payload as Record<string, unknown>;
  switch (`${ev.layer}:${ev.event}`) {
    case 'boot:started':
      return `Host boot started (mode: ${str(p['mode'])}, chain: ${str(p['chainBackend'])}, content: ${str(p['contentBackend'])}).`;
    case 'boot:protocol_warmup_started':
      return `Warming protocol iframe (${str(p['subMode'])}).`;
    case 'boot:topbar_ready':
      return 'Top bar initialised.';
    case 'boot:url_parsed': {
      const label = typeof p['label'] === 'string' ? p['label'] : null;
      const lh = typeof p['localhostHost'] === 'string' ? p['localhostHost'] : null;
      if (lh !== null) {
        return `URL parsed: localhost proxy → ${lh}.`;
      }
      if (label !== null) {
        return `URL parsed: label=${label}.`;
      }
      return 'URL parsed: landing page (no subdomain).';
    }
    case 'boot:cid_cache_checked':
      return p['hit'] === true
        ? `CID cache hit for ${str(p['label'])} → ${str(p['cid'])}.`
        : `CID cache miss for ${str(p['label'])}.`;
    case 'boot:block_cache':
      return `Host block cache: ${str(p['hits'])} blocks from cache, ${str(p['misses'])} from the network.`;
    case 'boot:landing_page_shown':
      return 'Landing page rendered (no subdomain to resolve).';
    case 'boot:ready':
      return `Boot complete via ${str(p['path'])} path in ${numMs(p['totalMs'])}.`;
    case 'boot:failed':
      return `Boot failed (${str(p['dependency'])}): ${str(p['reason'])}.`;

    case 'resolve:started':
      return `Resolving ${withActiveTld(str(p['label']))} via ${str(p['source'])}.`;
    case 'resolve:phase':
      return `Phase ${str(p['phase'])}: ${str(p['message'])}`;
    case 'resolve:storage_read':
      return `Read dotns contenthash slot (${str(p['bytes'])} bytes in ${numMs(p['durationMs'])}).`;
    case 'resolve:completed':
      return p['cid'] === null
        ? `No content set for ${withActiveTld(str(p['label']))}.`
        : `Resolved ${withActiveTld(str(p['label']))} → ${str(p['cid'])} in ${numMs(p['durationMs'])}.`;
    case 'resolve:failed':
      return `Resolve failed via ${str(p['source'])}: ${str(p['reason'])}.`;

    case 'render:iframe_begin':
      return `Rendering iframe for ${str(p['label'])} (${str(p['mode'])}).`;
    case 'render:iframe_ready':
      return `Iframe ready (${str(p['mode'])}).`;

    case 'bridge:setup_begin':
      return `Setting up TrUAPI bridge (productId=${str(p['productId'])}).`;
    case 'bridge:setup_ready':
      return `TrUAPI bridge ready (productId=${str(p['productId'])}).`;
    case 'bridge:iframe_load':
      return `Product iframe finished loading (${str(p['mode'])}, productId=${str(p['productId'])}).`;
    case 'bridge:first_inbound':
      return `First message from product received (productId=${str(p['productId'])}).`;
    case 'bridge:first_outbound':
      return `First message sent to product — bridge traffic established (productId=${str(p['productId'])}).`;

    case 'failover:chain_backend':
      return `Chain backend failover: ${str(p['from'])} → ${str(p['to'])} (reason: ${str(p['reason'])}).`;

    case 'chain:phase': {
      const reason = typeof p['reason'] === 'string' ? ` (${p['reason']})` : '';
      const peers = typeof p['peers'] === 'number' ? `, ${String(p['peers'])} peers` : '';
      const warp =
        typeof p['warpAt'] === 'number' && typeof p['warpTarget'] === 'number'
          ? `, warped to block ${String(p['warpAt'])} of ${String(p['warpTarget'])}`
          : '';
      return `${str(p['chain'])} is now ${str(p['phase'])}${reason}${peers}${warp}.`;
    }
    case 'chain:bytes':
      return `Light client has received ${str(p['received'])} bytes so far.`;

    case 'main:stall_detected':
      return `Main thread blocked for ${numMs(p['durationMs'])}.`;
    case 'main:heartbeat':
      return `Main thread alive (uptime ${str(p['uptimeSec'])}s).`;
    case 'main:monitor_stopped':
      return p['reason'] === 'bridge_ready'
        ? 'Main-thread monitor stopped (bridge traffic established).'
        : 'Main-thread monitor stopped (max duration reached).';

    case 'sandbox:started':
      return `Sandbox iframe started (cid=${str(p['cid'])}, backend=${str(p['contentBackend'])}).`;
    case 'sandbox:sw_register_begin':
      return `Registering service worker${p['waitForFreshController'] === true ? ' (waiting for fresh controller)' : ''}.`;
    case 'sandbox:sw_ready':
      return `Service worker ready in ${numMs(p['durationMs'])}.`;
    case 'sandbox:fetch_begin':
      return `Fetching archive via ${str(p['contentBackend'])}.`;
    case 'sandbox:helia_ready':
      return `Helia P2P ready in ${numMs(p['durationMs'])}.`;
    case 'sandbox:status':
      return `Sandbox status: ${str(p['message'])}`;
    case 'sandbox:fetch_complete':
      return `Archive fetched (${str(p['kind'])}) in ${numMs(p['durationMs'])}.`;
    case 'sandbox:decrypt_started':
      return 'Prompting for decryption password.';
    case 'sandbox:decrypt_complete':
      return 'Archive decrypted.';
    case 'sandbox:archive_stored':
      return `Archive staged in SW (${str(p['fileCount'])} files, ${numMs(p['durationMs'])}).`;
    case 'sandbox:document_written':
      return `Sandbox ready in ${numMs(p['totalMs'])} — dApp HTML written, product transport will start here.`;
    case 'sandbox:failed':
      return `Sandbox failed: ${str(p['reason'])}.`;

    default:
      return `${ev.layer}:${ev.event}`;
  }
}

function str(v: unknown): string {
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return '?';
}

function numMs(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return '?';
  }
  if (v < 1000) {
    return `${String(Math.round(v))}ms`;
  }
  return `${(v / 1000).toFixed(2)}s`;
}
