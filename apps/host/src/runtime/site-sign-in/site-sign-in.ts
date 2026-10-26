// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's sign-in, the action a site's round runs on the auth route. It signs the site's assertion with the account
// made for that site, and tells the site the main account's username and nothing else of it.

import { NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';
import { spans as S } from '@dotli/metrics';
import { fromHex, toHex } from '@dotli/shared';
import type { Responder } from '../session-handoff/responder.js';
import { encodeSs58, formatSiteAssertion } from './site-assertion.js';
import type { SiteRequest } from './site-request.js';
import { siteSignInResult, type SiteSignInResult } from './site-result.js';
import {
  createSiteRound,
  SiteRoundFailure,
  SiteRoundRefusal,
  SiteRoundRejected,
  type SiteAction,
  type SiteRound,
  type SiteRoundDeps,
} from './site-round.js';
import { SiteSignError, SiteSignRejectedError, type SiteSigner } from './site-signer.js';

export type SiteSignInDeps = Omit<SiteRoundDeps<SiteSignInResult>, 'request' | 'responder' | 'action' | 'metric'> & {
  request: SiteRequest;
  net: Network;
  /** Answers the site, and says when the round is answered. */
  responder: Pick<Responder<SiteSignInResult>, 'state' | 'subscribe' | 'send' | 'refuse' | 'cancel'>;
  signer: SiteSigner;
};

const SIGNATURE_BYTES = 64;

/** The signature as 64 bytes of `0x` lowercase hex, the one form a site's verifier reads. */
function normalSignature(signature: string): string {
  let bytes: Uint8Array;
  try {
    bytes = fromHex(signature);
  } catch (error) {
    throw new SiteRoundFailure('sign', true, 'The signature is not hex', error);
  }
  if (bytes.length !== SIGNATURE_BYTES) {
    throw new SiteRoundFailure('sign', true, `The signature has ${String(bytes.length)} bytes`);
  }
  return toHex(bytes);
}

/** Signs the site's assertion for the main account's username, with the site account the grant keeps or a new one. */
export function siteSignInAction(deps: {
  origin: string;
  request: SiteRequest;
  net: Network;
  signer: SiteSigner;
  now: () => number;
}): SiteAction<SiteSignInResult> {
  const { origin, request, signer } = deps;
  const network = NETWORK_NAME_TO_SERVICES_CONFIG[deps.net];
  return {
    route: 'auth',
    outcome: () => 'granted',
    async run({ main, index, knownKey }) {
      const { username } = main;
      if (username === null) {
        throw new SiteRoundRefusal('no_username');
      }
      const built: { address: string; message: string }[] = [];
      let signed: { publicKey: Uint8Array; signature: string };
      try {
        signed = await signer.sign(
          index,
          publicKey => {
            const address = encodeSs58(publicKey, network.ss58Prefix);
            // Read as the text is built, after any account read on the phone, so the assertion lives its full time.
            const message = formatSiteAssertion({
              origin,
              address,
              statement: request.statement,
              relayGenesis: network.relay.genesis,
              nonce: request.nonce,
              issuedAt: deps.now(),
              username,
              group: request.groupToken,
            });
            built.push({ address, message });
            return message;
          },
          knownKey,
        );
      } catch (error) {
        if (error instanceof SiteSignRejectedError) {
          throw new SiteRoundRejected(error);
        }
        throw new SiteRoundFailure(
          error instanceof SiteSignError ? error.step : 'sign',
          true,
          'The site assertion could not be signed',
          error,
        );
      }
      const assertion = built.at(-1);
      if (assertion === undefined) {
        throw new SiteRoundFailure('sign', true, 'The signer signed no assertion');
      }
      const signature = normalSignature(signed.signature);
      const result = siteSignInResult({
        username,
        address: assertion.address,
        publicKey: signed.publicKey,
        message: assertion.message,
        signature,
      });
      return { result, publicKey: signed.publicKey };
    },
  };
}

/** A site's sign-in in the session window: the site's round with the sign-in as its action. */
export function createSiteSignIn(deps: SiteSignInDeps): SiteRound {
  const { request, net, signer, ...round } = deps;
  return createSiteRound({
    ...round,
    request,
    action: siteSignInAction({ origin: deps.origin, request, net, signer, now: deps.now }),
    metric: S.SITE_SIGN_IN,
  });
}
