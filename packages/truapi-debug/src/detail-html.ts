// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Detail-pane HTML builders for the TrUAPI debug panel: single-event
// detail (list/resolution views) and group detail (timeline view).
//
// Solid-free: consumed by the Solid truapi-debug components in
// `packages/ui/src/components/truapi-debug/`, so it must not import
// `@dotli/ui` or `solid-js`. Every product/network value threaded into
// these strings goes through `escapeHtml` before it reaches `innerHTML`.

import { escapeHtml } from '@dotli/shared';
import { decodeChainAnnotations, formatChainLabel, type ChainAnnotations } from './chain-decode.js';
import { summariseChainMessage } from './chain-summary.js';
import {
  correlationKeyOf,
  type EventStore,
  type StoredEvent,
  type StoredSystemEvent,
  type StoredTruapiEvent,
} from './event-store.js';
import { formatPayloadDetail } from './format.js';
import { ridColor, tagClass } from './row-format.js';
import { getSystemExplanation } from './system-explanations.js';
import { summariseSystemEvent } from './system-summary.js';

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function formatLatency(ms: number): string {
  if (ms < 1) {
    return '<1ms';
  }
  if (ms < 1000) {
    return `${String(Math.round(ms))}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * List-view detail: one event's full detail, with clickable pill links
 * to sibling events in the same requestId group so the user can jump
 * between request, response, or subscription receives.
 */
export function renderSingleDetail(ev: StoredEvent, store: EventStore): string {
  if (ev.kind === 'truapi') {
    return renderTruapiSingleDetail(ev, store);
  }
  return renderSystemSingleDetail(ev, store);
}

export function renderTruapiSingleDetail(ev: StoredTruapiEvent, store: EventStore): string {
  const key = ev.requestId;
  const group = store.eventsInGroup(key);
  const first = store.firstInGroup(key);
  const siblings = group.filter(g => g.seq !== ev.seq);
  const groupHtml = renderSiblingsHtml(ev, first, siblings);

  const ridBadge = `<span class="td-rid" style="color:${ridColor(ev.requestId)}">${escapeHtml(ev.requestId.slice(0, 6))}</span>`;
  const chain = decodeChainAnnotations(ev.tag, ev.payload);
  const summarySection = renderSummarySection(chain, ev.payload);
  const chainSection = chain === null ? '' : renderChainSection(chain);

  return (
    `<dl class="td-detail-head">` +
    `<dt>time</dt><dd>${formatTime(ev.receivedAt)}</dd>` +
    `<dt>direction</dt><dd>${ev.direction}</dd>` +
    `<dt>product</dt><dd>${ev.productId === undefined ? '(no id)' : escapeHtml(ev.productId)}</dd>` +
    `<dt>tag</dt><dd>${escapeHtml(ev.tag)}</dd>` +
    `<dt>requestId</dt><dd>${ridBadge} <code>${escapeHtml(ev.requestId)}</code></dd>` +
    `<dt>group</dt><dd>${String(group.length)} event${group.length === 1 ? '' : 's'}${siblings.length > 0 ? ` — ${groupHtml}` : ''}</dd>` +
    `</dl>` +
    summarySection +
    chainSection +
    `<pre class="td-detail-pre">${escapeHtml(formatPayloadDetail(ev.payload))}</pre>`
  );
}

export function renderSystemSingleDetail(ev: StoredSystemEvent, store: EventStore): string {
  const key = ev.flowId;
  const group = store.eventsInGroup(key);
  const first = store.firstInGroup(key);
  const siblings = group.filter(g => g.seq !== ev.seq);
  const groupHtml = renderSiblingsHtml(ev, first, siblings);
  const flowBadge = `<span class="td-rid" style="color:${ridColor(ev.flowId)}">${escapeHtml(ev.flowId.slice(0, 6))}</span>`;
  const summary = summariseSystemEvent(ev);

  return (
    `<dl class="td-detail-head">` +
    `<dt>time</dt><dd>${formatTime(ev.receivedAt)}</dd>` +
    `<dt>source</dt><dd>${ev.source}</dd>` +
    `<dt>layer</dt><dd>${escapeHtml(ev.layer)}</dd>` +
    `<dt>event</dt><dd>${escapeHtml(ev.event)}</dd>` +
    `<dt>flowId</dt><dd>${flowBadge} <code>${escapeHtml(ev.flowId)}</code></dd>` +
    `<dt>group</dt><dd>${String(group.length)} event${group.length === 1 ? '' : 's'}${siblings.length > 0 ? ` — ${groupHtml}` : ''}</dd>` +
    `</dl>` +
    `<div class="td-detail-section-title">Summary</div>` +
    `<div class="td-detail-summary">${escapeHtml(summary)}</div>` +
    renderExplanationSection(ev) +
    `<pre class="td-detail-pre">${escapeHtml(formatPayloadDetail(ev.payload))}</pre>`
  );
}

/**
 * Collapsible "What is this?" section rendered under the one-line
 * summary. Uses native `<details>`/`<summary>` so keyboard + assistive
 * tech work out of the box; CSS styles the disclosure without
 * replacing the native behaviour.
 */
export function renderExplanationSection(ev: StoredSystemEvent): string {
  const explanation = getSystemExplanation(ev.layer, ev.event);
  if (explanation === undefined) {
    return '';
  }
  return (
    `<details class="td-detail-explanation">` +
    `<summary>What is this? — ${escapeHtml(explanation.title)}</summary>` +
    `<div class="td-detail-explanation-body">${renderExplanationBody(explanation.body)}</div>` +
    `</details>`
  );
}

/**
 * Render an explanation body string as HTML. Preserves paragraph
 * breaks (blank lines) and keeps `code` spans with backticks so the
 * prose can reference identifiers without being mistaken for literal
 * text. Plain text otherwise, with no Markdown engine dependency.
 */
export function renderExplanationBody(body: string): string {
  const paragraphs = body.split(/\n\n+/);
  return paragraphs.map(renderExplanationParagraph).join('');
}

export function renderExplanationParagraph(paragraph: string): string {
  // Backticked `identifiers` become <code>identifiers</code>. Bullet lines
  // (`• ` prefix) become list items.
  const lines = paragraph.split('\n');
  const isBulletList = lines.every(l => l.trim().startsWith('• ') || l.trim() === '');
  if (isBulletList) {
    const items = lines
      .filter(l => l.trim() !== '')
      .map(l => {
        const content = l.trim().slice(2);
        return `<li>${formatInlineCode(content)}</li>`;
      })
      .join('');
    return `<ul class="td-detail-explanation-list">${items}</ul>`;
  }
  return `<p>${formatInlineCode(paragraph)}</p>`;
}

export function formatInlineCode(text: string): string {
  // Escape first, then turn escaped backtick runs into <code> spans.
  // Because escaping produces `&#39;`/`&amp;` sequences we keep the
  // backtick search on the escaped string. It still identifies the
  // literal `\`…\`` boundaries.
  const escaped = escapeHtml(text);
  return escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Shared rendering of sibling pills for the single-event detail view. */
export function renderSiblingsHtml(ev: StoredEvent, first: StoredEvent | undefined, siblings: StoredEvent[]): string {
  if (siblings.length === 0) {
    return '(no siblings in buffer)';
  }
  return siblings
    .map(s => {
      const deltaMs = first === undefined ? 0 : s.receivedAt - first.receivedAt;
      const sign = ev.receivedAt > s.receivedAt ? '−' : '+';
      const deltaRelToSelected = Math.abs(s.receivedAt - ev.receivedAt);
      const label =
        s.kind === 'truapi'
          ? `${escapeHtml(s.tag)} ${sign}${formatLatency(deltaRelToSelected)}`
          : `${escapeHtml(s.layer)}.${escapeHtml(s.event)} ${sign}${formatLatency(deltaRelToSelected)}`;
      return (
        `<span class="td-detail-pair" data-seq="${String(s.seq)}"` +
        ` title="seq ${String(s.seq)} · +${formatLatency(deltaMs)} from start">` +
        label +
        `</span>`
      );
    })
    .join(' · ');
}

/**
 * Human-readable one-liner describing what a chain message does. Shown
 * at the top of the detail pane so the reader doesn't have to parse
 * the JSON payload to understand the message intent.
 */
export function renderSummarySection(chain: ChainAnnotations | null, payload: unknown): string {
  if (chain === null) {
    return '';
  }
  const summary = summariseChainMessage(chain, payload);
  if (summary === null) {
    return '';
  }
  return (
    `<div class="td-detail-section-title">Summary</div>` + `<div class="td-detail-summary">${escapeHtml(summary)}</div>`
  );
}

/**
 * Timeline-view detail: every member of the clicked box's requestId
 * group, stacked chronologically. Each member shows its decoded chain
 * annotations (if any) and its payload. Since all siblings are visible
 * together, no cross-link pills are needed. Clicking a box is a
 * "show me the whole handshake" action, not a "pick one message" one.
 */
export function renderGroupDetail(ev: StoredEvent, store: EventStore): string {
  const key = correlationKeyOf(ev);
  const group = store.eventsInGroup(key);
  const first = store.firstInGroup(key);
  const keyBadge = `<span class="td-rid" style="color:${ridColor(key)}">${escapeHtml(key.slice(0, 6))}</span>`;

  const last = group.length > 0 ? group[group.length - 1] : undefined;
  const durationRow =
    first !== undefined && last !== undefined && first.seq !== last.seq
      ? `<dt>duration</dt><dd>${formatLatency(last.receivedAt - first.receivedAt)}</dd>`
      : '';

  const headerRows: string[] = [];
  if (ev.kind === 'truapi') {
    headerRows.push(
      `<dt>requestId</dt><dd>${keyBadge} <code>${escapeHtml(ev.requestId)}</code></dd>`,
      `<dt>product</dt><dd>${ev.productId === undefined ? '(no id)' : escapeHtml(ev.productId)}</dd>`,
    );
  } else {
    headerRows.push(
      `<dt>flowId</dt><dd>${keyBadge} <code>${escapeHtml(ev.flowId)}</code></dd>`,
      `<dt>source</dt><dd>${ev.source}</dd>`,
      `<dt>layer</dt><dd>${escapeHtml(ev.layer)}</dd>`,
    );
  }
  headerRows.push(`<dt>group</dt><dd>${String(group.length)} event${group.length === 1 ? '' : 's'}</dd>`);
  if (durationRow !== '') {
    headerRows.push(durationRow);
  }
  const header = `<dl class="td-detail-head">${headerRows.join('')}</dl>`;

  const members = group
    .map(m => {
      const deltaMs = first === undefined ? 0 : m.receivedAt - first.receivedAt;
      const deltaLabel =
        first !== undefined && first.seq !== m.seq ? `<span class="td-latency">+${formatLatency(deltaMs)}</span>` : '';
      return m.kind === 'truapi' ? renderTruapiMemberBlock(m, deltaLabel) : renderSystemMemberBlock(m, deltaLabel);
    })
    .join('');

  return header + members;
}

export function renderTruapiMemberBlock(m: StoredTruapiEvent, deltaLabel: string): string {
  const arrow =
    m.direction === 'outgoing' ? `<span class="td-arrow-out">▶</span>` : `<span class="td-arrow-in">◀</span>`;
  const chain = decodeChainAnnotations(m.tag, m.payload);
  const summaryBlock = renderSummarySection(chain, m.payload);
  const chainBlock = chain === null ? '' : renderChainSection(chain);
  return (
    `<div class="td-detail-member" data-seq="${String(m.seq)}">` +
    `<div class="td-detail-member-header">` +
    `<span class="td-time">${formatTime(m.receivedAt)}</span> ` +
    arrow +
    ` <span class="${tagClass(m.tag)}">${escapeHtml(m.tag)}</span> ` +
    deltaLabel +
    `</div>` +
    summaryBlock +
    chainBlock +
    `<pre class="td-detail-pre">${escapeHtml(formatPayloadDetail(m.payload))}</pre>` +
    `</div>`
  );
}

export function renderSystemMemberBlock(m: StoredSystemEvent, deltaLabel: string): string {
  const summary = summariseSystemEvent(m);
  return (
    `<div class="td-detail-member" data-seq="${String(m.seq)}">` +
    `<div class="td-detail-member-header">` +
    `<span class="td-time">${formatTime(m.receivedAt)}</span> ` +
    `<span class="td-layer-badge td-layer-${m.layer}">${escapeHtml(m.layer)}</span> ` +
    `<span class="td-tag td-tag-sys">${escapeHtml(m.event)}</span> ` +
    deltaLabel +
    `</div>` +
    `<div class="td-detail-summary">${escapeHtml(summary)}</div>` +
    renderExplanationSection(m) +
    `<pre class="td-detail-pre">${escapeHtml(formatPayloadDetail(m.payload))}</pre>` +
    `</div>`
  );
}

/**
 * Chain-specific annotation block rendered above the raw payload in
 * the detail pane. Exists to surface the JSON-RPC correlation keys
 * (genesisHash, followSubscriptionId, operationId, blockHash, event
 * tag, outcome) that are buried inside the payload and would otherwise
 * require the reader to mentally parse the pretty-printed JSON.
 */
export function renderChainSection(ann: ChainAnnotations): string {
  const rows: string[] = [];
  rows.push(`<dt>method</dt><dd>${escapeHtml(formatChainLabel(ann))}</dd>`);
  if (ann.chainEventTag !== undefined) {
    rows.push(`<dt>event</dt><dd>${escapeHtml(ann.chainEventTag)}</dd>`);
  }
  if (ann.genesisHash !== undefined) {
    rows.push(`<dt>genesis</dt><dd><code>${escapeHtml(ann.genesisHash)}</code></dd>`);
  }
  if (ann.followSubscriptionId !== undefined) {
    rows.push(`<dt>followSub</dt><dd><code>${escapeHtml(ann.followSubscriptionId)}</code></dd>`);
  }
  if (ann.operationId !== undefined) {
    rows.push(`<dt>opId</dt><dd><code>${escapeHtml(ann.operationId)}</code></dd>`);
  }
  if (ann.blockHash !== undefined) {
    rows.push(`<dt>blockHash</dt><dd><code>${escapeHtml(ann.blockHash)}</code></dd>`);
  }
  if (ann.outcome !== undefined) {
    const outcomeClass = ann.outcome === 'error' ? 'td-outcome-err' : 'td-outcome-ok';
    const outcomeText =
      ann.outcome === 'error' && ann.errorMessage !== undefined ? `error: ${ann.errorMessage}` : ann.outcome;
    rows.push(`<dt>outcome</dt><dd class="${outcomeClass}">${escapeHtml(outcomeText)}</dd>`);
  }
  return (
    `<div class="td-detail-section-title">Chain</div>` +
    `<dl class="td-detail-head td-chain-head">${rows.join('')}</dl>`
  );
}
