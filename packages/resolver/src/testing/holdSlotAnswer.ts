// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createDeferred } from '@dotli/shared';
import { CONTRACT_ACCOUNT_INFO } from './constants.js';
import type { FakeFollow } from './createFakeSubstrateClient.js';

type SlotAnswerHold = {
  /** Resolves once the slot is asked for. */
  slotAsked: Promise<undefined>;
  /** Answers the held slot request with an unset slot. */
  answerSlot: () => void;
};

/** Answers a contract's account info on `follow`, then holds the slot answer until the test releases it. */
export function holdSlotAnswer(follow: FakeFollow): SlotAnswerHold {
  const asked = createDeferred<undefined>();
  const answer = createDeferred<string | null>();
  follow.storage
    .mockImplementationOnce(() => Promise.resolve(CONTRACT_ACCOUNT_INFO))
    .mockImplementationOnce(() => {
      asked.resolve(undefined);
      return answer.promise;
    });
  return {
    slotAsked: asked.promise,
    answerSlot: () => {
      answer.resolve(null);
    },
  };
}
