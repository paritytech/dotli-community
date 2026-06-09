// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Human-readable summaries of system (non-TrUAPI) events.
//
// Mirrors chain-summary.ts for the System swimlane: each event becomes
// a single sentence shown at the top of the detail pane. Keeps the
// renderers (row + timeline tooltip + detail) consistent across event
// kinds.

import type { StoredSystemEvent } from "./event-store.ts";

export function summariseSystemEvent(ev: StoredSystemEvent): string {
  const p = ev.payload as Record<string, unknown>;
  switch (`${ev.layer}:${ev.event}`) {
    // boot
    case "boot:started":
      return `Host boot started (mode: ${str(p.mode)}, chain: ${str(p.chainBackend)}, content: ${str(p.contentBackend)}).`;
    case "boot:protocol_warmup_started":
      return `Warming protocol iframe (${str(p.subMode)}).`;
    case "boot:topbar_ready":
      return "Top bar initialised.";
    case "boot:url_parsed": {
      const label = typeof p.label === "string" ? p.label : null;
      const lh = typeof p.localhostHost === "string" ? p.localhostHost : null;
      if (lh !== null) {
        return `URL parsed: localhost proxy → ${lh}.`;
      }
      if (label !== null) {
        return `URL parsed: label=${label}.`;
      }
      return "URL parsed: landing page (no subdomain).";
    }
    case "boot:cid_cache_checked":
      return p.hit === true
        ? `CID cache hit for ${str(p.label)} → ${str(p.cid)}.`
        : `CID cache miss for ${str(p.label)}.`;
    case "boot:landing_page_shown":
      return "Landing page rendered (no subdomain to resolve).";
    case "boot:ready":
      return `Boot complete via ${str(p.path)} path in ${numMs(p.totalMs)}.`;
    case "boot:failed":
      return `Boot failed (${str(p.dependency)}): ${str(p.reason)}.`;

    // resolve
    case "resolve:started":
      return `Resolving ${str(p.label)}.dot via ${str(p.source)}.`;
    case "resolve:phase":
      return `Phase ${str(p.phase)}: ${str(p.message)}`;
    case "resolve:storage_read":
      return `Read dotns contenthash slot (${str(p.bytes)} bytes in ${numMs(p.durationMs)}).`;
    case "resolve:completed":
      return p.cid === null
        ? `No content set for ${str(p.label)}.dot.`
        : `Resolved ${str(p.label)}.dot → ${str(p.cid)} in ${numMs(p.durationMs)}.`;
    case "resolve:failed":
      return `Resolve failed via ${str(p.source)}: ${str(p.reason)}.`;

    // render
    case "render:iframe_begin":
      return `Rendering iframe for ${str(p.label)} (${str(p.mode)}).`;
    case "render:iframe_ready":
      return `Iframe ready (${str(p.mode)}).`;

    // bridge
    case "bridge:setup_begin":
      return `Setting up TrUAPI bridge (productId=${str(p.productId)}).`;
    case "bridge:setup_ready":
      return `TrUAPI bridge ready (productId=${str(p.productId)}).`;
    case "bridge:iframe_load":
      return `Product iframe finished loading (${str(p.mode)}, productId=${str(p.productId)}).`;
    case "bridge:first_inbound":
      return `First message from product received (productId=${str(p.productId)}).`;
    case "bridge:first_outbound":
      return `First message sent to product — bridge traffic established (productId=${str(p.productId)}).`;
    case "bridge:nested_detected":
      return `Nested dApp #${str(p.nestedIndex)} detected (productId=${str(p.productId)}).`;

    // failover
    case "failover:chain_backend":
      return `Chain backend failover: ${str(p.from)} → ${str(p.to)} (reason: ${str(p.reason)}).`;

    // main-thread monitor
    case "main:stall_detected":
      return `Main thread blocked for ${numMs(p.durationMs)}.`;
    case "main:heartbeat":
      return `Main thread alive (uptime ${str(p.uptimeSec)}s).`;
    case "main:monitor_stopped":
      return p.reason === "bridge_ready"
        ? "Main-thread monitor stopped (bridge traffic established)."
        : "Main-thread monitor stopped (max duration reached).";

    case "sandbox:started":
      return `Sandbox iframe started (cid=${str(p.cid)}, backend=${str(p.contentBackend)}).`;
    case "sandbox:sw_register_begin":
      return `Registering service worker${p.waitForFreshController === true ? " (waiting for fresh controller)" : ""}.`;
    case "sandbox:sw_ready":
      return `Service worker ready in ${numMs(p.durationMs)}.`;
    case "sandbox:cache_checked":
      return p.hit === true
        ? `SW archive cache HIT (${str(p.fileCount)} files).`
        : "SW archive cache MISS.";
    case "sandbox:fetch_begin":
      return `Fetching archive via ${str(p.contentBackend)}.`;
    case "sandbox:helia_ready":
      return `Helia P2P ready in ${numMs(p.durationMs)}.`;
    case "sandbox:status":
      return `Sandbox status: ${str(p.message)}`;
    case "sandbox:fetch_complete":
      return `Archive fetched (${str(p.kind)}) in ${numMs(p.durationMs)}.`;
    case "sandbox:decrypt_started":
      return "Prompting for decryption password.";
    case "sandbox:decrypt_complete":
      return "Archive decrypted.";
    case "sandbox:archive_stored":
      return `Archive staged in SW (${str(p.fileCount)} files, ${numMs(p.durationMs)}).`;
    case "sandbox:document_written":
      return `Sandbox ready in ${numMs(p.totalMs)} — dApp HTML written, product transport will start here.`;
    case "sandbox:failed":
      return `Sandbox failed: ${str(p.reason)}.`;

    // SSO (host-papp)
    case "sso:pairing_started":
      return `Wallet pairing started (product metadata=${str(p.metadata)}).`;
    case "sso:deeplink_generated":
      return `Pairing deeplink generated. QR ready for scan.`;
    case "sso:awaiting_response":
      return "Waiting for wallet response on handshake topic.";
    case "sso:response_received":
      return `Wallet response received (identity account).`;
    case "sso:session_established":
      return `Session ${str(p.sessionId)} established.`;
    case "sso:pairing_failed":
      return `Wallet pairing failed: ${str(p.reason)}.`;

    // attestation (host-papp)
    case "attestation:started":
      return `Starting guest identity attestation for candidate ${str(p.candidateAccountId)}.`;
    case "attestation:username_claimed":
      return `Username claimed: ${str(p.username)}.`;
    case "attestation:allowance_granted":
      return `Verifier allowance granted (${str(p.verifierAccountId)}).`;
    case "attestation:vrf_proof_generated":
      return "VRF ring-proof generated for candidate.";
    case "attestation:person_registered":
      return `Registered ${str(p.username)} on People chain.`;
    case "attestation:completed":
      return `Attestation complete for ${str(p.username)}.`;
    case "attestation:failed":
      return `Attestation failed: ${str(p.reason)}.`;

    // session (host-papp)
    case "session:opened":
      return `Session ${str(p.sessionId)} opened.`;
    case "session:peer_action_received":
      return `Peer action received: ${str(p.actionKind)} (msg=${str(p.messageId)}).`;
    case "session:peer_action_processed":
      return `Peer action processed (msg=${str(p.messageId)}).`;
    case "session:peer_action_failed":
      return `Peer action failed (msg=${str(p.messageId)}): ${str(p.reason)}.`;
    case "session:host_action_sent":
      return `Host sent ${str(p.actionKind)} to wallet (msg=${str(p.messageId)}).`;
    case "session:host_action_response_received":
      return `Wallet responded to ${str(p.messageId)} (success=${String(p.success)}).`;
    case "session:host_action_failed":
      return `Host action failed (msg=${str(p.messageId)}): ${str(p.reason)}.`;
    case "session:terminated":
      return `Session ${str(p.sessionId)} terminated.`;

    default:
      return `${ev.layer}:${ev.event}`;
  }
}

function str(v: unknown): string {
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return "?";
}

function numMs(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return "?";
  }
  if (v < 1000) {
    return `${String(Math.round(v))}ms`;
  }
  return `${(v / 1000).toFixed(2)}s`;
}
