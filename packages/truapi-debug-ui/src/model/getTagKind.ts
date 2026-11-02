// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getTagSuffixKind, type TagSuffixKind } from './callTag.js';

export type TagKind = TagSuffixKind | 'plain';

/** The role a TrUAPI tag plays in its call, read from its suffix. Never throws. */
export function getTagKind(tag: string): TagKind {
  return getTagSuffixKind(tag) ?? 'plain';
}
