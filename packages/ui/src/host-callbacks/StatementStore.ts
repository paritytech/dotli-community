// Statement-store adapters — glue between the TrUAPI host callbacks and
// `@novasamatech/sdk-statement` / `@novasamatech/statement-store`. The
// SCALE ↔ SDK mapping (hex strings vs Uint8Array, lowercase vs PascalCase
// proof tags) was previously in `statement-store-mapping.ts`; it lives
// here until the Rust core grows native statement handling (Phase D).

import * as T from "@truapi/client";
import type {
  Subscribe,
  WasmHostCallbacks,
} from "@truapi/host-shared";
import {
  createSr25519Prover,
  type StatementStoreAdapter,
  type Proof,
  type SignedStatement as SdkSignedStatement,
  type Statement as SdkStatement,
} from "@dotli/auth/statement";
import {
  getStatementStore,
  onStatementStoreReady,
  readSessionSecret,
  getAuthState,
} from "@dotli/auth/auth";
import { log } from "@dotli/shared/log";
import { toHexPrefixed, fromHexPrefixed } from "./hex";
import { createSubmitRateLimiter } from "./rate-limit";

// ── SCALE ↔ SDK mapping ────────────────────────────────────
//
// SDK types use `0x${string}` (SizedHex<N>) for fixed-size byte fields; the
// TrUAPI wire encoding uses raw `Uint8Array`. The cast to `SizedHex<N>` below
// is safe because `toHexPrefixed` always emits the `0x`-prefixed lowercase
// form the SDK expects.

type Sized<N extends number> = `0x${string}` & { __size?: N };

function toSized<N extends number>(bytes: Uint8Array): Sized<N> {
  return toHexPrefixed(bytes);
}

function mapSdkProof(proof: Proof): T.StatementProof {
  switch (proof.type) {
    case "ecdsa":
      return {
        tag: "Ecdsa",
        value: {
          signature: fromHexPrefixed(proof.value.signature),
          signer: fromHexPrefixed(proof.value.signer),
        },
      };
    case "ed25519":
      return {
        tag: "Ed25519",
        value: {
          signature: fromHexPrefixed(proof.value.signature),
          signer: fromHexPrefixed(proof.value.signer),
        },
      };
    case "sr25519":
      return {
        tag: "Sr25519",
        value: {
          signature: fromHexPrefixed(proof.value.signature),
          signer: fromHexPrefixed(proof.value.signer),
        },
      };
    case "onChain":
      return {
        tag: "OnChain",
        value: {
          who: fromHexPrefixed(proof.value.who),
          blockHash: fromHexPrefixed(proof.value.blockHash),
          event: proof.value.event,
        },
      };
  }
}

function mapHostProof(proof: T.StatementProof): Proof {
  switch (proof.tag) {
    case "Ecdsa":
      return {
        type: "ecdsa",
        value: {
          signature: toSized<65>(proof.value.signature),
          signer: toSized<33>(proof.value.signer),
        },
      };
    case "Ed25519":
      return {
        type: "ed25519",
        value: {
          signature: toSized<64>(proof.value.signature),
          signer: toSized<32>(proof.value.signer),
        },
      };
    case "Sr25519":
      return {
        type: "sr25519",
        value: {
          signature: toSized<64>(proof.value.signature),
          signer: toSized<32>(proof.value.signer),
        },
      };
    case "OnChain":
      return {
        type: "onChain",
        value: {
          who: toSized<32>(proof.value.who),
          blockHash: toSized<32>(proof.value.blockHash),
          event: proof.value.event,
        },
      };
  }
}

function mapSdkSignedStatement(
  statement: SdkSignedStatement,
): T.SignedStatement {
  const result: T.SignedStatement = {
    proof: mapSdkProof(statement.proof),
    topics: (statement.topics ?? []).map(fromHexPrefixed),
  };
  if (statement.expiry !== undefined) {
    result.expiry = statement.expiry;
  }
  if (statement.channel) {
    result.channel = fromHexPrefixed(statement.channel);
  }
  if (statement.data) {
    result.data = statement.data;
  }
  return result;
}

function mapHostSignedStatement(
  statement: T.SignedStatement,
): SdkSignedStatement {
  const result: SdkSignedStatement = {
    proof: mapHostProof(statement.proof),
    topics: statement.topics.map((t) => toSized<32>(t)),
  };
  if (statement.expiry !== undefined) {
    result.expiry = statement.expiry;
  }
  if (statement.channel) {
    result.channel = toSized<32>(statement.channel);
  }
  if (statement.data) {
    result.data = statement.data;
  }
  return result;
}

function mapHostStatement(statement: T.Statement): SdkStatement {
  const result: SdkStatement = {
    topics: statement.topics.map((t) => toSized<32>(t)),
  };
  if (statement.proof) {
    result.proof = mapHostProof(statement.proof);
  }
  if (statement.expiry !== undefined) {
    result.expiry = statement.expiry;
  }
  if (statement.channel) {
    result.channel = toSized<32>(statement.channel);
  }
  if (statement.data) {
    result.data = statement.data;
  }
  return result;
}

// ── Callbacks ──────────────────────────────────────────────

function createStatementStoreSubscribe(
  label: string,
): Subscribe<
  T.RemoteStatementStoreSubscribeRequest,
  T.RemoteStatementStoreSubscribeItem
> {
  return (request, sendItem) => {
    // Drop wildcard (`undefined`) entries; the adapter only accepts a list of
    // fully specified topic bytes.
    const topics = request.value.topics.filter(
      (t): t is Uint8Array => t !== undefined,
    );
    let innerUnsub: (() => void) | null = null;
    let cancelled = false;

    const startSubscription = (store: StatementStoreAdapter): void => {
      if (cancelled) {
        return;
      }
      log.warn(`[${label}] Statement store subscribe, topics:`, topics.length);
      innerUnsub = store.subscribeStatements(
        { matchAll: topics },
        (page) => {
          const signed = page.statements.filter(
            (s): s is SdkSignedStatement => s.proof !== undefined,
          );
          if (signed.length > 0) {
            sendItem({
              tag: "V2",
              value: signed.map(mapSdkSignedStatement),
            });
          }
        },
      );
    };

    const store = getStatementStore();
    if (store) {
      startSubscription(store);
    } else {
      void onStatementStoreReady().then(startSubscription);
    }

    return () => {
      cancelled = true;
      innerUnsub?.();
    };
  };
}

function createStatementStoreSubmit(
  label: string,
): WasmHostCallbacks["statementStoreSubmit"] {
  const limiter = createSubmitRateLimiter();
  return async (request) => {
    const store = getStatementStore();
    if (!store) {
      throw new Error("Statement store not initialized");
    }
    if (!limiter.allow()) {
      throw new Error("Rate limited");
    }
    // The TrUAPI wire payload is a raw SCALE-encoded SignedStatement; decode
    // via the truapi-client codec before handing it to the SDK adapter.
    const decoded = T.SignedStatement.dec(request.value);
    const result = await store.submitStatement(mapHostSignedStatement(decoded));
    if (result.isErr()) {
      log.warn(`[${label}] submitStatement failed:`, result.error.message);
      throw result.error;
    }
    // The SDK adapter resolves to `void`; the TrUAPI response is a string
    // field historically used for a tx hash. Return empty until the adapter
    // surfaces one.
    return { tag: "V2", value: "" };
  };
}

function createStatementStoreCreateProof(
  label: string,
): WasmHostCallbacks["statementStoreCreateProof"] {
  return async (request) => {
    const state = getAuthState();
    if (state.status !== "authenticated") {
      throw new Error("Unable to sign: not authenticated");
    }
    const session = state.session;
    const secret = await readSessionSecret(session.id);
    if (!secret) {
      throw new Error("Unable to sign: no session secret");
    }
    const prover = createSr25519Prover(secret);
    const proofResult = await prover.generateMessageProof(
      mapHostStatement(request.value.statement),
    );
    if (proofResult.isErr()) {
      log.warn(`[${label}] createProof failed:`, proofResult.error.message);
      throw proofResult.error;
    }
    return { tag: "V2", value: mapSdkProof(proofResult.value.proof) };
  };
}

export function createStatementStoreAdapters(label: string): Pick<
  WasmHostCallbacks,
  | "statementStoreSubscribe"
  | "statementStoreSubmit"
  | "statementStoreCreateProof"
> {
  return {
    statementStoreSubscribe: createStatementStoreSubscribe(label),
    statementStoreSubmit: createStatementStoreSubmit(label),
    statementStoreCreateProof: createStatementStoreCreateProof(label),
  };
}
