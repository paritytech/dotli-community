// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The markup the imperative topbar.ts produced for the network button and
// its popover before they became an island (commit 07463e3d): Shell.tsx's
// static markup, changed by the writes initChainsPopover and
// setChainsButtonVisible made, and filled by renderChainsPopover's first
// render (before any block landed while open, so without the slide). The
// builder below is that code, with its formatters, copied as it was. The
// island tests compare against it node for node.

import type { ChainStatus, TransferState } from '../../../src/network-monitor.js';

const STATIC_BUTTON = `<button id="chains-button" class="topbar-btn topbar-chains-btn" title="Network" aria-label="Network" aria-expanded="false" aria-controls="chains-popover"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></button>`;

const STATIC_POPOVER = `<div class="more-popover chains-popover" id="chains-popover"></div>`;

function fromHtml(html: string): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content.firstElementChild as HTMLElement;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function describeBlockDelay(gapMs: number, blockTimeMs: number): string {
  const secs = (ms: number): string =>
    ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${String(Math.round(ms / 1000))}s`;
  const late = gapMs - blockTimeMs;
  return late <= 0 ? `${secs(gapMs)}, on time` : `${secs(gapMs)}, ${secs(late)} late`;
}

function formatSize(bytes: number): string {
  return bytes < 1_048_576 ? `${String(Math.round(bytes / 1024))} kB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) {
    return `${String(Math.round(bytesPerSecond))} B/s`;
  }
  return bytesPerSecond < 1_048_576
    ? `${String(Math.round(bytesPerSecond / 1024))} kB/s`
    : `${(bytesPerSecond / 1_048_576).toFixed(1)} MB/s`;
}

function describeLiveNetwork(status: readonly ChainStatus[]): {
  text: string;
  tone: string;
} {
  const chains = status.filter(c => c.reachable);
  if (chains.length === 0) {
    return { text: 'Starting', tone: 'idle' };
  }
  const started = chains.filter(c => c.latest !== null);
  if (started.length === 0) {
    return { text: 'Connecting', tone: 'idle' };
  }
  const overdue = started.filter(c => c.sinceLast !== null && c.sinceLast > c.blockTimeMs * 3);
  if (overdue.length > 0) {
    return {
      text: `Waiting on ${overdue.map(c => c.label).join(' and ')}`,
      tone: 'warn',
    };
  }
  if (started.length < chains.length) {
    return {
      text: `Connecting, ${String(started.length)} of ${String(chains.length)} ready`,
      tone: 'idle',
    };
  }
  return { text: 'Your connection is good', tone: 'ok' };
}

/** The button after initChainsPopover (and setChainsButtonVisible). */
export function oldChainsButton(opts: { open: boolean; visible: boolean }): HTMLElement {
  const button = fromHtml(STATIC_BUTTON);
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', String(opts.open));
  button.classList.toggle('visible', opts.visible);
  return button;
}

export interface OldChainsContent {
  /** What getNetworkStatus() returned when the popover opened. */
  chains: readonly ChainStatus[];
  transfer: TransferState;
  productLoaded: boolean;
}

/**
 * The popover after initChainsPopover and, when open, renderChainsPopover's
 * first render. The one addition is `tabindex="-1"`: createPopover's
 * trapFocus focuses the surface (spec decision 3).
 */
export function oldChainsPopover(opts: { open: false } | ({ open: true } & OldChainsContent)): HTMLElement {
  const popover = fromHtml(STATIC_POPOVER);
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Network');
  popover.tabIndex = -1;
  if (!opts.open) {
    return popover;
  }
  popover.classList.add('open');
  const parent = popover;

  const header = document.createElement('div');
  header.className = 'mode-popover-section';
  header.textContent = 'Network';
  parent.appendChild(header);
  const statusRow = document.createElement('div');
  statusRow.className = 'chains-status';
  const dot = document.createElement('span');
  const text = document.createElement('span');
  statusRow.append(dot, text);
  parent.appendChild(statusRow);
  const { text: label, tone } = describeLiveNetwork(opts.chains);
  dot.className = `chains-status-dot is-${tone}`;
  text.textContent = label;

  for (const chain of opts.chains) {
    const group = document.createElement('div');
    group.className = 'chains-group';
    const name = document.createElement('p');
    name.className = 'chains-group-label';
    const labelText = document.createElement('span');
    labelText.textContent = chain.label;
    const peers = document.createElement('span');
    peers.className = 'chains-group-peers';
    name.append(labelText, peers);
    const cell = document.createElement('div');
    cell.className = 'chains-bars-cell';
    group.append(name, cell);
    parent.appendChild(group);

    if (chain.reachable && chain.peers !== null) {
      peers.textContent = chain.peers === 1 ? '1 peer' : `${String(chain.peers)} peers`;
      peers.setAttribute(
        'aria-label',
        `${chain.label}: ${String(chain.peers)} ${chain.peers === 1 ? 'peer' : 'peers'} connected`,
      );
    }

    if (!chain.reachable) {
      cell.textContent = 'no endpoint on this network';
      cell.classList.add('is-unavailable');
      continue;
    }
    const strip = document.createElement('div');
    strip.className = 'chains-bars';
    cell.replaceChildren(strip);

    if (chain.bars.length === 0) {
      const ghost = document.createElement('span');
      ghost.className = 'chains-bar chains-bar-pending';
      const waiting = document.createElement('span');
      waiting.className = 'chains-bars-waiting';
      strip.replaceChildren(ghost, waiting);
      if (chain.sinceLast === null) {
        ghost.classList.add('is-searching');
        waiting.textContent = chain.phase ?? 'connecting';
        continue;
      }
      const fraction = Math.min(chain.sinceLast / chain.blockTimeMs, 1);
      ghost.style.height = `${String(Math.round(20 + fraction * 80))}%`;
      const leftMs = chain.blockTimeMs - chain.sinceLast;
      if (leftMs > 0) {
        waiting.textContent = `next block in about ${String(Math.ceil(leftMs / 1000))}s`;
      } else {
        waiting.textContent = 'due any moment';
        ghost.classList.add('is-due');
      }
      continue;
    }

    for (const bar of chain.bars) {
      const key = String(bar.number);
      const mark = document.createElement('span');
      mark.dataset['block'] = key;
      mark.className = `chains-bar is-${bar.health}`;
      const delay = describeBlockDelay(bar.gapMs, chain.blockTimeMs);
      mark.title = delay;
      mark.setAttribute('aria-label', `Block ${key}, ${delay}`);
      strip.appendChild(mark);
    }
  }

  const footer = document.createElement('div');
  footer.className = 'chains-transfer';
  const speedRow = document.createElement('p');
  speedRow.className = 'chains-transfer-row';
  const sizeRow = document.createElement('p');
  sizeRow.className = 'chains-transfer-row';
  footer.append(speedRow, sizeRow);
  parent.appendChild(footer);
  if (!opts.productLoaded) {
    const { bytesPerSecond, fetched, total } = opts.transfer;
    if (bytesPerSecond !== null) {
      speedRow.innerHTML =
        `<span class="chains-transfer-label">Speed</span>` +
        `<span class="chains-transfer-value">${escapeHtml(formatRate(bytesPerSecond))}</span>`;
    }
    if (fetched !== null && total !== null && total > 0) {
      const done = fetched >= total;
      sizeRow.innerHTML =
        `<span class="chains-transfer-label">${done ? 'Size' : 'Downloading'}</span>` +
        `<span class="chains-transfer-value">${
          done ? escapeHtml(formatSize(total)) : `${escapeHtml(formatSize(fetched))} / ${escapeHtml(formatSize(total))}`
        }</span>`;
    }
  }

  const tips = document.createElement('div');
  tips.className = 'chains-tips';
  const tipsTitle = document.createElement('p');
  tipsTitle.className = 'chains-tips-title';
  tipsTitle.textContent = 'Tips for better performance';
  const tipsList = document.createElement('ul');
  tipsList.className = 'chains-tips-list';
  for (const tip of ['Close apps and tabs you are not using', 'Move closer to your router']) {
    const item = document.createElement('li');
    item.textContent = tip;
    tipsList.appendChild(item);
  }
  tips.append(tipsTitle, tipsList);
  parent.appendChild(tips);
  return popover;
}
