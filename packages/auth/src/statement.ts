// Re-exports from the novasamatech statement-store / sdk-statement packages.
// @dotli/auth owns the novasamatech dependency graph; consumers in other
// packages (e.g. @dotli/ui's host-callbacks) should route through here so
// they don't take direct deps on those SDKs.

export {
  createSr25519Prover,
  type StatementStoreAdapter,
} from "@novasamatech/statement-store";

export type {
  Proof,
  SignedStatement,
  Statement,
} from "@novasamatech/sdk-statement";
