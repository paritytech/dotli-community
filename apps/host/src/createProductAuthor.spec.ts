// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { parseH160Address, type H160Address } from './h160Address.js';
import { createProductAuthor, type AuthorReadStep, type ProductAuthorResult } from './createProductAuthor.js';
import { parsePolkadotAccount, type PolkadotAccount } from './runtime/polkadotAccount.js';
import type { PeopleUsernames } from './runtime/readPeopleUsernames.js';

type Reads = {
  /** The loaded product's owner. */
  owner?: H160Address | null;
  /** The Asset Hub mapping read. */
  account?: (address: H160Address) => Promise<PolkadotAccount | null>;
  /** The People usernames read. */
  usernames?: (account: PolkadotAccount) => Promise<PeopleUsernames | null>;
};

type SettledRow = {
  reads: Reads;
  answer: ProductAuthorResult;
  calls: { account: number; usernames: number };
};

const OWNER = parseH160Address(`0x${'ab'.repeat(20)}`);
const ACCOUNT = parsePolkadotAccount('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
const USERNAMES: PeopleUsernames = { full: 'alice', lite: 'alice.42' };

/** An author over reads that answer with `reads`, the owner, its mapped account and its usernames by default. */
function createAuthor({
  owner = OWNER,
  account = () => Promise.resolve(ACCOUNT),
  usernames = () => Promise.resolve(USERNAMES),
}: Reads = {}) {
  const reports: [AuthorReadStep, unknown][] = [];
  const params = {
    readOwner: () => owner,
    readAccount: vi.fn(account),
    readUsernames: vi.fn(usernames),
    report: (error: unknown, read: AuthorReadStep) => {
      reports.push([read, error]);
    },
  };
  return { ...params, reports, author: createProductAuthor(params) };
}

function answerWith<Value>(value: Value): () => Promise<Value> {
  return () => Promise.resolve(value);
}

describe('product author', () => {
  it.each<[string, string, SettledRow]>([
    [
      'is not registered',
      'no author',
      {
        reads: { owner: null },
        answer: { kind: 'none' },
        calls: { account: 0, usernames: 0 },
      },
    ],
    [
      'has no mapped account',
      "the owner's address",
      {
        reads: { account: answerWith(null) },
        answer: { kind: 'found', author: { address: OWNER, username: null } },
        calls: { account: 1, usernames: 0 },
      },
    ],
    [
      'has no usernames',
      'the account with no username',
      {
        reads: { usernames: answerWith(null) },
        answer: { kind: 'found', author: { address: ACCOUNT, username: null } },
        calls: { account: 1, usernames: 1 },
      },
    ],
    [
      'has only empty usernames',
      'the account with no username',
      {
        reads: { usernames: answerWith({ full: '', lite: '' }) },
        answer: { kind: 'found', author: { address: ACCOUNT, username: null } },
        calls: { account: 1, usernames: 1 },
      },
    ],
    [
      'has a full username',
      'the full username',
      {
        reads: {},
        answer: { kind: 'found', author: { address: ACCOUNT, username: { name: 'alice', kind: 'full' } } },
        calls: { account: 1, usernames: 1 },
      },
    ],
    [
      'has only a lite username',
      'the lite username',
      {
        reads: { usernames: answerWith({ full: null, lite: 'alice.42' }) },
        answer: { kind: 'found', author: { address: ACCOUNT, username: { name: 'alice.42', kind: 'lite' } } },
        calls: { account: 1, usernames: 1 },
      },
    ],
    [
      'has an empty full username',
      'the lite username',
      {
        reads: { usernames: answerWith({ full: '', lite: 'alice.42' }) },
        answer: { kind: 'found', author: { address: ACCOUNT, username: { name: 'alice.42', kind: 'lite' } } },
        calls: { account: 1, usernames: 1 },
      },
    ],
  ])('As a visitor, I open the card of a product whose owner %s and see %s', async (_owner, _seen, row) => {
    // Given reads that settle as the row says
    const { author, readAccount, readUsernames, reports } = createAuthor(row.reads);

    // When the card loads its author
    const result = await author.load();

    // Then the answer matches and each read ran only as far as the answer needed
    expect(result).toEqual(row.answer);
    expect(readAccount).toHaveBeenCalledTimes(row.calls.account);
    expect(readUsernames).toHaveBeenCalledTimes(row.calls.usernames);
    expect(reports).toEqual([]);
  });

  it("As a visitor, I open the card while Asset Hub is unreachable and see the owner's address, then the next opening reads only the mapping again", async () => {
    // Given a mapping read that fails once
    const { author, readAccount, readUsernames, reports } = createAuthor();
    const accountError = new Error('Asset Hub unreachable');
    readAccount.mockRejectedValueOnce(accountError);

    // When the card opens twice
    const first = await author.load();
    const second = await author.load();

    // Then the first answer has the owner's address and was reported, and the second read only the mapping again
    expect(first).toEqual({ kind: 'found', author: { address: OWNER, username: null } });
    expect(reports).toEqual([['account', accountError]]);
    expect(second).toEqual({
      kind: 'found',
      author: { address: ACCOUNT, username: { name: 'alice', kind: 'full' } },
    });
    expect(readAccount).toHaveBeenCalledTimes(2);
    expect(readUsernames).toHaveBeenCalledTimes(1);
  });

  it('As a visitor, I open the card while People is unreachable and see the account, then the next opening reads only the usernames again', async () => {
    // Given a usernames read that fails once
    const { author, readAccount, readUsernames, reports } = createAuthor();
    const usernamesError = new Error('People unreachable');
    readUsernames.mockRejectedValueOnce(usernamesError);

    // When the card opens twice
    const first = await author.load();
    const second = await author.load();

    // Then the first answer has the account and was reported, and the second read only the usernames again
    expect(first).toEqual({ kind: 'found', author: { address: ACCOUNT, username: null } });
    expect(reports).toEqual([['username', usernamesError]]);
    expect(second).toEqual({
      kind: 'found',
      author: { address: ACCOUNT, username: { name: 'alice', kind: 'full' } },
    });
    expect(readAccount).toHaveBeenCalledTimes(1);
    expect(readUsernames).toHaveBeenCalledTimes(2);
  });

  it('As a visitor, I open the card on the desktop and the phone at once and the author is read once', async () => {
    // Given reads held until the network answers
    const account = Promise.withResolvers<PolkadotAccount | null>();
    const usernames = Promise.withResolvers<PeopleUsernames | null>();
    const { author, readAccount, readUsernames } = createAuthor({
      account: () => account.promise,
      usernames: () => usernames.promise,
    });

    // When two cards load while the reads are held, then the network answers
    const loads = Promise.all([author.load(), author.load()]);
    account.resolve(ACCOUNT);
    usernames.resolve(USERNAMES);
    const [desktop, phone] = await loads;

    // Then both get the same author and each read ran once
    expect(desktop).toEqual({
      kind: 'found',
      author: { address: ACCOUNT, username: { name: 'alice', kind: 'full' } },
    });
    expect(phone).toEqual(desktop);
    expect(readAccount).toHaveBeenCalledTimes(1);
    expect(readUsernames).toHaveBeenCalledTimes(1);
  });

  it('As a visitor, I open the card again after it settled and nothing is read again', async () => {
    // Given an author that settled once
    const { author, readAccount, readUsernames } = createAuthor();
    const first = await author.load();

    // When the card opens again
    const second = await author.load();

    // Then the same author comes back and no read ran again
    expect(second).toBe(first);
    expect(readAccount).toHaveBeenCalledTimes(1);
    expect(readUsernames).toHaveBeenCalledTimes(1);
  });
});
