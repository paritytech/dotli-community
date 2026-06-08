import type { HostCallbacks } from "@parity/truapi-host-wasm";
import { toHexPrefixed } from "./hex";

interface ConfirmationCopy {
  title: string;
  action: string;
}

function showConfirmationModal(
  label: string,
  copy: ConfirmationCopy,
  review: Uint8Array,
): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "signing-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "signing-modal";

    const heading = document.createElement("h2");
    heading.textContent = copy.title;
    modal.appendChild(heading);

    const fields = document.createElement("div");
    fields.className = "signing-fields";

    const appField = document.createElement("div");
    appField.className = "signing-field";
    const appLabel = document.createElement("div");
    appLabel.className = "signing-field-label";
    appLabel.textContent = "Application";
    const appValue = document.createElement("div");
    appValue.className = "signing-field-value";
    appValue.textContent = label.startsWith("localhost:")
      ? label
      : `${label}.dot`;
    appField.append(appLabel, appValue);
    fields.appendChild(appField);

    const reviewField = document.createElement("div");
    reviewField.className = "signing-field";
    const reviewLabel = document.createElement("div");
    reviewLabel.className = "signing-field-label";
    reviewLabel.textContent = "Request";
    const reviewValue = document.createElement("div");
    reviewValue.className = "signing-field-value";
    const hex = toHexPrefixed(review);
    reviewValue.textContent = hex.length > 90 ? `${hex.slice(0, 90)}...` : hex;
    reviewField.append(reviewLabel, reviewValue);
    fields.appendChild(reviewField);

    modal.appendChild(fields);

    const footer = document.createElement("div");
    footer.className = "signing-modal-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "signing-btn-cancel";
    cancelBtn.textContent = "Cancel";
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

    cancelBtn.addEventListener("click", () => finish(false));
    allowBtn.addEventListener("click", () => finish(true));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        finish(false);
      }
    });
  });
}

export function createUserConfirmationAdapters(
  label: string,
): Pick<
  HostCallbacks,
  | "confirmSignPayload"
  | "confirmSignRaw"
  | "confirmCreateTransaction"
  | "confirmAccountAlias"
  | "confirmResourceAllocation"
> {
  return {
    confirmSignPayload: (review) =>
      showConfirmationModal(
        label,
        { title: "Sign Transaction", action: "Sign" },
        review,
      ),
    confirmSignRaw: (review) =>
      showConfirmationModal(
        label,
        { title: "Sign Message", action: "Sign" },
        review,
      ),
    confirmCreateTransaction: (review) =>
      showConfirmationModal(
        label,
        { title: "Create Transaction", action: "Create" },
        review,
      ),
    confirmAccountAlias: (review) =>
      showConfirmationModal(
        label,
        { title: "Alias Permission", action: "Allow" },
        review,
      ),
    confirmResourceAllocation: (review) =>
      showConfirmationModal(
        label,
        { title: "Resource Allocation", action: "Allow" },
        review,
      ),
  };
}
