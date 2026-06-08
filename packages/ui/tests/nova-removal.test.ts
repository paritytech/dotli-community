import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const forbiddenPackages = [
  "@novasamatech/host-api",
  "@novasamatech/host-container",
  "@novasamatech/host-papp",
  "@novasamatech/sdk-statement",
  "@novasamatech/statement-store",
  "@novasamatech/storage-adapter",
] as const;

async function collectFiles(
  root: string,
  shouldInclude: (path: string) => boolean,
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "dist" ||
          entry.name === "node_modules" ||
          entry.name === ".turbo" ||
          entry.name === ".git"
        ) {
          return [];
        }
        return collectFiles(path, shouldInclude);
      }
      return shouldInclude(path) ? [path] : [];
    }),
  );

  return files.flat();
}

describe("Nova host dependency removal", () => {
  it("keeps runtime manifests, lockfile, and source free of Nova packages", async () => {
    const manifestFiles = await collectFiles(repoRoot, (path) =>
      path.endsWith("package.json"),
    );
    const sourceFiles = await collectFiles(repoRoot, (path) =>
      /\/(apps|packages)\/[^/]+\/src\/.*\.[cm]?tsx?$/.test(path),
    );
    const files = [
      ...manifestFiles,
      join(repoRoot, "bun.lock"),
      ...sourceFiles,
    ];

    const violations: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const packageName of forbiddenPackages) {
        if (content.includes(packageName)) {
          violations.push(`${relative(repoRoot, file)} imports ${packageName}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
