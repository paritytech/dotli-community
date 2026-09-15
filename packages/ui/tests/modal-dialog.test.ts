import { afterEach, describe, expect, it, vi } from "vitest";
import { openModalDialog } from "@dotli/ui/modal-dialog";

afterEach(() => {
  document.body.replaceChildren();
});

function buildPanel(): {
  panel: HTMLDivElement;
  title: HTMLHeadingElement;
  body: HTMLDivElement;
  button: HTMLButtonElement;
} {
  const panel = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = "Sign Transaction";
  const body = document.createElement("div");
  body.textContent = "Call data";
  const button = document.createElement("button");
  button.textContent = "Cancel";
  panel.append(title, body, button);
  return { panel, title, body, button };
}

describe("modal dialog", () => {
  it("As a screen reader user, a blocking prompt opens as a modal dialog named and described by its content", () => {
    // Given
    const { panel, title, body } = buildPanel();

    // When
    const handle = openModalDialog(panel, {
      dialogClass: "signing-dialog",
      title,
      description: body,
      onCancel: vi.fn(),
    });

    // Then
    const dialog = document.querySelector<HTMLDialogElement>("dialog");
    expect(dialog).toBe(handle.dialog);
    expect(dialog?.open).toBe(true);
    expect(dialog?.className).toBe("signing-dialog");
    expect(dialog?.contains(panel)).toBe(true);
    expect(
      document.getElementById(dialog?.getAttribute("aria-labelledby") ?? ""),
    ).toBe(title);
    expect(
      document.getElementById(dialog?.getAttribute("aria-describedby") ?? ""),
    ).toBe(body);
  });

  it("As a keyboard user, focus lands on the requested control when the dialog opens", () => {
    // Given
    const { panel, title, button } = buildPanel();

    // When
    openModalDialog(panel, {
      dialogClass: "signing-dialog",
      title,
      initialFocus: button,
      onCancel: vi.fn(),
    });

    // Then
    expect(document.activeElement).toBe(button);
  });

  it("As a keyboard user, focus lands on the dialog itself when no control is preferred", () => {
    // Given
    const { panel, title } = buildPanel();

    // When
    const handle = openModalDialog(panel, {
      dialogClass: "signing-dialog",
      title,
      onCancel: vi.fn(),
    });

    // Then
    expect(document.activeElement).toBe(handle.dialog);
  });

  it("As a keyboard user, Escape reaches the owner as a cancel", () => {
    // Given
    const { panel, title } = buildPanel();
    const onCancel = vi.fn();
    const handle = openModalDialog(panel, {
      dialogClass: "signing-dialog",
      title,
      onCancel,
    });

    // When the browser turns Escape into a cancel event on the open dialog
    handle.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));

    // Then
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("As a dotli integrator, a dialog the browser closes on its own still reports a cancel and unmounts", () => {
    // Given
    const { panel, title } = buildPanel();
    const onCancel = vi.fn();
    const handle = openModalDialog(panel, {
      dialogClass: "signing-dialog",
      title,
      onCancel,
    });

    // When
    handle.dialog.close();

    // Then
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("As a user, clicking the backdrop reaches the owner but clicking inside the panel does not", () => {
    // Given
    const { panel, title, body } = buildPanel();
    const onBackdropClick = vi.fn();
    const handle = openModalDialog(panel, {
      dialogClass: "signing-dialog",
      title,
      onCancel: vi.fn(),
      onBackdropClick,
    });

    // When
    body.click();

    // Then
    expect(onBackdropClick).not.toHaveBeenCalled();

    // When
    handle.dialog.click();

    // Then
    expect(onBackdropClick).toHaveBeenCalledTimes(1);
  });

  it("As a user, backdrop clicks are inert when the owner opts out of dismissal", () => {
    // Given
    const { panel, title } = buildPanel();
    const onCancel = vi.fn();
    const handle = openModalDialog(panel, {
      dialogClass: "signing-dialog",
      title,
      onCancel,
    });

    // When
    handle.dialog.click();

    // Then
    expect(handle.dialog.open).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("As a keyboard user, closing the dialog unmounts it and returns focus to the triggering control", () => {
    // Given
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { panel, title, button } = buildPanel();
    const onCancel = vi.fn();
    const handle = openModalDialog(panel, {
      dialogClass: "signing-dialog",
      title,
      initialFocus: button,
      onCancel,
    });
    expect(document.activeElement).toBe(button);

    // When
    handle.close();

    // Then
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onCancel).not.toHaveBeenCalled();

    // When closed twice
    handle.close();

    // Then
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("As a keyboard user, focus is left alone when the triggering control has since been removed", () => {
    // Given
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { panel, title } = buildPanel();
    const handle = openModalDialog(panel, {
      dialogClass: "signing-dialog",
      title,
      onCancel: vi.fn(),
    });
    trigger.remove();

    // When
    handle.close();

    // Then
    expect(document.activeElement).not.toBe(trigger);
  });
});
