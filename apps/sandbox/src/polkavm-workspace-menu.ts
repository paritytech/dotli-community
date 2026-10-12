// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { WORKSPACE_LIMITS } from "@dotli/shared/workspace-limits";
import {
  type WorkspaceEntry,
  type WorkspaceSnapshot,
  type WorkspaceStore,
} from "./polkavm-workspace-store";
import {
  exportWorkspaceTar,
  importWorkspaceTar,
  WORKSPACE_TAR_MAX_BYTES,
} from "./polkavm-workspace-archive";
import { createSpaWorkspaceEntries } from "./polkavm-workspace-template";

export type WorkspaceChoice =
  | "recent"
  | "new"
  | "import"
  | "chain"
  | "template";

const choiceTitles: Record<WorkspaceChoice, string> = {
  recent: "Open Recent Project",
  new: "New Project",
  import: "Import Project",
  chain: "Import from Chain",
  template: "New from Template: SPA Starter",
};

const storageNotice =
  "Projects are private to this browser and site, not a backup or a synchronized desktop folder. Clearing site data, browser eviction, or a private-browsing session ending can permanently remove them. Export saved work to keep a separate copy.";
let dialogSequence = 0;

function button(label: string, primary = false): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.className = primary
    ? "dotli-file-consent-approve"
    : "dotli-file-consent-cancel";
  return element;
}

function paragraph(text: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.textContent = text;
  return element;
}

function modal(
  surface: HTMLElement,
  title: string,
): {
  dialog: HTMLDialogElement;
  heading: HTMLHeadingElement;
  remove: () => void;
} {
  const style = document.createElement("style");
  style.textContent = `
    .dotli-workspace-dialog{box-sizing:border-box;width:min(540px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:calc(100dvh - 32px);overflow:auto;margin:auto;border:1px solid #ffffff26;border-radius:14px;padding:22px;background:#17181c;color:#fff;box-shadow:0 24px 80px #000b;font:14px/1.5 system-ui,sans-serif}
    .dotli-workspace-dialog::backdrop{background:#000a}
    .dotli-workspace-dialog h2{margin:0 0 12px;font-size:20px;overflow-wrap:anywhere}
    .dotli-workspace-dialog h3{margin:18px 0 8px;font-size:15px}
    .dotli-workspace-dialog p{margin:10px 0;color:#b8bbc3;overflow-wrap:anywhere}
    .dotli-workspace-dialog label{display:block;margin:12px 0 6px}
    .dotli-workspace-dialog input:not([type=file]),.dotli-workspace-dialog select{box-sizing:border-box;width:100%;margin:0 0 12px;padding:8px;border:1px solid #ffffff30;border-radius:7px;background:#0b0c0f;color:#fff;font:inherit}
    .dotli-workspace-dialog button{border:0;border-radius:7px;padding:8px 12px;font:600 13px system-ui,sans-serif;cursor:pointer;background:#303238;color:#fff}
    .dotli-workspace-dialog .dotli-file-consent-approve{background:#e6007a}
    .dotli-workspace-dialog button:disabled{opacity:.55;cursor:wait}
    .dotli-workspace-dialog :focus-visible{outline:2px solid #ff74bb;outline-offset:3px}
    .dotli-workspace-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
    .dotli-workspace-dialog [hidden]{display:none!important}
    .dotli-workspace-dialog [role=alert]{color:#ffb9c6;white-space:pre-wrap}
    .dotli-workspace-toggle{position:absolute;top:12px;right:12px;z-index:3;border:1px solid #ffffff30;border-radius:7px;padding:7px 11px;background:#090b0de8;color:#fff;font:600 12px/1.2 system-ui,sans-serif;cursor:pointer}
    .dotli-workspace-toggle:focus-visible{outline:2px solid #ff74bb;outline-offset:3px}
  `;
  const dialog = document.createElement("dialog");
  dialog.className = "dotli-file-consent dotli-workspace-dialog";
  const heading = document.createElement("h2");
  heading.id = `dotli-workspace-title-${++dialogSequence}`;
  heading.textContent = title;
  dialog.setAttribute("aria-labelledby", heading.id);
  dialog.append(heading);
  // Native modal dialogs provide focus containment; do not bind editor shortcuts.
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  surface.append(style, dialog);
  return {
    dialog,
    heading,
    remove: () => {
      dialog.close();
      dialog.remove();
      style.remove();
    },
  };
}

function actions(...buttons: HTMLButtonElement[]): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "dotli-workspace-actions";
  element.append(...buttons);
  return element;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function storageError(error: unknown): string {
  return `${errorMessage(error)}\nNothing was opened. Retry after checking available browser storage and site permissions. Do not clear site data: that deletes saved projects.`;
}

function picker(directory = false): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "file";
  input.hidden = true;
  if (directory) input.setAttribute("webkitdirectory", "");
  return input;
}

async function copiedFiles(
  selected: File[],
  directory: boolean,
): Promise<WorkspaceEntry[]> {
  if (selected.length === 0) {
    throw new Error(
      "No files were selected. Directory pickers cannot preserve empty directories; import a TAR for a complete tree.",
    );
  }
  if (selected.length > WORKSPACE_LIMITS.maxFiles) {
    throw new Error(
      `Choose at most ${WORKSPACE_LIMITS.maxFiles} files, or split the project into smaller projects.`,
    );
  }
  // Check every size before allocating any file contents.
  for (const file of selected) {
    if (file.size > WORKSPACE_LIMITS.maxFileBytes)
      throw new Error(`${file.name} exceeds the 1 MiB per-file limit.`);
  }
  const root = selected[0].webkitRelativePath.split("/")[0];
  const entries: WorkspaceEntry[] = [];
  for (const file of selected) {
    let relative = file.name;
    if (directory) {
      const parts = file.webkitRelativePath.split("/");
      if (parts.length < 2 || parts[0] !== root)
        throw new Error(
          "The browser did not supply one complete directory selection. Try again, or import a TAR.",
        );
      relative = parts.slice(1).join("/");
    }
    entries.push({
      path: `/home/${relative}`,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  }
  return entries;
}

/** Keep the current editor intact until selection and writer acquisition succeed. */
export function chooseWorkspace(
  surface: HTMLElement,
  store: WorkspaceStore,
  choice: WorkspaceChoice,
  selectProject: (id: string) => Promise<void>,
  parentOrigin: string | null,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const view = modal(surface, choiceTitles[choice]);
  const { dialog } = view;
  const previousFocus = document.activeElement;
  const notice = paragraph(storageNotice);
  const limits = paragraph(
    `Workspace root: /home · Up to ${WORKSPACE_LIMITS.maxFiles} files, ${WORKSPACE_LIMITS.maxDirectories} directories, 1 MiB per file and ${WORKSPACE_LIMITS.maxPathBytes}-byte paths.`,
  );
  const savedHeading = document.createElement("h3");
  savedHeading.textContent = "Reopen a saved project";
  const savedLabel = document.createElement("label");
  const saved = document.createElement("select");
  saved.id = `dotli-workspace-saved-${dialogSequence}`;
  savedLabel.htmlFor = saved.id;
  savedLabel.textContent = "Saved projects";
  const reopen = button("Open saved project", true);
  const refresh = button("Refresh list");
  const newHeading = document.createElement("h3");
  newHeading.textContent = "Create a separate project";
  const form = document.createElement("form");
  const nameLabel = document.createElement("label");
  const name = document.createElement("input");
  name.type = "text";
  name.id = `dotli-workspace-name-${dialogSequence}`;
  name.autocomplete = "off";
  name.placeholder = "Project name (imports can use the source name)";
  nameLabel.htmlFor = name.id;
  nameLabel.textContent = "New project name";
  const addressLabel = document.createElement("label");
  const address = document.createElement("input");
  address.type = "text";
  address.id = `dotli-workspace-address-${dialogSequence}`;
  address.autocomplete = "off";
  address.spellcheck = false;
  address.required = choice === "chain";
  address.placeholder = "peopl.paseo";
  addressLabel.htmlFor = address.id;
  addressLabel.textContent = "Deployed app address";
  if (choice === "chain") form.append(addressLabel, address);
  const create = button(
    choice === "chain"
      ? "Import deployed files"
      : choice === "template"
        ? "Create SPA project"
        : "Create empty project",
    true,
  );
  create.type = "submit";
  const importTar = button("Import TAR…");
  const importDirectory = button("Import copied directory…");
  const importFiles = button("Import copied files…");
  const tarInput = picker();
  tarInput.accept = ".tar,application/x-tar";
  const directoryInput = picker(true);
  directoryInput.multiple = true;
  const filesInput = picker();
  filesInput.multiple = true;
  const copyNotice = paragraph(
    "Imports copy files into this browser; editing never changes the original desktop files. A directory picker cannot preserve empty directories. Use an uncompressed TAR for complete tree transfer, including hidden files and empty directories. Links and special nodes are not supported.",
  );
  form.append(
    nameLabel,
    name,
    choice === "import"
      ? actions(importTar, importDirectory, importFiles)
      : actions(create),
  );
  const status = paragraph("");
  status.setAttribute("role", "status");
  const error = paragraph("");
  error.setAttribute("role", "alert");
  const cancel = button("Cancel");
  dialog.append(notice, limits);
  if (choice === "recent") {
    dialog.append(savedHeading, savedLabel, saved, actions(reopen, refresh));
  } else {
    if (choice === "template") {
      dialog.append(
        paragraph(
          "A working, dependency-free counter app with index.html, styles.css, and app.js. Edit and save in Zed, export and extract the project, then open index.html in a browser. No compiler or development server is required.",
        ),
      );
      name.value = "My browser app";
    }
    dialog.append(newHeading, form);
    if (choice === "import") dialog.append(copyNotice);
    if (choice === "chain")
      dialog.append(
        paragraph(
          "Copies all deployed files into a separate saved project without running or publishing the app. Deployed JavaScript may be bundled or minified, not repository source; use Make Code Readable on a saved file. Empty directories are not included in the deployed file map.",
        ),
      );
  }
  dialog.append(
    status,
    error,
    actions(cancel),
    tarInput,
    directoryInput,
    filesInput,
  );
  let busy = false;
  let settled = false;
  let hasProjects = false;
  let chainFetch: AbortController | null = null;
  const controls = [
    reopen,
    refresh,
    create,
    importTar,
    importDirectory,
    importFiles,
    cancel,
    saved,
    name,
    address,
  ];
  const setBusy = (value: boolean): void => {
    busy = value;
    dialog.setAttribute("aria-busy", String(value));
    for (const control of controls) control.disabled = value;
    reopen.disabled = value || !hasProjects;
    saved.disabled = value || !hasProjects;
  };
  const finish = (selected = false): void => {
    if (settled) return;
    settled = true;
    view.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
      previousFocus.focus({ preventScroll: true });
    if (selected) resolve();
    else
      reject(new DOMException("Workspace selection cancelled", "AbortError"));
  };
  const loadList = async (): Promise<void> => {
    if (busy || settled) return;
    setBusy(true);
    status.textContent = "Loading saved projects…";
    error.textContent = "";
    try {
      const projects = await store.list();
      if (settled) return;
      saved.replaceChildren();
      hasProjects = projects.length > 0;
      for (const project of projects) {
        const option = document.createElement("option");
        option.value = project.id;
        option.textContent = `${project.name} · saved ${new Date(project.updatedAt).toLocaleString()}`;
        saved.append(option);
      }
      status.textContent = hasProjects
        ? "Projects are ordered by most recently opened."
        : "No saved projects yet. Use New Project or Import from the Project menu.";
    } catch (failure) {
      error.textContent = storageError(failure);
      status.textContent =
        "Could not list saved projects. Use Refresh list to retry.";
    } finally {
      if (!settled) setBusy(false);
    }
  };
  const openProject = async (
    description: string,
    operation: () => Promise<string>,
    importing = false,
  ): Promise<void> => {
    if (busy || settled) return;
    setBusy(true);
    status.textContent = description;
    error.textContent = "";
    try {
      const id = await operation();
      if (settled) return;
      await selectProject(id);
      finish(true);
    } catch (failure) {
      if (settled) return;
      error.textContent = importing
        ? `${errorMessage(failure)}\nImport was not opened. Check the source and workspace limits, then retry. If storage is full, free space without clearing this site's saved project data.`
        : storageError(failure);
      status.textContent = "";
    } finally {
      if (!settled) setBusy(false);
    }
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (choice === "import") return;
    const projectName = name.value.trim();
    if (choice === "chain") {
      if (busy || settled) return;
      const controller = new AbortController();
      chainFetch = controller;
      void openProject(
        "Connecting to the chain import service…",
        async () => {
          cancel.disabled = false;
          try {
            if (parentOrigin === null) {
              throw new Error("Chain import requires an authenticated host.");
            }
            // Older standalone hosts may serve workspace modules without chain import.
            const { fetchChainWorkspace } =
              await import("./polkavm-workspace-chain");
            const imported = await fetchChainWorkspace(
              address.value,
              parentOrigin,
              (message) => {
                if (!settled) status.textContent = message;
              },
              controller.signal,
            );
            controller.signal.throwIfAborted();
            chainFetch = null;
            cancel.disabled = true;
            status.textContent = `Saving ${imported.name} · ${imported.cid} as a separate project…`;
            return (
              await store.create(projectName || imported.name, imported.files)
            ).project.id;
          } finally {
            if (chainFetch === controller) chainFetch = null;
          }
        },
        true,
      );
      return;
    }
    if (!projectName) {
      error.textContent = "Enter a name for the new project.";
      name.focus();
      return;
    }
    void openProject(
      "Creating and saving project…",
      async () =>
        (
          await store.create(
            projectName,
            choice === "template" ? createSpaWorkspaceEntries() : [],
          )
        ).project.id,
    );
  });
  reopen.addEventListener("click", () => {
    if (saved.value)
      void openProject("Opening saved project…", async () => saved.value);
  });
  refresh.addEventListener("click", () => void loadList());
  importTar.addEventListener("click", () => tarInput.click());
  importDirectory.addEventListener("click", () => directoryInput.click());
  importFiles.addEventListener("click", () => filesInput.click());
  tarInput.addEventListener("change", () => {
    const file = tarInput.files?.[0];
    tarInput.value = "";
    if (file === undefined) return;
    const projectName =
      name.value.trim() ||
      file.name.replace(/\.tar$/i, "") ||
      "Imported project";
    void openProject(
      "Validating TAR and saving a separate project…",
      async () => {
        if (file.size > WORKSPACE_TAR_MAX_BYTES)
          throw new Error(
            "TAR archive is too large. Split it into smaller projects before importing.",
          );
        const imported = importWorkspaceTar(
          new Uint8Array(await file.arrayBuffer()),
        );
        return (
          await store.create(projectName, imported.files, imported.directories)
        ).project.id;
      },
      true,
    );
  });
  const importSelection = (
    input: HTMLInputElement,
    directory: boolean,
  ): void => {
    const selected = Array.from(input.files ?? []);
    input.value = "";
    const sourceName = directory
      ? selected[0]?.webkitRelativePath.split("/")[0]
      : selected[0]?.name;
    const projectName = name.value.trim() || sourceName || "Imported project";
    void openProject(
      "Copying selected files and saving a separate project…",
      async () =>
        (
          await store.create(
            projectName,
            await copiedFiles(selected, directory),
          )
        ).project.id,
      true,
    );
  };
  directoryInput.addEventListener("change", () =>
    importSelection(directoryInput, true),
  );
  filesInput.addEventListener("change", () =>
    importSelection(filesInput, false),
  );
  const cancelSelection = (): void => {
    if (chainFetch !== null) {
      chainFetch.abort(
        new DOMException("Chain import cancelled", "AbortError"),
      );
      chainFetch = null;
      finish();
    } else if (!busy) finish();
  };
  cancel.addEventListener("click", cancelSelection);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelSelection();
  });
  dialog.showModal();
  // Keep focus in the dialog while its controls are disabled for the initial read.
  dialog.tabIndex = -1;
  dialog.focus();
  if (choice === "recent") {
    void loadList().then(() => {
      if (!settled) (hasProjects ? saved : cancel).focus();
    });
  } else {
    (choice === "chain" ? address : name).focus();
  }
  return promise;
}

export function installWorkspaceMenu(
  surface: HTMLElement,
  options: {
    name: string;
    pause: (paused: boolean) => void;
    changeProject: (choice: WorkspaceChoice) => Promise<void>;
    exportProject: () => Promise<WorkspaceSnapshot>;
  },
): { cleanup(): void } {
  const view = modal(surface, options.name);
  const { dialog, heading } = view;
  const toggle = button("Project");
  toggle.className = "dotli-workspace-toggle";
  toggle.title = `Project: ${options.name}`;
  toggle.setAttribute("aria-haspopup", "dialog");
  toggle.setAttribute("aria-expanded", "false");
  const resume = button("Resume editing", true);
  const exportSaved = button("Export SAVED project as TAR…");
  const projectActions: [HTMLButtonElement, WorkspaceChoice][] = [
    [button("Open Recent…"), "recent"],
    [button("New Project…"), "new"],
    [button("Import Project…"), "import"],
    [button("Import from Chain…"), "chain"],
    [button("New from Template: SPA Starter…"), "template"],
  ];
  const controls = [
    resume,
    exportSaved,
    ...projectActions.map(([control]) => control),
  ];
  const menuActions = actions(...controls);
  const explanation = paragraph(
    "The editor is paused while this menu is open. Export includes every saved file and directory, not unsaved editor buffers. Resume and save in Zed before exporting your latest edits.",
  );
  const confirm = document.createElement("section");
  confirm.hidden = true;
  const warning = paragraph(
    "Opening another project closes this editor. Save in Zed first to keep unsaved changes. Cancelling project selection keeps this editor and its buffers open. Saved files remain in this browser-local project.",
  );
  const keep = button("Keep editing", true);
  const discard = button("Continue without saving");
  confirm.append(warning, actions(keep, discard));
  const status = paragraph("");
  status.setAttribute("role", "status");
  const error = paragraph("");
  error.setAttribute("role", "alert");
  dialog.append(
    paragraph(storageNotice),
    explanation,
    menuActions,
    confirm,
    status,
    error,
  );
  surface.append(toggle);
  let previousFocus: HTMLElement | null = null;
  let busy = false;
  let disposed = false;
  let choice: WorkspaceChoice = "recent";
  const close = (): void => {
    if (busy || !dialog.open || disposed) return;
    dialog.close();
    toggle.setAttribute("aria-expanded", "false");
    options.pause(false);
    const focus =
      previousFocus?.isConnected && previousFocus !== toggle
        ? previousFocus
        : (surface.querySelector<HTMLCanvasElement>("canvas") ?? toggle);
    focus.focus({ preventScroll: true });
  };
  toggle.addEventListener("click", () => {
    if (busy || dialog.open || disposed) return;
    previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    heading.textContent = options.name;
    menuActions.hidden = false;
    explanation.hidden = false;
    confirm.hidden = true;
    error.textContent = "";
    options.pause(true);
    dialog.showModal();
    toggle.setAttribute("aria-expanded", "true");
    resume.focus();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  resume.addEventListener("click", close);
  keep.addEventListener("click", close);
  for (const [control, action] of projectActions) {
    control.addEventListener("click", () => {
      choice = action;
      heading.textContent = choiceTitles[action];
      menuActions.hidden = true;
      explanation.hidden = true;
      confirm.hidden = false;
      error.textContent = "";
      keep.focus();
    });
  }
  discard.addEventListener("click", async () => {
    if (busy || disposed) return;
    busy = true;
    dialog.close();
    toggle.setAttribute("aria-expanded", "false");
    try {
      // Stay paused until the chooser is cancelled or the next editor starts.
      await options.changeProject(choice);
    } catch (failure) {
      if (!disposed) {
        error.textContent = errorMessage(failure);
        dialog.showModal();
        toggle.setAttribute("aria-expanded", "true");
      }
    } finally {
      busy = false;
      if (!disposed && !dialog.open) {
        options.pause(false);
        const focus =
          previousFocus?.isConnected && previousFocus !== toggle
            ? previousFocus
            : (surface.querySelector<HTMLCanvasElement>("canvas") ?? toggle);
        focus.focus({ preventScroll: true });
      }
    }
  });
  exportSaved.addEventListener("click", async () => {
    if (busy || disposed) return;
    busy = true;
    dialog.setAttribute("aria-busy", "true");
    for (const control of controls) control.disabled = true;
    error.textContent = "";
    status.textContent =
      "Reading the saved project and preparing a TAR download…";
    try {
      const snapshot = await options.exportProject();
      if (disposed) return;
      const blob = exportWorkspaceTar(snapshot);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const filename = `${snapshot.project.name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim() || "workspace"}.tar`;
      link.href = url;
      link.download = filename;
      link.hidden = true;
      dialog.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        // Give the browser time to start the download before releasing its data.
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      status.textContent = `Download requested: ${filename}. Check your browser's downloads. Only saved files are included; originals on your desktop are never synchronized.`;
    } catch (failure) {
      if (!disposed) {
        status.textContent = "";
        error.textContent = `${errorMessage(failure)}\nExport failed. Your project was not changed. Retry, check browser download permissions, and save any unsaved files in Zed before trying again.`;
      }
    } finally {
      if (!disposed) {
        busy = false;
        dialog.setAttribute("aria-busy", "false");
        for (const control of controls) control.disabled = false;
        exportSaved.focus();
      }
    }
  });
  return {
    cleanup: () => {
      if (disposed) return;
      disposed = true;
      if (dialog.open) options.pause(false);
      view.remove();
      toggle.remove();
    },
  };
}
