// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product card's author: the product's dotNS owner, the account Asset Hub maps it to, and the usernames People
// holds for that account.

import { createReporter } from '@dotli/metrics';
import { createAsyncTaskPool } from '@dotli/shared';
import type { H160Address } from './h160Address.js';
import type { PolkadotAccount } from './runtime/polkadotAccount.js';
import type { PeopleUsernames } from './runtime/readPeopleUsernames.js';
import { productAuthorMetric } from './productAuthorMetric.js';

const resolveReport = createReporter({ flow: 'resolve' });

export type AuthorReadStep = 'account' | 'username';

export type AuthorUsername = { name: string; kind: 'full' | 'lite' };

export type ProductAuthor = {
  /** The mapped Polkadot account, or the owner's address while it has none. */
  address: PolkadotAccount | H160Address;
  username: AuthorUsername | null;
};

export type ProductAuthorResult = { kind: 'found'; author: ProductAuthor } | { kind: 'none' };

type Params = {
  /** The loaded product's owner, null when the name has none or the load could not read it. Never throws. */
  readOwner: () => H160Address | null;
  /** The account Asset Hub maps the address to, null when it has none. Rejects when Asset Hub cannot be read. */
  readAccount: (address: H160Address) => Promise<PolkadotAccount | null>;
  /** The usernames People holds for the account, null when it has none. Rejects when People cannot be read. */
  readUsernames: (account: PolkadotAccount) => Promise<PeopleUsernames | null>;
  /** Reports a read that failed. Never throws. */
  report?: (error: unknown, read: AuthorReadStep) => void;
};

type CreateHeldReadParams<Input, Value> = {
  /** Rejects when the source cannot be read. */
  read: (input: Input) => Promise<Value>;
  /** The step a failed read is reported as. */
  step: AuthorReadStep;
  /** Never throws. */
  report: NonNullable<Params['report']>;
};

/** Returns the author read of one product, which reads each part until it answers once. */
export function createProductAuthor({ readOwner, readAccount, readUsernames, report = reportAuthorRead }: Params) {
  // One read at a time, so a card opened meanwhile takes the running read's answer.
  const reads = createAsyncTaskPool({ poolSize: 1 });
  const account = createHeldRead({ read: readAccount, step: 'account', report });
  const usernames = createHeldRead({ read: readUsernames, step: 'username', report });
  // The last answer and what it was built from, so a load that finds each part as it was returns the same object.
  let last:
    | {
        owner: H160Address | null;
        mapped: PolkadotAccount | null | undefined;
        usernames: PeopleUsernames | null | undefined;
        result: ProductAuthorResult;
      }
    | undefined;

  async function readAuthor(): Promise<ProductAuthorResult> {
    const owner = readOwner();
    if (owner !== null) {
      await account.load(owner);
    }
    const mapped = account.get();
    if (typeof mapped === 'string') {
      await usernames.load(mapped);
    }
    const held = usernames.get();
    // The owner is never undefined, so the first load, which has no last answer, builds one.
    if (last?.owner !== owner || last.mapped !== mapped || last.usernames !== held) {
      last = { owner, mapped, usernames: held, result: buildResult(owner, mapped, held) };
    }
    return last.result;
  }

  return {
    /**
     * Settles with the author, and `none` when the product has no known owner. A failed mapping or usernames read
     * settles with less of the author. Reads only what no earlier load answered. Settles with the same object while
     * nothing new was read. Never rejects.
     */
    load(): Promise<ProductAuthorResult> {
      return reads.call(readAuthor);
    },
  };
}

/** Keeps a read's answer once it settled without error, and reports a failed read so the next load reads again. */
function createHeldRead<Input, Value>({ read, step, report }: CreateHeldReadParams<Input, Value>) {
  // Undefined until the read answers. A failed read tells nothing, so it is read again.
  let answer: { value: Value } | undefined;

  return {
    /** The held answer, undefined while the read has not answered. */
    get(): Value | undefined {
      return answer?.value;
    },
    /** Reads unless an answer is held. Never rejects: a failed read is reported and leaves nothing held. */
    async load(input: Input): Promise<void> {
      if (answer !== undefined) {
        return;
      }
      try {
        answer = { value: await read(input) };
      } catch (error) {
        report(error, step);
      }
    },
  };
}

/** Builds the author from what the held reads answered, undefined for a read that has not. */
function buildResult(
  owner: H160Address | null,
  mapped: PolkadotAccount | null | undefined,
  usernames: PeopleUsernames | null | undefined,
): ProductAuthorResult {
  if (owner === null) {
    return { kind: 'none' };
  }
  if (typeof mapped !== 'string') {
    return { kind: 'found', author: { address: owner, username: null } };
  }
  return { kind: 'found', author: { address: mapped, username: getUsername(usernames) } };
}

function getUsername(usernames: PeopleUsernames | null | undefined): AuthorUsername | null {
  if (usernames === null || usernames === undefined) {
    return null;
  }
  if (usernames.full !== null && usernames.full !== '') {
    return { name: usernames.full, kind: 'full' };
  }
  if (usernames.lite !== '') {
    return { name: usernames.lite, kind: 'lite' };
  }
  return null;
}

function reportAuthorRead(error: unknown, read: AuthorReadStep): void {
  resolveReport.expected(error, { step: `product_author_${read}`, metric: productAuthorMetric, reason: read });
}
