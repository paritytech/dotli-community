// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Confirm-prompt content for the core's review surface.
//
// The prompts are DELIBERATELY modest. The host cannot decode what it is
// approving: `CreateTransaction` carries `callData` as opaque hex without a
// method name, a readable address, or arguments, and `PreimageSubmit`
// carries only a byte count. The paired wallet is the authoritative trust
// surface. It decodes and displays the real content before anything is
// signed. So `confirmUserAction` is a local pre-confirmation, and these
// prompts render only what the host knows on TYPED authority (review kind,
// account, chain, sizes) and defer the content to the phone rather than
// pretending to summarise bytes they cannot decode.

import type { UserConfirmationReview } from "@parity/truapi-host";
import type { ChainEndpoints } from "./chain-pool.js";
import { hexByteLength, shortHex } from "./hex.js";

/** What a presenter is asked to confirm. */
export interface ConfirmRequest {
  /** One-line action statement, e.g. `Sign a message`. */
  title: string;
  /** Typed metadata the host knows on its own authority. */
  details: string[];
  /**
   * Whether the paired wallet will show the authoritative content before
   * signing. When true, presenters should tell the user to check the phone.
   */
  phoneVerifies: boolean;
}

function chainName(
  endpoints: ChainEndpoints | undefined,
  genesisHash: string,
): string {
  const name = endpoints?.[genesisHash]?.name;
  return name !== undefined ? name : `chain ${genesisHash.slice(0, 10)}…`;
}

function accountLine(account: {
  dotNsIdentifier: string;
  derivationIndex:
    | { tag: "Index"; value: number }
    | { tag: "Raw"; value: string };
}): string {
  const index =
    account.derivationIndex.tag === "Index"
      ? `#${String(account.derivationIndex.value)}`
      : shortHex(account.derivationIndex.value);
  return `account: ${account.dotNsIdentifier} (derivation ${index})`;
}

/** The wallet decodes legacy-account requests too. The host knows even less. */
function legacyAccountReview(title: string): ConfirmRequest {
  return { title, details: [], phoneVerifies: true };
}

/**
 * Describe a review for a terminal confirm prompt.
 *
 * `endpoints` (optional) resolves genesis hashes to human-readable chain
 * names in transaction prompts.
 */
export function describeReview(
  review: UserConfirmationReview,
  options: { endpoints?: ChainEndpoints } = {},
): ConfirmRequest {
  switch (review.tag) {
    case "SignRaw": {
      if (review.value.tag !== "Product") {
        return legacyAccountReview("Sign a message with a legacy account");
      }
      const { account, payload } = review.value.value;
      // The RawPayload discriminant survives into the review: `Bytes` is
      // raw binary, `Payload` is a wrapped string message. Rendering the
      // distinction matters. Raw bytes could be anything, including a
      // transaction-shaped payload.
      const kind =
        payload.tag === "Bytes"
          ? `raw binary data (${String(hexByteLength(payload.value.bytes))} bytes)`
          : "a text message";
      return {
        title: "Sign a message",
        details: [accountLine(account), `payload: ${kind}`],
        phoneVerifies: true,
      };
    }
    case "SignPayload": {
      if (review.value.tag !== "Product") {
        return legacyAccountReview("Sign a payload with a legacy account");
      }
      return { title: "Sign a payload", details: [], phoneVerifies: true };
    }
    case "CreateTransaction": {
      if (review.value.tag !== "Product") {
        return legacyAccountReview(
          "Submit a transaction with a legacy account",
        );
      }
      const { signer, genesisHash, callData } = review.value.value;
      return {
        title: `Submit a transaction on ${chainName(options.endpoints, genesisHash)}`,
        details: [
          accountLine(signer),
          `call data: ${String(hexByteLength(callData))} bytes (not decodable here)`,
        ],
        phoneVerifies: true,
      };
    }
    case "StatementStoreProductSign":
      // The payload is the exact unsigned statement, signed as-is (no
      // `<Bytes>` envelope), so it must NOT be presented with the
      // raw-message-signing convention.
      return {
        title: "Sign a Statement Store proof",
        details: [
          accountLine(review.value.account),
          `statement payload: ${String(review.value.payload.length)} bytes`,
        ],
        phoneVerifies: true,
      };
    case "SignVrf":
      return {
        title: "Sign a VRF transcript",
        details: [
          `product: ${review.value.callingProductId}`,
          accountLine(review.value.request.account),
          `transcript items: ${String(review.value.request.items.length)}`,
        ],
        phoneVerifies: true,
      };
    case "ResourceAllocation":
      return {
        title: "Allocate network resources",
        details: review.value.resources.map(
          (resource) => `resource: ${JSON.stringify(resource)}`,
        ),
        phoneVerifies: true,
      };
    case "PreimageSubmit":
      return {
        title: "Publish data to the Bulletin chain",
        details: [
          `size: ${String(review.value.size)} bytes (content not decodable here)`,
        ],
        phoneVerifies: true,
      };
    case "AccountAlias":
      return {
        title: "Derive a contextual alias",
        details: [`product: ${review.value.callingProductId}`],
        phoneVerifies: false,
      };
    case "CreateProof":
      return {
        title: "Create a ring-VRF proof",
        details: [`product: ${review.value.callingProductId}`],
        phoneVerifies: false,
      };
    case "IdentityDisclosure":
      return {
        title: "Disclose your primary identity to a product",
        details: [`product: ${review.value.productId}`],
        phoneVerifies: false,
      };
    case "AccountAccess":
      return {
        title: "Allow one product to access another product's account",
        details: [
          `requesting: ${review.value.requestingProductId}`,
          `target: ${review.value.targetProductId}`,
        ],
        phoneVerifies: false,
      };
  }
}
