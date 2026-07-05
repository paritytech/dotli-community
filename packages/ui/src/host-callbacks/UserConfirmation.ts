import type { UserConfirmation as UserConfirmationHost } from "@parity/truapi-host-wasm";
import { showPreimageSubmitModal } from "../preimage-modal";

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

type UserConfirmationReview = Parameters<
  Required<UserConfirmationHost>["confirmUserAction"]
>[0];

function showConfirmationModal(
  label: string,
  copy: ConfirmationCopy,
  review: UserConfirmationReview,
): Promise<boolean> {
  return new Promise((resolve) => {
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

    const cleanup = (): void => {
      backdrop.remove();
    };
    const finish = (accepted: boolean): void => {
      cleanup();
      resolve(accepted);
    };

    cancelBtn.addEventListener("click", () => {
      finish(false);
    });
    allowBtn.addEventListener("click", () => {
      finish(true);
    });
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        finish(false);
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

function formatReview(review: unknown): string {
  return JSON.stringify(
    review,
    (_key: string, value: unknown): unknown => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      if (value instanceof Uint8Array) {
        return `0x${Array.from(value, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("")}`;
      }
      return value;
    },
    2,
  );
}

function confirmationDisplay(
  label: string,
  review: UserConfirmationReview,
): { fields: ConfirmationField[] } {
  if (review.tag === "SignPayload") {
    return { fields: createSignPayloadFields(label, review.value) };
  }
  if (review.tag === "SignRaw") {
    return { fields: createSignRawFields(label, review.value) };
  }
  if (review.tag === "CreateTransaction") {
    return { fields: createTransactionFields(label, review.value) };
  }
  if (review.tag === "AccountAlias") {
    return { fields: createAccountAliasFields(review.value) };
  }
  if (review.tag === "IdentityDisclosure") {
    return { fields: createIdentityDisclosureFields(review.value) };
  }
  if (review.tag === "ResourceAllocation") {
    return { fields: createResourceAllocationFields(review.value) };
  }

  const text = formatReview(review);
  return {
    fields: [
      {
        label: "Application",
        value: label.startsWith("localhost:") ? label : `${label}.dot`,
      },
      {
        label: "Request",
        value: text.length > 180 ? `${text.slice(0, 180)}...` : text,
      },
    ],
  };
}

function truncateHex(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}...` : value;
}

type SignRawPayload = Extract<
  UserConfirmationReview,
  { tag: "SignRaw" }
>["value"]["value"]["payload"];

function formatRawPayload(payload: SignRawPayload): string {
  return truncateHex(
    payload.tag === "Bytes" ? payload.value.bytes : payload.value.payload,
  );
}

function formatProductAccount(account: {
  dotNsIdentifier: string;
  derivationIndex: number;
}): string {
  return `${account.dotNsIdentifier} / ${String(account.derivationIndex)}`;
}

type SignPayloadData = Extract<
  UserConfirmationReview,
  { tag: "SignPayload" }
>["value"]["value"]["payload"];

function createPayloadFields(
  app: string,
  signer: string,
  payload: SignPayloadData,
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
  review: Extract<UserConfirmationReview, { tag: "SignPayload" }>["value"],
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
  review: Extract<UserConfirmationReview, { tag: "SignRaw" }>["value"],
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
  review: Extract<UserConfirmationReview, { tag: "CreateTransaction" }>["value"],
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

function createAccountAliasFields(
  review: Extract<UserConfirmationReview, { tag: "AccountAlias" }>["value"],
): ConfirmationField[] {
  return [
    { label: "Requesting product", value: review.requestingProductId },
    { label: "Requested context", value: review.targetProductId },
  ];
}

function createIdentityDisclosureFields(
  review: Extract<
    UserConfirmationReview,
    { tag: "IdentityDisclosure" }
  >["value"],
): ConfirmationField[] {
  return [{ label: "Requesting product", value: review.productId }];
}

function formatResource(
  resource: Extract<
    UserConfirmationReview,
    { tag: "ResourceAllocation" }
  >["value"]["resources"][number],
): string {
  return resource.tag === "SmartContractAllowance"
    ? `SmartContractAllowance / ${String(resource.value)}`
    : resource.tag;
}

function createResourceAllocationFields(
  review: Extract<
    UserConfirmationReview,
    { tag: "ResourceAllocation" }
  >["value"],
): ConfirmationField[] {
  return [
    {
      label: "Resources",
      value: review.resources.map(formatResource).join(", "),
    },
  ];
}

function confirmationCopy(review: UserConfirmationReview): ConfirmationCopy {
  switch (review.tag) {
    case "SignPayload":
      return { title: "Sign Transaction", action: "Sign" };
    case "SignRaw":
      return { title: "Sign Message", action: "Sign" };
    case "CreateTransaction":
      return { title: "Sign Transaction", action: "Sign" };
    case "AccountAlias":
      return {
        title: "Alias Permission",
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
    case "PreimageSubmit":
      return { title: "Submit Preimage", action: "Allow" };
  }
}

async function handlePreimageSubmitReview(
  review: Extract<UserConfirmationReview, { tag: "PreimageSubmit" }>,
): Promise<boolean> {
  try {
    await showPreimageSubmitModal(Number(review.value.size));
    return true;
  } catch {
    return false;
  }
}

export function createUserConfirmationAdapters(
  label: string,
): Required<UserConfirmationHost> {
  return {
    confirmUserAction: (review) =>
      review.tag === "PreimageSubmit"
        ? handlePreimageSubmitReview(review)
        : showConfirmationModal(label, confirmationCopy(review), review),
  };
}
