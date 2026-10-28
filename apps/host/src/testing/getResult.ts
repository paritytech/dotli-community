// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SiteRoundPost } from '../runtime/sessionHandoff/createResponder.fake.js';

/** The one result the site got. Throws when the site got anything else. */
export function getResult(posts: SiteRoundPost[]): Extract<SiteRoundPost, { type: 'dotli:s:result' }> {
  const [post] = posts;
  if (post?.type !== 'dotli:s:result') {
    throw new Error(`Expected one result, got ${JSON.stringify(posts)}`);
  }
  return post;
}
