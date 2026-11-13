// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { withActiveTld } from '@dotli/config';
import { getSystemEventKey } from './getSystemEventKey.js';
import type { StoredSystemEvent } from './storedEvent.js';

/** One sentence on a host event, read from its layer, name and payload. Never throws. */
export function summariseSystemEvent(event: StoredSystemEvent): string {
  // The payload parse is held, so a host event's payload is taken to be the record its layer emits.
  const payload = event.payload as Record<string, unknown>;
  const key = getSystemEventKey(event);
  switch (key) {
    case 'boot:started':
      return `Host boot started (chain: ${formatValue(payload['chainBackend'])}).`;
    case 'boot:protocol_warmup_started':
      return `Warming protocol iframe (${formatValue(payload['subMode'])}).`;
    case 'boot:topbar_ready':
      return 'Top bar initialised.';
    case 'boot:url_parsed': {
      const label = typeof payload['label'] === 'string' ? payload['label'] : null;
      const localhostHost = typeof payload['localhostHost'] === 'string' ? payload['localhostHost'] : null;
      if (localhostHost !== null) {
        return `URL parsed: localhost proxy to ${localhostHost}.`;
      }
      if (label !== null) {
        return `URL parsed: label=${label}.`;
      }
      return 'URL parsed: landing page (no subdomain).';
    }
    case 'boot:cid_cache_checked':
      return payload['hit'] === true
        ? `CID cache hit for ${formatValue(payload['label'])}: ${formatValue(payload['cid'])}.`
        : `CID cache miss for ${formatValue(payload['label'])}.`;
    case 'boot:block_cache':
      return `Host block cache: ${formatValue(payload['hits'])} blocks from cache, ${formatValue(payload['misses'])} from the network.`;
    case 'boot:ready':
      return `Boot complete via ${formatValue(payload['path'])} path in ${formatMilliseconds(payload['totalMs'])}.`;
    case 'boot:failed':
      return `Boot failed (${formatValue(payload['dependency'])}): ${formatValue(payload['reason'])}.`;

    case 'resolve:started':
      return `Resolving ${withActiveTld(formatValue(payload['label']))} via ${formatValue(payload['source'])}.`;
    case 'resolve:phase':
      return `Phase ${formatValue(payload['phase'])}.`;
    case 'resolve:completed':
      return payload['cid'] === null
        ? `No content set for ${withActiveTld(formatValue(payload['label']))}.`
        : `Resolved ${withActiveTld(formatValue(payload['label']))} to ${formatValue(payload['cid'])} in ${formatMilliseconds(payload['durationMs'])}.`;
    case 'resolve:failed':
      return `Resolve failed via ${formatValue(payload['source'])}: ${formatValue(payload['reason'])}.`;

    case 'render:iframe_begin':
      return `Rendering iframe for ${formatValue(payload['label'])} (${formatValue(payload['mode'])}).`;
    case 'render:iframe_ready':
      return `Iframe ready (${formatValue(payload['mode'])}).`;

    case 'bridge:setup_begin':
      return `Setting up TrUAPI bridge (productId=${formatValue(payload['productId'])}).`;
    case 'bridge:setup_ready':
      return `TrUAPI bridge ready (productId=${formatValue(payload['productId'])}).`;
    case 'bridge:iframe_load':
      return `Product iframe finished loading (${formatValue(payload['mode'])}, productId=${formatValue(payload['productId'])}).`;
    case 'bridge:first_inbound':
      return `First message from product received (productId=${formatValue(payload['productId'])}).`;
    case 'bridge:first_outbound':
      return `First message sent to product, bridge traffic established (productId=${formatValue(payload['productId'])}).`;

    case 'failover:chain_backend':
      return `Chain backend failover from ${formatValue(payload['from'])} to ${formatValue(payload['to'])} (reason: ${formatValue(payload['reason'])}).`;

    case 'chain:phase': {
      const reason = typeof payload['reason'] === 'string' ? ` (${payload['reason']})` : '';
      const peers = typeof payload['peers'] === 'number' ? `, ${String(payload['peers'])} peers` : '';
      const warp =
        typeof payload['warpAt'] === 'number' && typeof payload['warpTarget'] === 'number'
          ? `, warped to block ${String(payload['warpAt'])} of ${String(payload['warpTarget'])}`
          : '';
      return `${formatValue(payload['chain'])} is now ${formatValue(payload['phase'])}${reason}${peers}${warp}.`;
    }
    case 'chain:bytes':
      return `Light client has received ${formatValue(payload['received'])} bytes so far.`;
    case 'chain:dbcache':
    case 'chain:peers':
      return key;

    case 'main:stall_detected':
      return `Main thread blocked for ${formatMilliseconds(payload['durationMs'])}.`;
    case 'main:heartbeat':
      return `Main thread alive (uptime ${formatValue(payload['uptimeSec'])}s).`;
    case 'main:monitor_stopped':
      return payload['reason'] === 'bridge_ready'
        ? 'Main-thread monitor stopped (bridge traffic established).'
        : 'Main-thread monitor stopped (max duration reached).';

    case 'sandbox:document_written':
      return `Sandbox ready in ${formatMilliseconds(payload['totalMs'])}: dApp HTML written, product transport will start here.`;

    default:
      // Events cross a page boundary untyped, so one outside the union still shows its key.
      return key satisfies never;
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '?';
}

function formatMilliseconds(duration: unknown): string {
  if (typeof duration !== 'number' || !Number.isFinite(duration)) {
    return '?';
  }
  if (duration < 1000) {
    return `${String(Math.round(duration))}ms`;
  }
  return `${(duration / 1000).toFixed(2)}s`;
}
