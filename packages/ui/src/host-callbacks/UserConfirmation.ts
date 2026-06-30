import type { HostCallbacks } from "@parity/truapi-host-wasm";
import { showPreimageSubmitModal } from "../preimage-modal";

interface ConfirmationCopy {
  title: string;
  action: string;
}

type UserConfirmationReview = Parameters<
  Required<HostCallbacks>["confirmUserAction"]
>[0];

function showConfirmationModal(
  label: string,
  copy: ConfirmationCopy,
  review: unknown,
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
    const text = formatReview(review);
    reviewValue.textContent =
      text.length > 180 ? `${text.slice(0, 180)}...` : text;
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

function confirmationCopy(review: UserConfirmationReview): ConfirmationCopy {
  switch (review.tag) {
    case "SignPayload":
      return { title: "Sign Transaction", action: "Sign" };
    case "SignRaw":
      return { title: "Sign Message", action: "Sign" };
    case "CreateTransaction":
      return { title: "Create Transaction", action: "Create" };
    case "AccountAlias":
      return { title: "Alias Permission", action: "Allow" };
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
): Pick<Required<HostCallbacks>, "confirmUserAction"> {
  return {
    confirmUserAction: (review) =>
      review.tag === "PreimageSubmit"
        ? handlePreimageSubmitReview(review)
        : showConfirmationModal(label, confirmationCopy(review), review),
  };
}
