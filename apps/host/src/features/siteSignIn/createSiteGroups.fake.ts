// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SiteGroups } from './createSiteGroups.js';
import { parsePublicSuffixList } from './parsePublicSuffixList.js';

/** A few rules of the Public Suffix List, a private one included. */
const SUFFIXES = parsePublicSuffixList('com\nio\ngithub.io\nli\nbg\n0.bg\n');

/** The registrable domains of a few suffix rules, as the window's loaded list gives them. */
export const SITE_GROUPS: SiteGroups = { registrable: hostname => Promise.resolve(SUFFIXES.registrable(hostname)) };
