import type {
  AccountAccessReview,
  AccountAliasReview,
  CreateProofReview,
  CreateTransactionReview,
  IdentityDisclosureReview,
  PreimageSubmitReview,
  ResourceAllocationReview,
  SignPayloadReview,
  SignRawReview,
  StatementStoreProductSignReview,
  UserConfirmation as UserConfirmationHost,
  UserConfirmationReview,
} from "@parity/truapi-host";
import type {
  AllocatableResource,
  DerivationIndex,
  HostSignPayloadData,
  ProductAccountId,
  RawPayload,
  RingLocationJunction,
} from "@parity/truapi";
import { showPreimageSubmitModal } from "../preimage-modal";
import {
  blockingModalAbortError,
  createBlockingModalScope,
  throwIfAborted,
  type BlockingModalScope,
} from "../blocking-modal-queue";

interface ConfirmationCopy {
  title: string;
  action: string;
  cancelAction?: string;
}

interface ConfirmationField {
  label: string;
  value: string;
  mono?: boolean;
}

type ConfirmationDecision = "accepted" | "rejected" | "dismissed";

/** Reviews rendered by the generic confirmation modal; other reviews are handled separately. */
type ModalReview = Exclude<
  UserConfirmationReview,
  { tag: "PreimageSubmit" | "SignVrf" }
>;

function showConfirmationModal(
  label: string,
  copy: ConfirmationCopy,
  review: ModalReview,
  signal: AbortSignal,
): Promise<ConfirmationDecision> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const display = confirmationDisplay(label, review);
    const backdrop = document.createElement("div");
    backdrop.className = "signing-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "signing-modal";

    const heading = document.createElement("h2");
    heading.textContent = copy.title;
    modal.appendChild(heading);

    const fields = document.createElement("div");
    fields.className = "signing-fields";

    for (const field of display.fields) {
      fields.appendChild(createField(field));
    }

    modal.appendChild(fields);

    const footer = document.createElement("div");
    footer.className = "signing-modal-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "signing-btn-cancel";
    cancelBtn.textContent = copy.cancelAction ?? "Cancel";
    footer.appendChild(cancelBtn);

    const allowBtn = document.createElement("button");
    allowBtn.className = "signing-btn-sign";
    allowBtn.textContent = copy.action;
    footer.appendChild(allowBtn);

    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      backdrop.remove();
    };
    const finish = (decision: ConfirmationDecision): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(decision);
    };
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(blockingModalAbortError(signal.reason));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    cancelBtn.addEventListener("click", () => {
      finish("rejected");
    });
    allowBtn.addEventListener("click", () => {
      finish("accepted");
    });
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        finish("dismissed");
      }
    });
  });
}

function createField(field: ConfirmationField): HTMLDivElement {
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

  return group;
}

function formatBytes(value: Uint8Array): string {
  return `0x${Array.from(value, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function confirmationDisplay(
  label: string,
  review: ModalReview,
): { fields: ConfirmationField[] } {
  switch (review.tag) {
    case "SignPayload":
      return { fields: createSignPayloadFields(label, review.value) };
    case "SignRaw":
      return { fields: createSignRawFields(label, review.value) };
    case "StatementStoreProductSign":
      return { fields: createStatementSignFields(label, review.value) };
    case "CreateTransaction":
      return { fields: createTransactionFields(label, review.value) };
    case "AccountAlias":
      return { fields: createRingContextFields(review.value) };
    case "CreateProof":
      return { fields: createProofFields(review.value) };
    case "AccountAccess":
      return { fields: createAccountAccessFields(review.value) };
    case "IdentityDisclosure":
      return { fields: createIdentityDisclosureFields(review.value) };
    case "ResourceAllocation":
      return { fields: createResourceAllocationFields(review.value) };
  }
}

function truncateHex(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}...` : value;
}

function formatRawPayload(payload: RawPayload): string {
  return truncateHex(
    payload.tag === "Bytes" ? payload.value.bytes : payload.value.payload,
  );
}

function formatDerivationIndex(index: DerivationIndex): string {
  return index.tag === "Left" ? String(index.value) : index.value;
}

function formatProductAccount(account: ProductAccountId): string {
  return `${account.dotNsIdentifier} / ${formatDerivationIndex(account.derivationIndex)}`;
}

function createPayloadFields(
  app: string,
  signer: string,
  payload: HostSignPayloadData,
): ConfirmationField[] {
  return [
    { label: "App", value: app },
    { label: "Signer", value: signer },
    { label: "Genesis Hash", value: payload.genesisHash, mono: true },
    { label: "Call Data", value: truncateHex(payload.method), mono: true },
    { label: "Version", value: String(payload.version) },
  ];
}

function createSignPayloadFields(
  label: string,
  review: SignPayloadReview,
): ConfirmationField[] {
  if (review.tag === "Product") {
    return createPayloadFields(
      label,
      formatProductAccount(review.value.account),
      review.value.payload,
    );
  }

  return createPayloadFields(label, review.value.signer, review.value.payload);
}

function createSignRawFields(
  label: string,
  review: SignRawReview,
): ConfirmationField[] {
  if (review.tag === "Product") {
    return [
      { label: "App", value: label },
      { label: "Signer", value: formatProductAccount(review.value.account) },
      {
        label: "Message",
        value: formatRawPayload(review.value.payload),
        mono: true,
      },
    ];
  }

  return [
    { label: "App", value: label },
    { label: "Signer", value: review.value.signer },
    {
      label: "Message",
      value: formatRawPayload(review.value.payload),
      mono: true,
    },
  ];
}

function createTransactionFields(
  label: string,
  review: CreateTransactionReview,
): ConfirmationField[] {
  const payload = review.value;
  const signer =
    review.tag === "Product"
      ? formatProductAccount(review.value.signer)
      : review.value.signer;

  return [
    { label: "App", value: label },
    { label: "Signer", value: signer },
    { label: "Genesis Hash", value: payload.genesisHash, mono: true },
    { label: "Call Data", value: truncateHex(payload.callData), mono: true },
    { label: "Tx Ext Version", value: String(payload.txExtVersion) },
  ];
}

function formatRingJunction(junction: RingLocationJunction): string {
  return `${junction.tag}(${String(junction.value)})`;
}

function createRingContextFields(
  review: AccountAliasReview | CreateProofReview,
): ConfirmationField[] {
  return [
    { label: "Requesting product", value: review.callingProductId },
    { label: "Context product", value: review.context.productId },
    {
      label: "Context suffix",
      value: formatDerivationIndex(review.context.suffix),
      mono: true,
    },
    { label: "Chain", value: review.ringLocation.chainId, mono: true },
    {
      label: "Ring path",
      value: review.ringLocation.junctions.map(formatRingJunction).join(" / "),
    },
  ];
}

function createProofFields(review: CreateProofReview): ConfirmationField[] {
  return [
    ...createRingContextFields(review),
    { label: "Message", value: formatBytes(review.message), mono: true },
  ];
}

function createStatementSignFields(
  label: string,
  review: StatementStoreProductSignReview,
): ConfirmationField[] {
  return [
    { label: "App", value: label },
    { label: "Signer", value: formatProductAccount(review.account) },
    {
      label: "Statement",
      value: truncateHex(formatBytes(review.payload.subarray(0, 41))),
      mono: true,
    },
  ];
}

function createAccountAccessFields(
  review: AccountAccessReview,
): ConfirmationField[] {
  return [
    { label: "Requesting product", value: review.requestingProductId },
    { label: "Requested account", value: review.targetProductId },
  ];
}

function createIdentityDisclosureFields(
  review: IdentityDisclosureReview,
): ConfirmationField[] {
  return [{ label: "Requesting product", value: review.productId }];
}

function formatResource(resource: AllocatableResource): string {
  return resource.tag === "SmartContractAllowance"
    ? `SmartContractAllowance / ${formatDerivationIndex(resource.value)}`
    : resource.tag;
}

function createResourceAllocationFields(
  review: ResourceAllocationReview,
): ConfirmationField[] {
  return [
    {
      label: "Resources",
      value: review.resources.map(formatResource).join(", "),
    },
  ];
}

function confirmationCopy(review: ModalReview): ConfirmationCopy {
  switch (review.tag) {
    case "SignPayload":
      return { title: "Sign Transaction", action: "Sign" };
    case "SignRaw":
      return { title: "Sign Message", action: "Sign" };
    case "StatementStoreProductSign":
      return { title: "Sign Statement", action: "Sign" };
    case "CreateTransaction":
      return { title: "Sign Transaction", action: "Sign" };
    case "AccountAlias":
      return {
        title: "Alias Permission",
        action: "Allow",
        cancelAction: "Deny",
      };
    case "CreateProof":
      return {
        title: "Proof Permission",
        action: "Allow",
        cancelAction: "Deny",
      };
    case "AccountAccess":
      return {
        title: "Account Access",
        action: "Allow",
        cancelAction: "Deny",
      };
    case "IdentityDisclosure":
      return {
        title: "Identity Disclosure",
        action: "Allow",
        cancelAction: "Deny",
      };
    case "ResourceAllocation":
      return { title: "Resource Allocation", action: "Allow" };
  }
}

async function handlePreimageSubmitReview(
  review: PreimageSubmitReview,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await showPreimageSubmitModal(Number(review.size), signal);
    return true;
  } catch {
    throwIfAborted(signal);
    return false;
  }
}

async function handleConfirmationReview(
  label: string,
  review: ModalReview,
  signal: AbortSignal,
): Promise<boolean> {
  const decision = await showConfirmationModal(
    label,
    confirmationCopy(review),
    review,
    signal,
  );
  if (decision === "accepted") {
    return true;
  }
  if (decision === "dismissed" && review.tag === "IdentityDisclosure") {
    throw new Error("User dismissed identity disclosure dialog");
  }
  return false;
}

export function createUserConfirmationAdapters(
  label: string,
  modalScope: BlockingModalScope = createBlockingModalScope(),
): Required<UserConfirmationHost> {
  return {
    confirmUserAction: (review) => {
      // Dotli embeds the pairing-host runtime. RFC-0023 confirmations for
      // non-AutoSigning VRF requests belong on the paired Account Holder;
      // this local review is only emitted by the signing-host runtime.
      if (review.tag === "SignVrf") {
        return Promise.resolve(false);
      }
      return modalScope.enqueue((signal) =>
        review.tag === "PreimageSubmit"
          ? handlePreimageSubmitReview(review.value, signal)
          : handleConfirmationReview(label, review, signal),
      );
    },
  };
}
