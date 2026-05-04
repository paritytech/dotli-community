// dot.li — Signing confirmation modals (vanilla DOM)
//
// Bridges host-container's `{ account, payload }` signing request to
// host-papp's flat `{ address, ...payload }` by flattening and overriding
// `address` with the session's remote account id (the only value papp
// accepts). The display label (dApp name) is passed separately.

import { toHex } from "@dotli/shared/hex";
import { log } from "@dotli/shared/log";
import type { UserSession } from "@novasamatech/host-papp";

export interface SigningResult {
  signature: `0x${string}`;
  signedTransaction?: `0x${string}`;
}

export interface ContainerSignPayloadRequest {
  account: [string, number];
  payload: {
    blockHash: `0x${string}`;
    blockNumber: `0x${string}`;
    era: `0x${string}`;
    genesisHash: `0x${string}`;
    method: `0x${string}`;
    nonce: `0x${string}`;
    specVersion: `0x${string}`;
    tip: `0x${string}`;
    transactionVersion: `0x${string}`;
    signedExtensions: string[];
    version: number;
    assetId: `0x${string}` | undefined;
    metadataHash: `0x${string}` | undefined;
    mode: number | undefined;
    withSignedTransaction: boolean | undefined;
  };
}

export interface ContainerSignRawRequest {
  account: [string, number];
  payload:
    | { tag: "Bytes"; value: Uint8Array }
    | { tag: "Payload"; value: string };
}

/** Timeout for the wallet to respond (ms). Covers WS drops and unresponsive wallets. */
const SIGN_TIMEOUT_MS = 300_000; // 300 seconds

class SignTimeoutError extends Error {
  constructor() {
    super("Wallet did not respond in time — the connection may have dropped.");
    this.name = "SignTimeoutError";
  }
}

/** Race a thenable against a timeout. Clears the timer on settlement. */
function withTimeout<T>(thenable: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SignTimeoutError());
    }, ms);
    const cleanup = (): void => {
      clearTimeout(timer);
    };
    Promise.resolve(thenable).then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e: unknown) => {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function truncateAddress(address: string): string {
  if (address.length <= 16) {
    return address;
  }
  return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

function createModalDOM(
  title: string,
  fields: { label: string; value: string; mono?: boolean }[],
): {
  backdrop: HTMLDivElement;
  signBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
} {
  const backdrop = document.createElement("div");
  backdrop.className = "signing-modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "signing-modal";

  const heading = document.createElement("h2");
  heading.textContent = title;
  modal.appendChild(heading);

  const fieldsContainer = document.createElement("div");
  fieldsContainer.className = "signing-fields";

  for (const field of fields) {
    const group = document.createElement("div");
    group.className = "signing-field";

    const label = document.createElement("div");
    label.className = "signing-field-label";
    label.textContent = field.label;
    group.appendChild(label);

    const value = document.createElement("div");
    value.className = "signing-field-value";
    if (field.mono === true) {
      value.classList.add("mono");
    }
    value.textContent = field.value;
    group.appendChild(value);

    fieldsContainer.appendChild(group);
  }
  modal.appendChild(fieldsContainer);

  const footer = document.createElement("div");
  footer.className = "signing-modal-footer";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "signing-btn-cancel";
  cancelBtn.textContent = "Cancel";
  footer.appendChild(cancelBtn);

  const signBtn = document.createElement("button");
  signBtn.className = "signing-btn-sign";
  signBtn.textContent = "Sign";
  footer.appendChild(signBtn);

  modal.appendChild(footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  return { backdrop, signBtn, cancelBtn };
}

function removeModal(backdrop: HTMLDivElement): void {
  backdrop.remove();
}

/**
 * Sign-payload modal. Handles both the product-account and the
 * legacy-account container callbacks — in both cases dot.li signs with
 * the paired remote account, so callers only need to supply the
 * payload body. host-papp validates the resolved address internally
 * and rejects if the session key can't sign for it.
 */
export function showSignPayloadModal(
  session: UserSession,
  payload: ContainerSignPayloadRequest["payload"],
  appLabel: string,
): Promise<SigningResult> {
  return new Promise((resolve, reject) => {
    const address = toHex(session.remoteAccount.accountId);

    log.warn("[dot.li signing] signPayload request received:", {
      appLabel,
      genesisHash: payload.genesisHash,
      method: payload.method.slice(0, 40) + "...",
      mode: payload.mode,
      withSignedTransaction: payload.withSignedTransaction,
      metadataHash: payload.metadataHash,
      assetId: payload.assetId,
    });
    log.warn("[dot.li signing] session info:", {
      localAccountId: toHex(session.localAccount.accountId),
      remoteAccountId: address,
      remotePublicKey: toHex(session.remoteAccount.publicKey),
    });

    const fields: { label: string; value: string; mono?: boolean }[] = [
      { label: "App", value: appLabel },
      { label: "Signer", value: truncateAddress(address) },
      { label: "Genesis Hash", value: payload.genesisHash, mono: true },
      { label: "Call Data", value: payload.method, mono: true },
    ];

    const { backdrop, signBtn, cancelBtn } = createModalDOM(
      "Sign Transaction",
      fields,
    );

    cancelBtn.addEventListener("click", () => {
      log.warn("[dot.li signing] user cancelled signPayload");
      removeModal(backdrop);
      reject(new Error("Rejected"));
    });

    signBtn.addEventListener("click", () => {
      signBtn.disabled = true;
      signBtn.textContent = "Signing...";

      const signRequest = { address, ...payload };
      log.warn("[dot.li signing] dispatching signPayload to session:", {
        method: signRequest.method.slice(0, 40) + "...",
        mode: signRequest.mode,
        withSignedTransaction: signRequest.withSignedTransaction,
      });

      void withTimeout(session.signPayload(signRequest), SIGN_TIMEOUT_MS).then(
        (result) => {
          result.match(
            ({ signature, signedTransaction }) => {
              log.warn("[dot.li signing] signPayload SUCCESS:", {
                signature: toHex(signature).slice(0, 20) + "...",
                hasSignedTx: !!signedTransaction,
              });
              removeModal(backdrop);
              resolve({
                signature: toHex(signature),
                signedTransaction: signedTransaction
                  ? typeof signedTransaction === "string"
                    ? signedTransaction
                    : toHex(signedTransaction)
                  : undefined,
              });
            },
            (e) => {
              log.error("[dot.li signing] signPayload FAILED:", e.message, e);
              removeModal(backdrop);
              reject(new Error(e.message));
            },
          );
        },
        (e: unknown) => {
          log.error("[dot.li signing] signPayload timed out:", e);
          removeModal(backdrop);
          const msg = e instanceof Error ? e.message : "Request timed out";
          reject(new Error(msg));
        },
      );
    });
  });
}

/** Sign-raw counterpart of `showSignPayloadModal`; see that function for rationale. */
export function showSignRawModal(
  session: UserSession,
  data: ContainerSignRawRequest["payload"],
  appLabel: string,
): Promise<SigningResult> {
  return new Promise((resolve, reject) => {
    const address = toHex(session.remoteAccount.accountId);
    const message = data.tag === "Payload" ? data.value : toHex(data.value);

    log.warn("[dot.li signing] signRaw request received:", {
      appLabel,
      dataTag: data.tag,
      message: message.slice(0, 80) + (message.length > 80 ? "..." : ""),
    });
    log.warn("[dot.li signing] session info:", {
      localAccountId: toHex(session.localAccount.accountId),
      remoteAccountId: address,
      remotePublicKey: toHex(session.remoteAccount.publicKey),
    });

    const fields: { label: string; value: string; mono?: boolean }[] = [
      { label: "App", value: appLabel },
      { label: "Signer", value: truncateAddress(address) },
      { label: "Message", value: message, mono: true },
    ];

    const { backdrop, signBtn, cancelBtn } = createModalDOM(
      "Sign Message",
      fields,
    );

    cancelBtn.addEventListener("click", () => {
      log.warn("[dot.li signing] user cancelled signRaw");
      removeModal(backdrop);
      reject(new Error("Rejected"));
    });

    signBtn.addEventListener("click", () => {
      signBtn.disabled = true;
      signBtn.textContent = "Signing...";

      log.warn("[dot.li signing] dispatching signRaw to session");

      const signRawRequest = { address, data };
      void withTimeout(session.signRaw(signRawRequest), SIGN_TIMEOUT_MS).then(
        (result) => {
          result.match(
            ({ signature, signedTransaction }) => {
              log.warn("[dot.li signing] signRaw SUCCESS:", {
                signature: toHex(signature).slice(0, 20) + "...",
                hasSignedTx: !!signedTransaction,
              });
              removeModal(backdrop);
              resolve({
                signature: toHex(signature),
                signedTransaction: signedTransaction
                  ? typeof signedTransaction === "string"
                    ? signedTransaction
                    : toHex(signedTransaction)
                  : undefined,
              });
            },
            (e) => {
              log.error("[dot.li signing] signRaw FAILED:", e.message, e);
              removeModal(backdrop);
              reject(new Error(e.message));
            },
          );
        },
        (e: unknown) => {
          log.error("[dot.li signing] signRaw timed out:", e);
          removeModal(backdrop);
          const msg = e instanceof Error ? e.message : "Request timed out";
          reject(new Error(msg));
        },
      );
    });
  });
}
