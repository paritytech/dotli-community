// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's transaction, the action a site's round runs on the sign route. It opens Asset Hub as the round starts,
// before the user's grant, decodes the site's call for the review, and once the user confirms, has the phone sign it
// as the product account the site names. Nothing reaches the phone before Confirm, so the account's key is read from
// the phone only after it. The site gets the signed transaction to send itself, and the window never sends it.
// Nothing of the main account reaches the site.

import { createReporter, defineCount } from '@dotli/metrics';
import { computed } from 'nanostores';
import {
  createStateMachine,
  isShallowEqual,
  toHex,
  type HandlerOf,
  type MachineTypes,
  type Transition,
} from '@dotli/shared';
import type { MainAccount } from './mainAccount.js';
import { toDisplayAccount } from './toDisplayAccount.js';
import { SiteChainError, type SiteChain, type SiteChainSession, type SiteDecodedCall } from './createSiteChain.js';
import {
  createSiteRound,
  type SiteAction,
  type SiteActionState,
  type SiteRound,
  type SiteRoundParams,
} from './createSiteRound.js';
import { SITE_ROUTE_METRICS } from './siteRouteMetrics.js';
import { reportSiteFailure } from './reportSiteFailure.js';
import { SiteRoundFailure, SiteRoundRefusal } from './siteRoundErrors.js';
import type { SiteSignRequest } from './parseSiteSignRequest.js';
import { SiteAccountRejectedError, type SiteAccountReader } from './createSiteAccountReader.js';
import { SiteTxError, type SiteTxSigner } from './createSiteTxSigner.js';

const report = createReporter({ flow: 'wallet' });

/** Count. A transition of a site's transaction threw, a bug. Tagged `outcome` (error) and `reason` (the error's name). */
const siteTransactionTransitionMetric = defineCount<'error'>('session_pages.site_transaction_transition');

/** What the site gets for its transaction: the signed transaction, in lowercase `0x` hex. */
export type SiteTransactionResult = {
  transaction: string;
};

type CreateSiteTransactionParams = Omit<SiteRoundParams<SiteTransactionResult, 'signed'>, 'action' | 'request'> & {
  request: SiteSignRequest;
  /** The site's call, from its request or its payload. */
  call: Uint8Array;
  /** Asset Hub, which decodes the call and builds its transaction. */
  chain: SiteChain;
  /** Signs the call as the account the site names. */
  txSigner: SiteTxSigner;
  /** Reads the key of the account the site names. */
  accountReader: Pick<SiteAccountReader, 'account'>;
};

type CreateSiteTransactionActionParams = Pick<
  CreateSiteTransactionParams,
  'origin' | 'call' | 'chain' | 'txSigner' | 'accountReader'
> & {
  /** The product account that signs the call, and the genesis of the Asset Hub the site asked for. */
  request: Pick<SiteSignRequest, 'account' | 'chain'>;
};

/**
 * The named account's key once read for a main account, which a Try again for that main account uses rather than
 * asking the phone again. Another main account derives another key.
 */
type ReadKey = {
  owner: string;
  key: Uint8Array;
};

/** One run of the action for a main account. */
type Run = {
  main: MainAccount;
  readKey: ReadKey | null;
};

/** What a run holds once the site's call is decoded on its chain session. */
type DecodedRun = {
  run: Run;
  session: SiteChainSession;
  decoded: SiteDecodedCall;
};

/** How an open of Asset Hub ends. */
type ChainEvent =
  { kind: 'chainOpened'; session: SiteChainSession } | { kind: 'chainFailed'; failure: SiteRoundFailure };

/**
 * Where the transaction is. `prepared` waits for the open the round started before the user's grant, and `opened` or
 * `openFailed` keeps how it ended until the first run takes it. `closing` waits for an open the round no longer needs,
 * to close its session. Every `failed` carries the key its run read, so a Try again for the same main account skips the
 * phone.
 */
type TransactionState =
  | { kind: 'idle' }
  | { kind: 'prepared' }
  | { kind: 'opened'; session: SiteChainSession }
  | { kind: 'openFailed'; failure: SiteRoundFailure }
  | { kind: 'opening'; run: Run }
  | { kind: 'decoding'; run: Run; session: SiteChainSession }
  | (DecodedRun & { kind: 'reviewing' })
  | (DecodedRun & { kind: 'sharing' })
  | (DecodedRun & { kind: 'building' })
  | (DecodedRun & { kind: 'approving' })
  | { kind: 'done'; result: SiteTransactionResult }
  | { kind: 'refused'; refusal: SiteRoundRefusal }
  | { kind: 'rejected' }
  | { kind: 'failed'; failure: SiteRoundFailure; readKey: ReadKey | null }
  | { kind: 'closing' }
  | { kind: 'ended' };

type TransactionEvent =
  | { kind: 'prepared' }
  | { kind: 'started'; main: MainAccount }
  | { kind: 'confirmed' }
  | { kind: 'ended' }
  | ChainEvent
  | { kind: 'decoded'; decoded: SiteDecodedCall }
  | { kind: 'decodeFailed'; error: unknown }
  | { kind: 'keyRead'; key: Uint8Array }
  | { kind: 'keyFailed'; error: unknown }
  | { kind: 'asked'; session: SiteChainSession }
  | { kind: 'built'; transaction: string }
  | { kind: 'buildFailed'; error: unknown };

type TransactionEffect = { kind: 'sessionEnded'; session: SiteChainSession };

type TransactionMachine = MachineTypes<TransactionState, TransactionEvent, TransactionEffect>;

/** A site's transaction in the session window: the site's round with the transaction as its action. */
export function createSiteTransaction({
  request,
  call,
  chain,
  txSigner,
  accountReader,
  ...round
}: CreateSiteTransactionParams): SiteRound {
  return createSiteRound({
    ...round,
    request,
    action: createSiteTransactionAction({ origin: round.origin, request, call, chain, txSigner, accountReader }),
  });
}

/** Has the account the site names sign the site's call, and gives the signed transaction without sending it. */
export function createSiteTransactionAction({
  origin,
  request: { account, chain: genesis },
  call,
  chain,
  txSigner,
  accountReader,
}: CreateSiteTransactionActionParams): SiteAction<SiteTransactionResult, 'signed'> {
  const signing: SiteActionState<SiteTransactionResult> = {
    kind: 'working',
    screen: { view: 'site-signing', origin, route: 'sign' },
  };

  const endUnopened: HandlerOf<TransactionMachine, 'idle' | 'openFailed' | 'failed', 'ended'> = (
    _state,
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'ended' });
  };
  /** Decodes the site's call on the run's session for the review. */
  function startDecode(run: Run, session: SiteChainSession, { emitState, update }: Transition<TransactionMachine>) {
    emitState({ kind: 'decoding', run, session });
    update(
      session.decode(call).then(
        decoded => ({ kind: 'decoded', decoded }),
        (error: unknown) => ({ kind: 'decodeFailed', error }),
      ),
    );
  }
  /** Builds the decode the review showed, so the phone signs the call the user confirmed. */
  function startBuild(
    { run, session, decoded }: DecodedRun,
    publicKey: Uint8Array,
    { emitState, update }: Transition<TransactionMachine>,
  ): void {
    emitState({ kind: 'building', run, session, decoded });
    // Async, so a creator that throws fails the build like a signing that rejects.
    async function build(): Promise<string> {
      const creator = txSigner.creator(account, {
        onAsk() {
          update({ kind: 'asked', session });
        },
      });
      return toHex(await session.create({ call: decoded, creator, publicKey }));
    }
    update(
      build().then(
        transaction => ({ kind: 'built', transaction }),
        (error: unknown) => ({ kind: 'buildFailed', error }),
      ),
    );
  }
  /** Lets the chain go at once, rather than once the phone answers. */
  const endSession: HandlerOf<
    TransactionMachine,
    'opened' | 'decoding' | 'reviewing' | 'sharing' | 'building' | 'approving',
    'ended'
  > = ({ session }, _event, { emitState, emitSideEffect }) => {
    emitState({ kind: 'ended' });
    emitSideEffect({ kind: 'sessionEnded', session });
  };
  const finishBuild: HandlerOf<TransactionMachine, 'building' | 'approving', 'built'> = (
    { session },
    { transaction },
    transition,
  ) => {
    transition.emitState({ kind: 'done', result: { transaction } });
    transition.emitSideEffect({ kind: 'sessionEnded', session });
  };
  const failBuild: HandlerOf<TransactionMachine, 'building' | 'approving', 'buildFailed'> = (
    { run, session },
    { error },
    transition,
  ) => {
    transition.emitState(getBuildOutcome(error, run.readKey));
    transition.emitSideEffect({ kind: 'sessionEnded', session });
  };

  const machine = createStateMachine<TransactionMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        prepared(_state, _event, { emitState, update }) {
          emitState({ kind: 'prepared' });
          update(openChain(chain, genesis));
        },
        started(_state, { main }, { emitState, update }) {
          emitState({ kind: 'opening', run: { main, readKey: null } });
          update(openChain(chain, genesis));
        },
        ended: endUnopened,
      },
      prepared: {
        chainOpened(_state, { session }, { emitState }) {
          emitState({ kind: 'opened', session });
        },
        chainFailed(_state, { failure }, { emitState }) {
          emitState({ kind: 'openFailed', failure });
        },
        // The open in flight ends in the state this moves to.
        started(_state, { main }, { emitState }) {
          emitState({ kind: 'opening', run: { main, readKey: null } });
        },
        ended(_state, _event, { emitState }) {
          emitState({ kind: 'closing' });
        },
      },
      opened: {
        started({ session }, { main }, transition) {
          startDecode({ main, readKey: null }, session, transition);
        },
        ended: endSession,
      },
      openFailed: {
        started({ failure }, _event, { emitState }) {
          emitState({ kind: 'failed', failure, readKey: null });
        },
        ended: endUnopened,
      },
      opening: {
        chainOpened({ run }, { session }, transition) {
          startDecode(run, session, transition);
        },
        chainFailed({ run }, { failure }, { emitState }) {
          emitState({ kind: 'failed', failure, readKey: run.readKey });
        },
        ended(_state, _event, { emitState }) {
          emitState({ kind: 'closing' });
        },
      },
      decoding: {
        decoded({ run, session }, { decoded }, { emitState }) {
          emitState({ kind: 'reviewing', run, session, decoded });
        },
        decodeFailed({ run, session }, { error }, transition) {
          if (error instanceof SiteChainError && error.kind === 'undecodable') {
            // The site's own input, which is no failure of the window to report.
            transition.emitState({ kind: 'refused', refusal: new SiteRoundRefusal('bad_request') });
          } else {
            const failure = new SiteRoundFailure({
              step: 'chain',
              retry: true,
              message: 'The call could not be decoded on Asset Hub',
              cause: error,
            });
            transition.emitState({ kind: 'failed', failure, readKey: run.readKey });
          }
          transition.emitSideEffect({ kind: 'sessionEnded', session });
        },
        ended: endSession,
      },
      reviewing: {
        confirmed({ run, session, decoded }, _event, transition) {
          // Nothing reaches the phone before the user confirms the review. The account's key fills the nonce.
          if (run.readKey?.owner === run.main.owner) {
            startBuild({ run, session, decoded }, run.readKey.key, transition);
            return;
          }
          transition.emitState({ kind: 'sharing', run, session, decoded });
          transition.update(
            accountReader.account(account).then(
              key => ({ kind: 'keyRead', key }),
              (error: unknown) => ({ kind: 'keyFailed', error }),
            ),
          );
        },
        ended: endSession,
      },
      sharing: {
        keyRead({ run, session, decoded }, { key }, transition) {
          const { main } = run;
          startBuild({ run: { main, readKey: { owner: main.owner, key } }, session, decoded }, key, transition);
        },
        keyFailed({ run, session }, { error }, transition) {
          if (error instanceof SiteAccountRejectedError) {
            transition.emitState({ kind: 'rejected' });
          } else {
            const failure = new SiteRoundFailure({
              step: 'account',
              retry: true,
              message: 'The site account could not be read',
              cause: error,
            });
            transition.emitState({ kind: 'failed', failure, readKey: run.readKey });
          }
          transition.emitSideEffect({ kind: 'sessionEnded', session });
        },
        ended: endSession,
      },
      building: {
        asked(state, event, { emitState }) {
          // A late ask of an earlier build must not move this one.
          if (event.session !== state.session) {
            return;
          }
          emitState({ ...state, kind: 'approving' });
        },
        built: finishBuild,
        buildFailed: failBuild,
        ended: endSession,
      },
      approving: {
        built: finishBuild,
        buildFailed: failBuild,
        ended: endSession,
      },
      done: null,
      refused: null,
      rejected: null,
      failed: {
        started({ readKey }, { main }, { emitState, update }) {
          emitState({ kind: 'opening', run: { main, readKey } });
          update(openChain(chain, genesis));
        },
        ended: endUnopened,
      },
      closing: {
        chainOpened(_state, { session }, transition) {
          transition.emitState({ kind: 'ended' });
          transition.emitSideEffect({ kind: 'sessionEnded', session });
        },
        chainFailed(_state, _event, { emitState }) {
          // The round no longer needs the chain, so its failure to open is no failure of the round.
          emitState({ kind: 'ended' });
        },
      },
      ended: null,
    },
    onEffect({ session }) {
      // A close that fails is reported and counted, and never takes the place of how the run ended.
      try {
        session.close();
      } catch (error) {
        const failure = new SiteRoundFailure({
          step: 'chain',
          retry: false,
          message: 'Asset Hub could not be closed',
          cause: error,
        });
        reportSiteFailure(failure, SITE_ROUTE_METRICS.sign);
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: siteTransactionTransitionMetric,
        message: '[dot.li] A site transaction transition threw',
      });
    },
  });

  const state = computed(machine.state, (current): SiteActionState<SiteTransactionResult> => {
    switch (current.kind) {
      case 'idle':
      case 'prepared':
      case 'opened':
      case 'openFailed':
      case 'closing':
      case 'ended':
        return { kind: 'idle' };
      // The extensions fill before the phone is asked, so Approve shows only once it is.
      case 'opening':
      case 'decoding':
      case 'building':
        return signing;
      case 'reviewing':
        return {
          kind: 'working',
          screen: { view: 'site-review', origin, call: current.decoded.display, account: toDisplayAccount(account) },
        };
      case 'sharing':
        return { kind: 'working', screen: { view: 'site-sharing', origin } };
      case 'approving':
        return { kind: 'working', screen: { view: 'site-approving', origin } };
      case 'done':
        return { kind: 'done', result: current.result };
      case 'refused':
        return { kind: 'refused', refusal: current.refusal };
      case 'rejected':
        return { kind: 'rejected' };
      case 'failed':
        return { kind: 'failed', failure: current.failure };
    }
  });
  state.eq = isShallowEqual;

  return {
    route: 'sign',
    metric: SITE_ROUTE_METRICS.sign,
    outcome: () => 'signed',
    state,
    prepare() {
      machine.update({ kind: 'prepared' });
    },
    start(main) {
      machine.update({ kind: 'started', main });
    },
    confirm() {
      machine.update({ kind: 'confirmed' });
    },
    end() {
      machine.update({ kind: 'ended' });
    },
    await: () => machine.await(),
  };
}

/** Opens Asset Hub for `genesis`. */
async function openChain(chain: SiteChain, genesis: string): Promise<ChainEvent> {
  try {
    return { kind: 'chainOpened', session: await chain.open(genesis) };
  } catch (error) {
    // Another network's Asset Hub stays another network's on a Try again.
    const retry = !(error instanceof SiteChainError && error.kind === 'mismatch');
    const failure = new SiteRoundFailure({
      step: 'chain',
      retry,
      message: 'Asset Hub could not be opened',
      cause: error,
    });
    return { kind: 'chainFailed', failure };
  }
}

/** How a build that failed ends the run. Nothing was sent, so a failure may always be tried again. */
function getBuildOutcome(
  error: unknown,
  readKey: ReadKey | null,
): Extract<TransactionState, { kind: 'rejected' | 'refused' | 'failed' }> {
  if (!(error instanceof SiteTxError)) {
    // Anything else failed before the phone was asked: the fillers did not load, or papi's reads of the chain failed.
    const failure = new SiteRoundFailure({
      step: 'chain',
      retry: true,
      message: 'Asset Hub failed before the transaction was signed',
      cause: error,
    });
    return { kind: 'failed', failure, readKey };
  }
  switch (error.kind) {
    case 'rejected':
      return { kind: 'rejected' };
    case 'unsupported':
      return { kind: 'refused', refusal: new SiteRoundRefusal('transaction_invalid', { cause: error }) };
    case 'failed': {
      const failure = new SiteRoundFailure({
        step: 'build',
        retry: true,
        message: 'The transaction could not be signed',
        cause: error,
      });
      return { kind: 'failed', failure, readKey };
    }
  }
}
