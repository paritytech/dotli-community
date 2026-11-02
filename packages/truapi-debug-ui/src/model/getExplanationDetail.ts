// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so it runs under Node. Returns plain data that the components render as JSX text.

import { getSystemExplanation } from './getSystemExplanation.js';
import type { StoredSystemEvent } from './storedEvent.js';

export type InlineSegment = {
  code: boolean;
  text: string;
};

export type ExplanationBlock =
  { kind: 'paragraph'; segments: InlineSegment[] } | { kind: 'list'; items: InlineSegment[][] };

type ExplanationDetail = {
  title: string;
  blocks: ExplanationBlock[];
};

/** A host event's explanation as paragraphs and bullet lists, or undefined for an event without one. Never throws. */
export function getExplanationDetail(event: StoredSystemEvent): ExplanationDetail | undefined {
  const explanation = getSystemExplanation(event);
  if (explanation === undefined) {
    return undefined;
  }
  return { title: explanation.title, blocks: explanation.body.split(/\n\n+/).map(toExplanationBlock) };
}

function toExplanationBlock(paragraph: string): ExplanationBlock {
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
