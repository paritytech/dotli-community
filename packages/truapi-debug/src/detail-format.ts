// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Must not import `@dotli/ui` or `solid-js`. Returns plain data that the components render as JSX text.

import { decodeChainAnnotations, formatChainLabel, type ChainAnnotations } from './chain-decode.js';
import { summariseChainMessage } from './chain-summary.js';
import type { EventSeq, StoredEvent, StoredSystemEvent } from './event-store.js';
import { getSystemExplanation } from './system-explanations.js';

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

export function eventCountLabel(count: number): string {
  return `${String(count)} event${count === 1 ? '' : 's'}`;
}

interface SiblingPill {
  seq: EventSeq;
  label: string;
  title: string;
}

export function siblingPills(ev: StoredEvent, first: StoredEvent | undefined, siblings: StoredEvent[]): SiblingPill[] {
  return siblings.map(s => {
    const deltaMs = first === undefined ? 0 : s.receivedAt - first.receivedAt;
    const sign = ev.receivedAt > s.receivedAt ? '−' : '+';
    const offset = `${sign}${formatLatency(Math.abs(s.receivedAt - ev.receivedAt))}`;
    const name = s.kind === 'truapi' ? s.tag : `${s.layer}.${s.event}`;
    return {
      seq: s.seq,
      label: `${name} ${offset}`,
      title: `seq ${String(s.seq)} · +${formatLatency(deltaMs)} from start`,
    };
  });
}

/** `+12ms` from the group's first event, or null for the first event itself. */
export function memberDelta(m: StoredEvent, first: StoredEvent | undefined): string | null {
  if (first === undefined || first.seq === m.seq) {
    return null;
  }
  return `+${formatLatency(m.receivedAt - first.receivedAt)}`;
}

export function groupDuration(first: StoredEvent | undefined, group: readonly StoredEvent[]): string | null {
  const last = group.length > 0 ? group[group.length - 1] : undefined;
  if (first === undefined || last === undefined || first.seq === last.seq) {
    return null;
  }
  return formatLatency(last.receivedAt - first.receivedAt);
}

export interface InlineSegment {
  code: boolean;
  text: string;
}

/** Split text on backticked `identifiers` without a Markdown engine. A lone backtick stays literal. */
function formatInlineCode(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    if (match.index > last) {
      segments.push({ code: false, text: text.slice(last, match.index) });
    }
    segments.push({ code: true, text: match[1] ?? '' });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    segments.push({ code: false, text: text.slice(last) });
  }
  return segments;
}

type ExplanationBlock = { kind: 'paragraph'; segments: InlineSegment[] } | { kind: 'list'; items: InlineSegment[][] };

interface ExplanationDetail {
  title: string;
  blocks: ExplanationBlock[];
}

export function explanationDetail(ev: StoredSystemEvent): ExplanationDetail | undefined {
  const explanation = getSystemExplanation(ev.layer, ev.event);
  if (explanation === undefined) {
    return undefined;
  }
  return { title: explanation.title, blocks: explanation.body.split(/\n\n+/).map(explanationBlock) };
}

function explanationBlock(paragraph: string): ExplanationBlock {
  const lines = paragraph.split('\n');
  const isBulletList = lines.every(l => l.trim().startsWith('• ') || l.trim() === '');
  if (isBulletList) {
    return {
      kind: 'list',
      items: lines.filter(l => l.trim() !== '').map(l => formatInlineCode(l.trim().slice(2))),
    };
  }
  return { kind: 'paragraph', segments: formatInlineCode(paragraph) };
}

interface ChainField {
  name: string;
  value: string;
  code: boolean;
}

export interface ChainDetail {
  summary: string | null;
  fields: ChainField[];
}

/** The correlation keys buried in a `remote_chain_*` payload. Null for any other message. */
export function chainDetail(tag: string, payload: unknown): ChainDetail | null {
  const ann = decodeChainAnnotations(tag, payload);
  if (ann === null) {
    return null;
  }
  return { summary: summariseChainMessage(ann, payload), fields: chainFields(ann) };
}

function chainFields(ann: ChainAnnotations): ChainField[] {
  const fields: ChainField[] = [{ name: 'method', value: formatChainLabel(ann), code: false }];
  if (ann.chainEventTag !== undefined) {
    fields.push({ name: 'event', value: ann.chainEventTag, code: false });
  }
  const ids: [string, string | undefined][] = [
    ['genesis', ann.genesisHash],
    ['followSub', ann.followSubscriptionId],
    ['opId', ann.operationId],
    ['blockHash', ann.blockHash],
  ];
  for (const [name, value] of ids) {
    if (value !== undefined) {
      fields.push({ name, value, code: true });
    }
  }
  if (ann.outcome !== undefined) {
    fields.push({
      name: 'outcome',
      value: ann.outcome === 'error' && ann.errorMessage !== undefined ? `error: ${ann.errorMessage}` : ann.outcome,
      code: false,
    });
  }
  return fields;
}
