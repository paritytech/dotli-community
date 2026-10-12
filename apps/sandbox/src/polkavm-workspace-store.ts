import { WORKSPACE_LIMITS } from "@dotli/shared/workspace-limits";

export const WORKSPACE_DB_NAME = "dotli-polkavm-workspaces";

export type FilesystemMetadata = {
  version: 1;
  nextInode: string;
  clockNs: string;
  entries: Array<{
    path: string;
    kind: 1 | 2;
    mtimeNs: string;
    inode: string;
  }>;
};

export type WorkspaceEntry = { path: string; bytes: Uint8Array };
export type WorkspaceProject = {
  id: string;
  name: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export type WorkspaceSnapshot = {
  project: WorkspaceProject;
  files: WorkspaceEntry[];
  metadata: FilesystemMetadata;
};
export type WorkspaceCommit = {
  modified: WorkspaceEntry[];
  removed: string[];
  metadata: FilesystemMetadata;
};

type WorkspaceState = {
  metadata: FilesystemMetadata;
  // A small byte inventory lets commits validate the complete namespace without
  // reading or cloning every unchanged file from IndexedDB.
  sizes: Array<{ path: string; size: number }>;
};
type StoredFile = WorkspaceEntry & { projectId: string };

const PROJECTS = "projects";
const STATES = "states";
const FILES = "files";
const RECENT = "recent";
const PROJECT_INDEX = "projectId";
const STORES = [PROJECTS, STATES, FILES, RECENT];
const MAX_TOTAL_BYTES =
  WORKSPACE_LIMITS.maxFiles * WORKSPACE_LIMITS.maxFileBytes;
const MAX_U64 = 0xffffffffffffffffn;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function invalid(message: string): never {
  throw new Error(`Invalid workspace: ${message}`);
}

function record(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result, key))
  ) {
    invalid(`${label} has missing or unexpected fields`);
  }
  return result;
}

function pathValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > WORKSPACE_LIMITS.maxPathBytes ||
    (value !== "/home" && !value.startsWith("/home/")) ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("\0") ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    invalid(
      "paths must be canonical UTF-8 paths under /home, at most 200 bytes",
    );
  }
  const bytes = encoder.encode(value);
  if (
    bytes.byteLength > WORKSPACE_LIMITS.maxPathBytes ||
    decoder.decode(bytes) !== value
  ) {
    invalid("paths must be valid UTF-8 and at most 200 bytes");
  }
  return value;
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function idValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    invalid("project ID must be a host-generated UUID");
  }
  return value;
}

function nameValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    value.trim().length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid(
      "project name must contain 1–200 UTF-8 bytes and no control characters",
    );
  }
  const bytes = encoder.encode(value);
  if (bytes.byteLength > 200 || decoder.decode(bytes) !== value) {
    invalid("project name must be valid UTF-8 and at most 200 bytes");
  }
  return value;
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function u64(value: unknown, label: string): bigint {
  if (
    typeof value !== "string" ||
    value.length > 20 ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    invalid(`${label} must be a canonical unsigned 64-bit decimal string`);
  }
  const number = BigInt(value);
  if (number > MAX_U64) invalid(`${label} exceeds unsigned 64-bit range`);
  return number;
}

function projectValue(value: unknown, id?: string): WorkspaceProject {
  const row = record(
    value,
    ["id", "name", "revision", "createdAt", "updatedAt"],
    "project",
  );
  const project = {
    id: idValue(row.id),
    name: nameValue(row.name),
    revision: integerValue(row.revision, "revision"),
    createdAt: integerValue(row.createdAt, "creation time"),
    updatedAt: integerValue(row.updatedAt, "update time"),
  };
  if (
    (id !== undefined && project.id !== id) ||
    project.updatedAt < project.createdAt
  ) {
    invalid("stored project identity or timestamps are inconsistent");
  }
  return project;
}

function validateSizes(sizes: Map<string, number>): void {
  if (sizes.size > WORKSPACE_LIMITS.maxFiles) invalid("file count exceeds 64");
  let total = 0;
  for (const [path, size] of sizes) {
    pathValue(path);
    if (
      path === "/home" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > WORKSPACE_LIMITS.maxFileBytes
    ) {
      invalid(`file ${path} exceeds the 1 MiB limit or has an invalid size`);
    }
    total += size;
  }
  if (total > MAX_TOTAL_BYTES) invalid("total file data exceeds 64 MiB");
}

function metadataValue(
  value: unknown,
  sizes: Map<string, number>,
): FilesystemMetadata {
  validateSizes(sizes);
  const row = record(
    value,
    ["version", "nextInode", "clockNs", "entries"],
    "filesystem metadata",
  );
  if (
    row.version !== 1 ||
    !Array.isArray(row.entries) ||
    row.entries.length >
      WORKSPACE_LIMITS.maxFiles + WORKSPACE_LIMITS.maxDirectories + 1
  ) {
    invalid("filesystem metadata version or entry count is invalid");
  }
  const nextInode = u64(row.nextInode, "nextInode");
  const clockNs = u64(row.clockNs, "clockNs");
  const paths = new Map<string, 1 | 2>();
  const inodes = new Set<string>();
  const entries: FilesystemMetadata["entries"] = [];
  let directories = 0;
  let files = 0;
  for (const raw of row.entries) {
    const entry = record(
      raw,
      ["path", "kind", "mtimeNs", "inode"],
      "metadata entry",
    );
    const path = pathValue(entry.path);
    const inode = u64(entry.inode, "inode");
    const mtimeNs = u64(entry.mtimeNs, "mtimeNs");
    if (entry.kind !== 1 && entry.kind !== 2)
      invalid(`unsupported entry kind at ${path}`);
    if (
      paths.has(path) ||
      inodes.has(inode.toString()) ||
      inode === 0n ||
      inode >= nextInode ||
      mtimeNs > clockNs
    ) {
      invalid(`duplicate path/identity or invalid inode/clock at ${path}`);
    }
    paths.set(path, entry.kind);
    inodes.add(inode.toString());
    if (entry.kind === 1) {
      if (!sizes.has(path)) invalid(`file bytes are missing for ${path}`);
      files++;
    } else {
      directories++;
    }
    entries.push({
      path,
      kind: entry.kind,
      inode: inode.toString(),
      mtimeNs: mtimeNs.toString(),
    });
  }
  if (
    paths.get("/home") !== 2 ||
    directories > WORKSPACE_LIMITS.maxDirectories + 1 ||
    files !== sizes.size
  ) {
    invalid(
      "metadata must include /home, exactly the saved byte set, and at most 256 additional directories",
    );
  }
  for (const path of paths.keys()) {
    if (path !== "/home" && paths.get(parentPath(path)) !== 2) {
      invalid(`missing or non-directory parent of ${path}`);
    }
  }
  return {
    version: 1,
    nextInode: nextInode.toString(),
    clockNs: clockNs.toString(),
    entries,
  };
}

function entriesValue(value: unknown): WorkspaceEntry[] {
  if (!Array.isArray(value) || value.length > WORKSPACE_LIMITS.maxFiles)
    invalid("file array exceeds 64 entries");
  const sizes = new Map<string, number>();
  const entries: WorkspaceEntry[] = [];
  for (const raw of value) {
    const row = record(raw, ["path", "bytes"], "file entry");
    const path = pathValue(row.path);
    if (!(row.bytes instanceof Uint8Array) || sizes.has(path))
      invalid(`invalid bytes or duplicate file ${path}`);
    // Shared memory cannot provide a stable atomic input snapshot.
    if (!(row.bytes.buffer instanceof ArrayBuffer))
      invalid(`shared file buffer is not supported at ${path}`);
    sizes.set(path, row.bytes.byteLength);
    entries.push({ path, bytes: row.bytes });
  }
  validateSizes(sizes);
  return entries;
}

function sizesOf(files: WorkspaceEntry[]): Map<string, number> {
  return new Map(files.map(({ path, bytes }) => [path, bytes.byteLength]));
}

function stateValue(value: unknown): {
  metadata: FilesystemMetadata;
  sizes: Map<string, number>;
} {
  const row = record(value, ["metadata", "sizes"], "stored filesystem");
  if (!Array.isArray(row.sizes) || row.sizes.length > WORKSPACE_LIMITS.maxFiles)
    invalid("stored byte inventory is invalid");
  const sizes = new Map<string, number>();
  for (const raw of row.sizes) {
    const entry = record(raw, ["path", "size"], "stored byte inventory entry");
    const path = pathValue(entry.path);
    if (sizes.has(path))
      invalid(`duplicate stored byte inventory entry ${path}`);
    sizes.set(path, integerValue(entry.size, "file size"));
  }
  return { metadata: metadataValue(row.metadata, sizes), sizes };
}

function validateTransition(
  previous: FilesystemMetadata,
  next: FilesystemMetadata,
  modified: Set<string>,
): void {
  const previousNext = BigInt(previous.nextInode);
  if (
    BigInt(next.nextInode) < previousNext ||
    BigInt(next.clockNs) < BigInt(previous.clockNs)
  ) {
    invalid("filesystem inode allocator and clock cannot move backwards");
  }
  const oldInodes = new Map(
    previous.entries.map((entry) => [entry.inode, entry]),
  );
  const oldRoot = previous.entries.find((entry) => entry.path === "/home")!;
  for (const entry of next.entries) {
    const old = oldInodes.get(entry.inode);
    if (old) {
      if (
        old.kind !== entry.kind ||
        BigInt(entry.mtimeNs) < BigInt(old.mtimeNs)
      ) {
        invalid(`inode kind or time changed inconsistently at ${entry.path}`);
      }
    } else if (BigInt(entry.inode) < previousNext) {
      invalid(`retired inode reused at ${entry.path}`);
    }
    if (
      entry.kind === 1 &&
      (!old || old.path !== entry.path || old.mtimeNs !== entry.mtimeNs) &&
      !modified.has(entry.path)
    ) {
      invalid(
        `changed file metadata has no corresponding byte delta at ${entry.path}`,
      );
    }
    if (entry.path === "/home" && entry.inode !== oldRoot.inode)
      invalid("the root inode cannot change");
  }
}

function sortedPaths(paths: Iterable<string>): string[] {
  const encoded = Array.from(paths, (path) => ({
    path,
    bytes: encoder.encode(path),
  }));
  encoded.sort((a, b) => {
    for (
      let index = 0;
      index < Math.min(a.bytes.length, b.bytes.length);
      index++
    ) {
      if (a.bytes[index] !== b.bytes[index])
        return a.bytes[index]! - b.bytes[index]!;
    }
    return a.bytes.length - b.bytes.length;
  });
  return encoded.map(({ path }) => path);
}

function storageError(action: string, cause: unknown): Error {
  const name = cause instanceof DOMException ? cause.name : "";
  const detail = cause instanceof Error ? cause.message : String(cause);
  let advice =
    "Retry the operation; do not clear site data, which deletes saved projects.";
  if (name === "QuotaExceededError")
    advice =
      "Browser storage is full. Free space or export saved projects before clearing any site data.";
  if (name === "InvalidStateError" || name === "VersionError")
    advice = "Close other workspace tabs and reload this page.";
  if (name === "SecurityError" || name === "NotAllowedError")
    advice =
      "Allow site storage in this browser; private or restricted browsing may disable it.";
  return new Error(
    `Workspace storage ${action} failed: ${detail}. Copy any unsaved edits before reloading. ${advice}`,
    { cause },
  );
}

export class WorkspaceStore {
  private closedReason: string | null = null;
  private readonly db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
    db.onversionchange = () => {
      this.closedReason =
        "The workspace database changed in another tab. Reload this page before reopening a workspace.";
      db.close();
    };
    db.onclose = () => {
      this.closedReason ??=
        "The browser closed workspace storage unexpectedly. Reload this page; do not clear site data.";
    };
  }

  static open(): Promise<WorkspaceStore> {
    const { promise, resolve, reject } =
      Promise.withResolvers<WorkspaceStore>();
    let request: IDBOpenDBRequest;
    let rejected = false;
    const fail = (error: unknown) => {
      rejected = true;
      reject(storageError("open", error));
    };
    try {
      if (typeof indexedDB === "undefined")
        throw new Error(
          "IndexedDB is unavailable; use a browser that allows persistent site storage",
        );
      request = indexedDB.open(WORKSPACE_DB_NAME, 2);
    } catch (error) {
      fail(error);
      return promise;
    }
    request.onblocked = () =>
      fail(
        new Error(
          "Database upgrade is blocked. Close other tabs using this site, then reopen the workspace",
        ),
      );
    request.onerror = () =>
      fail(
        request.error ??
          new Error("IndexedDB could not open the workspace database"),
      );
    request.onupgradeneeded = (event) => {
      if (rejected) {
        request.transaction!.abort();
        return;
      }
      try {
        const db = request.result;
        if (event.oldVersion === 0) {
          db.createObjectStore(PROJECTS, { keyPath: "id" });
          db.createObjectStore(STATES);
          db.createObjectStore(FILES, {
            keyPath: ["projectId", "path"],
          }).createIndex(PROJECT_INDEX, "projectId");
        }
        db.createObjectStore(RECENT, { keyPath: "id" });
      } catch (error) {
        fail(error);
        request.transaction!.abort();
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (rejected) {
        db.close();
        return;
      }
      if (STORES.some((name) => !db.objectStoreNames.contains(name))) {
        db.close();
        fail(
          new Error(
            "Workspace database schema is incomplete; saved data was not modified",
          ),
        );
        return;
      }
      resolve(new WorkspaceStore(db));
    };
    return promise;
  }

  private transaction<T>(
    mode: IDBTransactionMode,
    action: string,
    run: (
      transaction: IDBTransaction,
      result: (value: T) => void,
      fail: (error: unknown) => void,
    ) => void,
  ): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    if (this.closedReason !== null) {
      reject(new Error(this.closedReason));
      return promise;
    }
    let transaction: IDBTransaction;
    try {
      transaction =
        mode === "readwrite"
          ? this.db.transaction(STORES, mode, { durability: "strict" })
          : this.db.transaction(STORES, mode);
    } catch (error) {
      reject(storageError(action, error));
      return promise;
    }
    let value: T;
    let hasResult = false;
    let failure: unknown;
    const fail = (error: unknown) => {
      failure ??= error;
      try {
        transaction.abort();
      } catch (abortError) {
        reject(storageError(action, failure ?? abortError));
      }
    };
    transaction.onabort = () =>
      reject(
        storageError(
          action,
          failure ??
            transaction.error ??
            new Error("Transaction was aborted; saved data is unchanged"),
        ),
      );
    transaction.onerror = (event) => {
      failure ??= (event.target as IDBRequest).error ?? transaction.error;
    };
    transaction.oncomplete = () => {
      if (!hasResult)
        reject(
          storageError(
            action,
            new Error("Transaction completed without a result"),
          ),
        );
      else resolve(value!);
    };
    try {
      if (mode === "readwrite" && transaction.durability !== "strict") {
        throw new Error(
          "This browser cannot provide strict IndexedDB durability. Use a browser with strict transaction durability support",
        );
      }
      run(
        transaction,
        (result) => {
          value = result;
          hasResult = true;
        },
        fail,
      );
    } catch (error) {
      fail(error);
    }
    return promise;
  }

  list(): Promise<WorkspaceProject[]> {
    return this.transaction("readonly", "list", (transaction, result, fail) => {
      const request = transaction.objectStore(PROJECTS).getAll();
      const recent = transaction.objectStore(RECENT).getAll();
      recent.onsuccess = () => {
        try {
          const opened = new Map<string, number>(
            (recent.result as unknown[]).map((value) => {
              const row = record(value, ["id", "openedAt"], "recent project");
              return [
                idValue(row.id),
                integerValue(row.openedAt, "opened time"),
              ];
            }),
          );
          result(
            (request.result as unknown[])
              .map((row) => projectValue(row))
              .sort((a, b) => {
                const aOpened = opened.get(a.id);
                const bOpened = opened.get(b.id);
                // Creating a project that could not be opened must not replace
                // the last active project on the next launch.
                return (
                  Number(bOpened !== undefined) -
                    Number(aOpened !== undefined) ||
                  (bOpened ?? b.updatedAt) - (aOpened ?? a.updatedAt) ||
                  a.id.localeCompare(b.id)
                );
              }),
          );
        } catch (error) {
          fail(error);
        }
      };
    });
  }

  markOpened(id: string): Promise<void> {
    return this.transaction(
      "readwrite",
      "remember project",
      (transaction, result, fail) => {
        idValue(id);
        const request = transaction.objectStore(PROJECTS).get(id);
        request.onsuccess = () => {
          try {
            const project = projectValue(request.result, id);
            transaction.objectStore(RECENT).put({
              id,
              openedAt: Math.max(
                project.updatedAt,
                integerValue(Date.now(), "current time"),
              ),
            });
            result(undefined);
          } catch (error) {
            fail(error);
          }
        };
      },
    );
  }

  async create(
    name: string,
    files: WorkspaceEntry[],
    directories: string[] = [],
  ): Promise<WorkspaceSnapshot> {
    name = nameValue(name);
    const inputFiles = entriesValue(files);
    if (
      !Array.isArray(directories) ||
      directories.length > WORKSPACE_LIMITS.maxDirectories + 1
    )
      invalid("directory array exceeds the directory limit");
    const filePaths = new Set(inputFiles.map(({ path }) => path));
    const directoryPaths = new Set<string>(["/home"]);
    const explicit = new Set<string>();
    for (const raw of directories) {
      const path = pathValue(raw);
      if (explicit.has(path)) invalid(`duplicate directory ${path}`);
      explicit.add(path);
      directoryPaths.add(path);
    }
    for (const path of [...filePaths, ...directoryPaths]) {
      for (
        let parent = parentPath(path);
        parent.startsWith("/home");
        parent = parentPath(parent)
      ) {
        directoryPaths.add(parent);
      }
    }
    if (directoryPaths.size > WORKSPACE_LIMITS.maxDirectories + 1)
      invalid("directory count exceeds 256 plus /home");
    for (const path of directoryPaths) {
      if (filePaths.has(path)) invalid(`file/directory conflict at ${path}`);
    }
    const now = integerValue(Date.now(), "current time");
    const clockNs = (BigInt(now) * 1000000n).toString();
    const paths = sortedPaths([...directoryPaths, ...filePaths]);
    const sizes = sizesOf(inputFiles);
    const metadata = metadataValue(
      {
        version: 1,
        nextInode: String(paths.length + 1),
        clockNs,
        entries: paths.map((path, index) => ({
          path,
          kind: filePaths.has(path) ? 1 : 2,
          inode: String(index + 1),
          mtimeNs: clockNs,
        })),
      },
      sizes,
    );
    const project: WorkspaceProject = {
      id: idValue(crypto.randomUUID()),
      name,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    // Own buffers before yielding so caller edits cannot race persistence or the returned snapshot.
    const ownedFiles = inputFiles.map(({ path, bytes }) => ({
      path,
      bytes: new Uint8Array(bytes),
    }));
    return this.transaction("readwrite", "create", (transaction, result) => {
      transaction.objectStore(PROJECTS).add(project);
      transaction.objectStore(STATES).add(
        {
          metadata,
          sizes: Array.from(sizes, ([path, size]) => ({ path, size })),
        } satisfies WorkspaceState,
        project.id,
      );
      const store = transaction.objectStore(FILES);
      for (const file of ownedFiles)
        store.add({ projectId: project.id, ...file } satisfies StoredFile);
      result({ project, metadata, files: ownedFiles });
    });
  }

  load(id: string): Promise<WorkspaceSnapshot> {
    return this.transaction("readonly", "load", (transaction, result, fail) => {
      idValue(id);
      const projectRequest = transaction.objectStore(PROJECTS).get(id);
      const stateRequest = transaction.objectStore(STATES).get(id);
      const filesRequest = transaction
        .objectStore(FILES)
        .index(PROJECT_INDEX)
        .getAll(id);
      filesRequest.onsuccess = () => {
        try {
          if (projectRequest.result === undefined)
            throw new Error(
              "Saved workspace not found. Choose an existing project; site data may have been cleared",
            );
          const project = projectValue(projectRequest.result, id);
          const state = stateValue(stateRequest.result);
          const files = (filesRequest.result as unknown[]).map((raw) => {
            const file = record(
              raw,
              ["projectId", "path", "bytes"],
              "stored file",
            );
            if (file.projectId !== id)
              invalid("stored file belongs to another project");
            return { path: file.path, bytes: file.bytes };
          });
          const validated = entriesValue(files);
          const sizes = sizesOf(validated);
          if (
            sizes.size !== state.sizes.size ||
            Array.from(sizes).some(
              ([path, size]) => state.sizes.get(path) !== size,
            )
          ) {
            invalid("saved byte inventory does not match stored file data");
          }
          result({ project, files: validated, metadata: state.metadata });
        } catch (error) {
          fail(error);
        }
      };
    });
  }

  async commit(
    id: string,
    expectedRevision: number,
    delta: WorkspaceCommit,
  ): Promise<number> {
    idValue(id);
    integerValue(expectedRevision, "expected revision");
    if (expectedRevision === Number.MAX_SAFE_INTEGER)
      invalid("revision counter is exhausted");
    const raw = record(delta, ["modified", "removed", "metadata"], "commit");
    const modified = entriesValue(raw.modified);
    if (
      !Array.isArray(raw.removed) ||
      raw.removed.length > WORKSPACE_LIMITS.maxFiles
    )
      invalid("removed file array exceeds 64 entries");
    const removed = new Set<string>();
    const modifiedPaths = new Set(modified.map(({ path }) => path));
    for (const rawPath of raw.removed) {
      const path = pathValue(rawPath);
      if (path === "/home" || removed.has(path) || modifiedPaths.has(path))
        invalid(`duplicate or conflicting removed file ${path}`);
      removed.add(path);
    }
    // Validate shape and namespace before opening a write transaction. Unchanged
    // file sizes are filled from the authoritative inventory inside the CAS.
    const candidate = record(
      raw.metadata,
      ["version", "nextInode", "clockNs", "entries"],
      "filesystem metadata",
    );
    if (
      !Array.isArray(candidate.entries) ||
      candidate.entries.length >
        WORKSPACE_LIMITS.maxFiles + WORKSPACE_LIMITS.maxDirectories + 1
    )
      invalid("metadata entry count is invalid");
    const candidateSizes = new Map<string, number>();
    for (const entry of candidate.entries) {
      const row = record(
        entry,
        ["path", "kind", "mtimeNs", "inode"],
        "metadata entry",
      );
      if (row.kind === 1) candidateSizes.set(pathValue(row.path), 0);
    }
    const metadata = metadataValue(candidate, candidateSizes);
    const ownedModified = modified.map(({ path, bytes }) => ({
      path,
      bytes: new Uint8Array(bytes),
    }));
    return this.transaction(
      "readwrite",
      "commit",
      (transaction, result, fail) => {
        const projectStore = transaction.objectStore(PROJECTS);
        const stateStore = transaction.objectStore(STATES);
        const projectRequest = projectStore.get(id);
        const stateRequest = stateStore.get(id);
        stateRequest.onsuccess = () => {
          try {
            if (projectRequest.result === undefined)
              throw new Error(
                "Saved workspace no longer exists. Reopen the project chooser; no data was written",
              );
            const project = projectValue(projectRequest.result, id);
            if (project.revision !== expectedRevision)
              throw new Error(
                "Workspace revision conflict: another session saved this project. Reopen its saved version before editing again; this commit was not written",
              );
            const previous = stateValue(stateRequest.result);
            const sizes = previous.sizes;
            for (const path of removed) sizes.delete(path);
            for (const { path, bytes } of ownedModified)
              sizes.set(path, bytes.byteLength);
            metadataValue(metadata, sizes);
            validateTransition(previous.metadata, metadata, modifiedPaths);
            const revision = expectedRevision + 1;
            const updatedAt = Math.max(
              project.updatedAt,
              integerValue(Date.now(), "current time"),
            );
            // No writes are queued until the entire proposed state and CAS pass.
            const fileStore = transaction.objectStore(FILES);
            for (const path of removed) fileStore.delete([id, path]);
            for (const file of ownedModified)
              fileStore.put({ projectId: id, ...file } satisfies StoredFile);
            stateStore.put(
              {
                metadata,
                sizes: Array.from(sizes, ([path, size]) => ({ path, size })),
              } satisfies WorkspaceState,
              id,
            );
            projectStore.put({ ...project, revision, updatedAt });
            result(revision);
          } catch (error) {
            fail(error);
          }
        };
      },
    );
  }

  close(): void {
    this.closedReason ??=
      "Workspace storage is closed. Reopen it before accessing saved projects.";
    this.db.close();
  }
}
