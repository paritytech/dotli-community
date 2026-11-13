// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The loading screen's copy for each stage of the story.

import { getActiveTldSuffix } from '@dotli/config';
import type { LoadingStage } from './createLoadingController.js';
import type { StepPart } from './state/loadingState.js';

/** What the screen shows for one stage. */
type StageLines = {
  /** The step line, up for the whole stage. */
  step: StepPart[];
  /** The step line as one sentence, for screen readers. */
  srText: string;
  /** The explanations a slow stage turns over. */
  explanations: readonly string[];
};

const DOMAIN_TOKEN = '{domain}';

/**
 * The first line is the step line, up for the whole stage. The rest are explanations only a slow load
 * reaches, as many as the step runs long, so the long ones do not repeat.
 */
const STAGE_MESSAGES: Record<LoadingStage, readonly [string, string, ...string[]]> = {
  starting: [
    'Reaching out',
    'This page comes from a network, with no one in between',
    'That takes a few seconds the first time',
  ],
  relay: [
    'Connecting to Polkadot',
    'Looking for other computers to talk to',
    'Your browser does the checking itself, not a server',
  ],
  assetHub: [
    `Looking up ${DOMAIN_TOKEN}`,
    'Catching up on the newest blocks',
    'The network itself decides where this name points',
    'This is the slow part, and it is faster next time',
  ],
  resolving: ['Found it', 'Reading where the name points', 'The network proved this answer, so it cannot be faked'],
  content: [
    'Downloading the app',
    'The files come from many computers at once',
    'The more of them are nearby, the faster this goes',
    'Every piece is checked against its fingerprint as it lands',
    'No single computer holds the app, so no one can take it down',
    'Bigger apps take longer the first time',
    'Your browser keeps a copy, so the next visit is quick',
  ],
  preparing: ['Got everything', 'Unpacking the files', 'Handing over to the app', 'Almost there'],
};

/**
 * Returns what the screen shows for `stage` while it loads `domain`. An empty `domain` reads as "the name", as on the
 * preview and local-target paths, which have no dotNS name. Never throws.
 */
export function getStageLines(stage: LoadingStage, domain: string): StageLines {
  const [opening, ...explanations] = STAGE_MESSAGES[stage];
  const at = opening.indexOf(DOMAIN_TOKEN);
  const name: StepPart = domain === '' ? 'the name' : { host: domain, tld: getActiveTldSuffix() };
  const step =
    at === -1
      ? [opening]
      : [opening.slice(0, at), name, opening.slice(at + DOMAIN_TOKEN.length)].filter(part => part !== '');
  return {
    step,
    srText: step.map(part => (typeof part === 'string' ? part : `${part.host}${part.tld}`)).join(''),
    explanations,
  };
}
