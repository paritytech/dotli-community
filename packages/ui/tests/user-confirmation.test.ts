import type { UserConfirmation } from "@parity/truapi-host-wasm";
import { afterEach, describe, expect, it } from "vitest";
import { createUserConfirmationAdapters } from "@dotli/ui/host-callbacks/UserConfirmation";

type UserConfirmationReview = Parameters<
  Required<UserConfirmation>["confirmUserAction"]
>[0];

afterEach(() => {
  document.body.replaceChildren();
});

function modalFields(): Record<string, string> {
  return Object.fromEntries(
    Array.from(document.querySelectorAll(".signing-field")).map((field) => {
      const label = field.querySelector(".signing-field-label")?.textContent;
      const value = field.querySelector(".signing-field-value")?.textContent;
      return [label ?? "", value ?? ""];
    }),
  );
}

describe("user confirmation modal", () => {
  it("renders legacy payload signing as structured transaction fields", async () => {
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "SignPayload",
      value: {
        tag: "LegacyAccount",
        value: {
          signer:
            "0x2afb6161ad5d4132b6d2362330e1475be90b706b0e68ba344a80e7a1df071304",
          payload: {
            blockHash:
              "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
            blockNumber: "0x00000000",
            era: "0x00",
            genesisHash:
              "0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f",
            method: "0x0000",
            nonce: "0x00000000",
            signedExtensions: [],
            specVersion: "0x00000000",
            tip: "0x00000000000000000000000000000000",
            transactionVersion: "0x00000000",
            version: 4,
          },
        },
      },
    };

    const confirmation = confirmUserAction(review);

    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Sign Transaction",
    );
    expect(modalFields()).toEqual({
      App: "localhost:3000",
      Signer:
        "0x2afb6161ad5d4132b6d2362330e1475be90b706b0e68ba344a80e7a1df071304",
      "Genesis Hash":
        "0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f",
      "Call Data": "0x0000",
      Version: "4",
    });
    expect(document.body.textContent).not.toContain("Request");

    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    await expect(confirmation).resolves.toBe(true);
  });

  it("renders legacy raw signing as structured sign-message fields", async () => {
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "SignRaw",
      value: {
        tag: "LegacyAccount",
        value: {
          signer:
            "0x2afb6161ad5d4132b6d2362330e1475be90b706b0e68ba344a80e7a1df071304",
          payload: {
            tag: "Bytes",
            value: { bytes: "0x48656c6c6f2c20776f726c6421" },
          },
        },
      },
    };

    const confirmation = confirmUserAction(review);

    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Sign Message",
    );
    expect(modalFields()).toEqual({
      App: "localhost:3000",
      Signer:
        "0x2afb6161ad5d4132b6d2362330e1475be90b706b0e68ba344a80e7a1df071304",
      Message: "0x48656c6c6f2c20776f726c6421",
    });
    expect(document.body.textContent).not.toContain("Request");

    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    await expect(confirmation).resolves.toBe(true);
  });

  it("renders resource allocation as structured resource fields", async () => {
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "ResourceAllocation",
      value: {
        resources: [{ tag: "StatementStoreAllowance" }, { tag: "AutoSigning" }],
      },
    };

    const confirmation = confirmUserAction(review);

    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Resource Allocation",
    );
    const fields = modalFields();
    expect(fields).toEqual({
      Resources: "StatementStoreAllowance, AutoSigning",
    });
    expect(Object.keys(fields)).not.toContain("Application");
    expect(Object.keys(fields)).not.toContain("Request");

    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    await expect(confirmation).resolves.toBe(true);
  });

  it("renders account alias permission as structured product fields", async () => {
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "AccountAlias",
      value: {
        requestingProductId: "truapi-playground.dot",
        targetProductId: "truapix-playground.dot",
      },
    };

    const confirmation = confirmUserAction(review);

    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Alias Permission",
    );
    const fields = modalFields();
    expect(fields).toEqual({
      "Requesting product": "truapi-playground.dot",
      "Requested context": "truapix-playground.dot",
    });
    expect(
      document.querySelector<HTMLButtonElement>(".signing-btn-cancel")
        ?.textContent,
    ).toBe("Deny");
    expect(Object.keys(fields)).not.toContain("Application");
    expect(Object.keys(fields)).not.toContain("Request");

    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    await expect(confirmation).resolves.toBe(true);
  });

  it("renders account access permission as structured product fields", async () => {
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "AccountAccess",
      value: {
        requestingProductId: "truapi-playground.dot",
        targetProductId: "other-product.dot",
      },
    };

    const confirmation = confirmUserAction(review);

    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Account Access",
    );
    const fields = modalFields();
    expect(fields).toEqual({
      "Requesting product": "truapi-playground.dot",
      "Requested account": "other-product.dot",
    });
    expect(
      document.querySelector<HTMLButtonElement>(".signing-btn-cancel")
        ?.textContent,
    ).toBe("Deny");
    expect(Object.keys(fields)).not.toContain("Application");
    expect(Object.keys(fields)).not.toContain("Request");

    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    await expect(confirmation).resolves.toBe(true);
  });

  it("renders identity disclosure as structured product fields", async () => {
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "IdentityDisclosure",
      value: {
        productId: "truapi-playground.dot",
      },
    };

    const confirmation = confirmUserAction(review);

    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Identity Disclosure",
    );
    const fields = modalFields();
    expect(fields).toEqual({
      "Requesting product": "truapi-playground.dot",
    });
    expect(
      document.querySelector<HTMLButtonElement>(".signing-btn-cancel")
        ?.textContent,
    ).toBe("Deny");
    expect(Object.keys(fields)).not.toContain("Application");
    expect(Object.keys(fields)).not.toContain("Request");

    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    await expect(confirmation).resolves.toBe(true);
  });

  it("rejects identity disclosure when the dialog is dismissed", async () => {
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "IdentityDisclosure",
      value: {
        productId: "truapi-playground.dot",
      },
    };

    const confirmation = confirmUserAction(review);

    document.querySelector<HTMLDivElement>(".signing-modal-backdrop")?.click();

    await expect(confirmation).rejects.toThrow(
      "User dismissed identity disclosure dialog",
    );
  });
});
