import { afterEach, describe, expect, it } from "vitest";
import {
  createUserConfirmationAdapters,
  type CompatibleUserConfirmationReview as UserConfirmationReview,
} from "@dotli/ui/host-callbacks/UserConfirmation";

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
  it("As a dotli integrator, the host shows concurrent confirmation requests one at a time", async () => {
    // Given
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");

    // When
    const accountAccess = confirmUserAction({
      tag: "AccountAccess",
      value: {
        requestingProductId: "truapi-playground.dot",
        targetProductId: "other-product.dot",
      },
    });
    const identityDisclosure = confirmUserAction({
      tag: "IdentityDisclosure",
      value: { productId: "truapi-playground.dot" },
    });

    // Then
    expect(document.querySelectorAll(".signing-modal-backdrop")).toHaveLength(
      1,
    );
    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Account Access",
    );

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(accountAccess).resolves.toBe(true);

    // Then
    expect(document.querySelectorAll(".signing-modal-backdrop")).toHaveLength(
      1,
    );
    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Identity Disclosure",
    );

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(identityDisclosure).resolves.toBe(true);
    expect(document.querySelector(".signing-modal-backdrop")).toBeNull();
  });

  it("As a dotli integrator, the host renders legacy payload signing as structured transaction fields", async () => {
    // Given
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

    // When
    const confirmation = confirmUserAction(review);

    // Then
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

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it("As a dotli integrator, the host renders product payload signing with the derived account", async () => {
    // Given
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "SignPayload",
      value: {
        tag: "Product",
        value: {
          account: {
            dotNsIdentifier: "truapi-playground.dot",
            derivationIndex: { tag: "Left", value: 2 },
          },
          payload: {
            blockHash:
              "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
            blockNumber: "0x00000000",
            era: "0x00",
            genesisHash:
              "0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f",
            method: "0x0500",
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

    // When
    const confirmation = confirmUserAction(review);

    // Then
    expect(modalFields()).toEqual({
      App: "localhost:3000",
      Signer: "truapi-playground.dot / 2",
      "Genesis Hash":
        "0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f",
      "Call Data": "0x0500",
      Version: "4",
    });

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it("As a dotli integrator, the host renders legacy raw signing as structured sign-message fields", async () => {
    // Given
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

    // When
    const confirmation = confirmUserAction(review);

    // Then
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

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it("As a dotli integrator, the host renders VRF signing as structured transcript fields", async () => {
    // Given
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "SignVrf",
      value: {
        callingProductId: "truapi-playground.dot",
        request: {
          account: {
            dotNsIdentifier: "other-product.dot",
            derivationIndex: { tag: "Left", value: 4 },
          },
          transcriptLabel: "0x706f703a61697264726f70",
          items: [
            { label: "0x646f6d61696e", value: "0x01" },
            { label: "0x7369676e6572", value: "0x02" },
          ],
        },
      },
    };

    // When
    const confirmation = confirmUserAction(review);

    // Then
    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Sign VRF Transcript",
    );
    expect(modalFields()).toEqual({
      "Requesting product": "truapi-playground.dot",
      Signer: "other-product.dot / 4",
      "Transcript label": "0x706f703a61697264726f70",
      "Transcript items": "2",
    });

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it("As a dotli integrator, the host renders product transaction creation as structured fields", async () => {
    // Given
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "CreateTransaction",
      value: {
        tag: "Product",
        value: {
          signer: {
            dotNsIdentifier: "truapi-playground.dot",
            derivationIndex: { tag: "Left", value: 3 },
          },
          genesisHash:
            "0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f",
          callData: "0x0500",
          extensions: [],
          txExtVersion: 5,
        },
      },
    };

    // When
    const confirmation = confirmUserAction(review);

    // Then
    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Sign Transaction",
    );
    expect(modalFields()).toEqual({
      App: "localhost:3000",
      Signer: "truapi-playground.dot / 3",
      "Genesis Hash":
        "0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f",
      "Call Data": "0x0500",
      "Tx Ext Version": "5",
    });

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it("As a dotli integrator, the host renders resource allocation as structured resource fields", async () => {
    // Given
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "ResourceAllocation",
      value: {
        resources: [{ tag: "StatementStoreAllowance" }, { tag: "AutoSigning" }],
      },
    };

    // When
    const confirmation = confirmUserAction(review);

    // Then
    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Resource Allocation",
    );
    const fields = modalFields();
    expect(fields).toEqual({
      Resources: "StatementStoreAllowance, AutoSigning",
    });
    expect(Object.keys(fields)).not.toContain("Application");
    expect(Object.keys(fields)).not.toContain("Request");

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it("As a dotli integrator, the host renders account alias permission as structured product fields", async () => {
    // Given
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "AccountAlias",
      value: {
        callingProductId: "truapi-playground.dot",
        context: {
          productId: "truapix-playground.dot",
          suffix: { tag: "Left", value: 0 },
        },
        ringLocation: {
          chainId:
            "0x0000000000000000000000000000000000000000000000000000000000000000",
          junctions: [{ tag: "PalletInstance", value: 42 }],
        },
      },
    };

    // When
    const confirmation = confirmUserAction(review);

    // Then
    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Alias Permission",
    );
    const fields = modalFields();
    expect(fields).toEqual({
      "Requesting product": "truapi-playground.dot",
      "Context product": "truapix-playground.dot",
      "Context suffix": "0",
      Chain:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      "Ring path": "PalletInstance(42)",
    });
    expect(
      document.querySelector<HTMLButtonElement>(".signing-btn-cancel")
        ?.textContent,
    ).toBe("Deny");
    expect(Object.keys(fields)).not.toContain("Application");
    expect(Object.keys(fields)).not.toContain("Request");

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it("As a dotli integrator, the host renders proof permission as structured ring fields", async () => {
    // Given
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "CreateProof",
      value: {
        callingProductId: "truapi-playground.dot",
        context: {
          productId: "truapix-playground.dot",
          suffix: { tag: "Left", value: 0 },
        },
        ringLocation: {
          chainId:
            "0x0000000000000000000000000000000000000000000000000000000000000000",
          junctions: [{ tag: "PalletInstance", value: 42 }],
        },
        message: new Uint8Array([0x48, 0x69]),
      },
    };

    // When
    const confirmation = confirmUserAction(review);

    // Then
    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Proof Permission",
    );
    expect(modalFields()).toEqual({
      "Requesting product": "truapi-playground.dot",
      "Context product": "truapix-playground.dot",
      "Context suffix": "0",
      Chain:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      "Ring path": "PalletInstance(42)",
      Message: "0x4869",
    });

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it("As a dotli integrator, the host renders account access permission as structured product fields", async () => {
    // Given
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "AccountAccess",
      value: {
        requestingProductId: "truapi-playground.dot",
        targetProductId: "other-product.dot",
      },
    };

    // When
    const confirmation = confirmUserAction(review);

    // Then
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

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it("As a dotli integrator, the host renders identity disclosure as structured product fields", async () => {
    // Given
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "IdentityDisclosure",
      value: {
        productId: "truapi-playground.dot",
      },
    };

    // When
    const confirmation = confirmUserAction(review);

    // Then
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

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it("As a dotli integrator, the host rejects identity disclosure when the dialog is dismissed", async () => {
    // Given
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    const review: UserConfirmationReview = {
      tag: "IdentityDisclosure",
      value: {
        productId: "truapi-playground.dot",
      },
    };

    // When
    const confirmation = confirmUserAction(review);

    // When
    document.querySelector<HTMLDivElement>(".signing-modal-backdrop")?.click();

    // Then
    await expect(confirmation).rejects.toThrow(
      "User dismissed identity disclosure dialog",
    );
  });

  it("As a dotli integrator, the host allows preimage submission from its dedicated dialog", async () => {
    // Given
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    // When
    const confirmation = confirmUserAction({
      tag: "PreimageSubmit",
      value: { size: 2048n },
    });

    // Then
    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Submit Preimage",
    );
    expect(modalFields()).toEqual({ "Data size": "2 KB" });

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it("As a dotli integrator, the host denies preimage submission when the user cancels", async () => {
    // Given
    const { confirmUserAction } =
      createUserConfirmationAdapters("localhost:3000");
    // When
    const confirmation = confirmUserAction({
      tag: "PreimageSubmit",
      value: { size: 512n },
    });

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-cancel")?.click();

    // Then
    await expect(confirmation).resolves.toBe(false);
  });
});
