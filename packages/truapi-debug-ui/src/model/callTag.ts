// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Calls are paired on the tag suffix, not `direction`, which depends on who initiated the call.

/** The role a suffix gives its tag in the call. */
export type TagSuffixKind = TagSuffix['kind'];

type TagSuffix = (typeof TAG_SUFFIXES)[number];

// No suffix ends with another, so a tag matches one entry at most. `closesCall` marks a suffix that ends its call,
// from either side.
const TAG_SUFFIXES = [
  { suffix: '_request', kind: 'request', closesCall: false },
  { suffix: '_start', kind: 'request', closesCall: false },
  { suffix: '_submit', kind: 'request', closesCall: false },
  { suffix: '_response', kind: 'response', closesCall: true },
  { suffix: '_receive', kind: 'subscription', closesCall: false },
  { suffix: '_interrupt', kind: 'subscription', closesCall: true },
  { suffix: '_stop', kind: 'subscription', closesCall: true },
  { suffix: '_subscribe', kind: 'subscription', closesCall: false },
] as const;

/** Whether `tag` names a call's request. Never throws. */
export function isRequestTag(tag: string): boolean {
  return findTagSuffix(tag)?.suffix === '_request';
}

/** Whether `tag` names a call's reply. Never throws. */
export function isResponseTag(tag: string): boolean {
  return findTagSuffix(tag)?.suffix === '_response';
}

/** Whether `tag` ends its call, as a reply, a stop or an interrupt does. Never throws. */
export function isClosingTag(tag: string): boolean {
  return findTagSuffix(tag)?.closesCall === true;
}

/** The role `tag`'s suffix gives it in its call, or null when it carries no call suffix. Never throws. */
export function getTagSuffixKind(tag: string): TagSuffixKind | null {
  return findTagSuffix(tag)?.kind ?? null;
}

/** `tag` without its call suffix, or `tag` itself when it carries none. Never throws. */
export function stripTagSuffix(tag: string): string {
  const match = findTagSuffix(tag);
  if (match === undefined) {
    return tag;
  }
  return tag.slice(0, -match.suffix.length);
}

function findTagSuffix(tag: string): TagSuffix | undefined {
  return TAG_SUFFIXES.find(entry => tag.endsWith(entry.suffix));
}
