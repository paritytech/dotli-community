# ADR 0002: Wallet allowance inspection and resource accounting

- Status: accepted
- Date: 2026-09-24
- Applies to: experimental wallet, `packages/ui`, `packages/truapi-debug`, shared native host SDK
- Product issue: [Wallet: show allowance usage, allocations, and remaining capacity](https://github.com/paritytech/dotli-community/issues/272)

## Context

The wallet currently observes resource-allocation request outcomes. An
`Allocated` response is neither a remaining balance nor a consumption receipt.
The debug event store is a bounded, pausable, clearable capture and cannot serve
as a durable financial or resource-usage history.

Users need to understand their entitlements, which accounts hold allocations,
what an action consumed, and what remains. These questions involve different
resources and authorities:

| Resource | Allocation capacity | Current account state | Consumption |
| --- | --- | --- | --- |
| Statement Store | Per-collection publishing slots in a People-chain period | Accounts assigned to slots | Statements submitted/replaced and retained content, not slots spent per message |
| PGAS | Per-collection daily claim opportunities on Asset Hub | PGAS asset balance in each recipient account | Fees, transfers, deposits and refunds, which must be distinguished |
| Bulletin | People-chain long-term-storage claim opportunities | Bulletin account authorization with byte quota, submission quota and expiry | Stored submissions and charged bytes |

A Statement Store slot is an allowance-table assignment to an account, not a
message. Slot limits are runtime-defined and collection-specific; there is no
universal hard-coded limit of 50. An account may receive multiple assignments.
Statement expiry, allocation periods, and an ended period's grace window are
separate concepts.

PGAS claims credit a selected product-account derivation. Claiming consumes a
claim opportunity, not the credited PGAS balance. A daily claim boundary does
not establish that an existing asset balance expires. Balance alone does not
establish spendable funds or explain a historical change.

Bulletin authorizations track both submissions and bytes. Either quota, or
expiry at a Bulletin block, can prevent another submission. The People claim
period is not the authorization lifetime or stored content's retention period.

The host can prove membership in `People` and/or `LitePeople`. Allocation policy
is resource-specific: Statement Store can use eligible pools, PGAS selects its
first proven collection, and Bulletin prefers Lite membership when available.
A dashboard must not sum pools into an actionable entitlement when the allocator
does not use that combined budget.

## Decision

Build a trusted, read-only live inspector first. Add receipt-based accounting
and history as separate complete deliveries under the same product issue.
Never present allocation outcomes or balance differences as actual spending.

The full product has an overview, app breakdown, allocation details, activity
history, and entitlement comparison. The first delivery provides the overview
and live allocation/account details only. History and per-action cost controls
are not rendered until the corresponding accounting exists.

### Trusted host boundary

Expose `WorkerSigningHostRuntime.getWalletAllowanceSnapshot(productIds)` as a
host-administration operation. It is not a public TrUAPI product method, a
permission grant, or a signing operation. The browser calls it through the
existing wallet-owner runtime; an embedded product cannot enumerate another
product's resources.

The worker captures the native local-identity activation token. The native
operation checks that activation before and after asynchronous work. The SDK
rejects results for replaced identities, rejects pending calls on disposal or
worker failure, and applies a bounded request timeout. The browser additionally
fences wallet, network and product changes before displaying results.

Only public snapshot data leaves the native runtime. Root entropy, allowance
private keys, VRF material, proofs, and internal alias derivation secrets never
cross the inspection boundary.

Product IDs are trusted shell hints, validated as canonical and unique with a
bounded request size. They restrict account inspection, not chain-global discovery.
The first delivery inspects PGAS product accounts at `Index(0)` only and states
that scope. Other derivations must be added explicitly rather than implied by
an aggregate wallet balance.
Bulletin quotas use the dedicated per-product storage allowance account, not
the PGAS `Index(0)` account.

### Snapshot contract

The SDK owns one serializable `WalletAllowanceSnapshot` type. UI code imports
its type rather than maintaining a second interpretation of chain records.
Amounts that can exceed JavaScript's safe-integer range use decimal integer
strings. Decimal precision and symbols come from asset metadata; missing asset
metadata is not replaced with an assumed unit conversion.

A snapshot identifies the local identity, network suffix and inspected product
IDs, and contains independent sections:

- `statementStore`: tier membership, allocation limits/occupancy, occupied slot
  recipients, current period, reset boundary, grace and replacement cooldown.
- `pgasClaims`: tier claim budgets/occupancy, selected policy pool, daily period,
  asset identifier and runtime-defined claim amount.
- `pgasBalances`: balances for the inspected product accounts, metadata units,
  and per-account errors.
- `bulletinClaims`: long-term claim budgets/occupancy, membership, selected pool,
  period and reset boundary.
- `bulletinQuotas`: inspected allowance accounts' used, granted and remaining
  bytes/submissions, authorization status and expiration block.

Each section is either available with a chain observation or unavailable with
an explicit reason. Available observations identify genesis, finalized block
hash/number, runtime spec version and chain timestamp. Chains have independent
observations; the UI does not pretend to provide an atomic cross-chain view.

Metadata, runtime views, storage and chain time must refer to the corresponding
pinned finalized block. PGAS claim storage is on Asset Hub, but membership is
verified on People: `pgasClaims.value.membershipObservation` records that second
finalized source independently, even if the Statement section is unavailable.
Use chain time for period boundaries, not the browser clock. Batch slot queries
and bound request sizes; do not issue one network round trip per slot unnecessarily.

A missing entry after a valid, complete query can establish an unused slot or
missing authorization. RPC failures, malformed replies, missing batch keys and
decode errors cannot establish zero usage or free capacity. They produce an
unavailable result. Failure in one resource must not erase healthy sections.

### Membership, recipients and attribution

Read limits from runtime metadata/views for the selected network. Show Lite and
full membership separately and identify the allocator-selected pool. A username
or a client-side identity hint does not prove current membership.
For a nonmember, retain the runtime policy limit and any observed occupied
records, but mark the pool unselected with zero usable remaining capacity.
Losing membership does not establish that prior allocations disappeared.

Attribute an account to a product only through a verified native derivation or
an existing trusted mapping. Other recipients remain account identifiers with
unknown app/device labels. A claim-slot occupancy record does not necessarily
contain its recipient; do not invent one.

Slot occupancy, current balance and current quota are facts about a snapshot.
They are not proof that a particular browser, device or action caused a change.
No-identity, unsupported, expired, missing and unavailable states remain
separate. Existing allocations can outlive a proof or session's availability.

### Wallet presentation

Use the existing Wallet view and identity lifecycle. Present three resource
groups, with separate claim and account-capacity sections where applicable.
Keep existing Recovery, permissions, and explicit allocation controls intact.

Load on opening the verified wallet and provide a manual Refresh action.
Coalesce concurrent reads, discard stale completions, and avoid aggressive
periodic polling. Successful explicit allocation requests can trigger a fresh
read; opening or refreshing the inspector cannot invoke allocation.

Show source block/time, inspection scope, unknown attribution and unavailable
reasons. Clear old identity data immediately on identity/network changes. A
failed refresh cannot leave an old value looking newly confirmed. Display
amounts without floating-point precision loss. A PGAS total is labelled a
balance, not a guarantee of spendable funds.

Use accessible status text and headings, keyboard-accessible details and
controls, and narrow-screen layouts. Do not use color as the sole indication of
exhaustion or failure. Low-capacity warnings must identify the limiting resource;
there is no universal percentage meter for a balance without a defined budget.

## Receipt-based accounting and history

These capabilities remain part of issue #272 but are not claimed by the live
inspector delivery.

Record minimal native operation receipts with wallet/network binding, app and
account, correlation ID, resource effects and units, transaction/block evidence,
and outcome transitions. Distinguish requested, submitted, included, finalized,
failed, dropped and ambiguous outcomes. A transport success is not finality; a
failed included transaction can still incur charges.

Use a dedicated durable wallet-owned store, not debug capture. Reconcile against
authoritative state, deduplicate retries and multi-tab observations, and handle
reorgs before finality. Group related native operations into a user action only
when correlation supports it. An application-supplied label is descriptive,
not evidence of a charge or attribution.

PGAS accounting separates claims, transfers, execution fees, held deposits and
refunds. Bulletin accounting distinguishes allocation from submissions and
charged bytes; payload length is not automatically the runtime's charged size.
Statement activity distinguishes publishing, replacement and expiry from
allocation-slot occupancy.

Earlier or external activity may be reconstructed from available chain records,
but an account balance cannot reconstruct its history. Record coverage start,
backfill ranges and attribution gaps. Importing wallet entropy does not restore
a complete local history. No centralized indexer or new external service is
required by this decision; any such dependency needs a separate decision.

Do not retain message contents, uploaded content, private keys, raw signing
payloads, or sensitive proof material for resource accounting. History remains
local by default with bounded retention and explicit export/deletion behavior.

Where reliable estimates exist, show expected effects in existing confirmations
and actual effects in Activity afterward. Do not add a prompt to every action,
automatically retry ambiguous claims, or change replenishment/tier-selection
policy as a side effect of monitoring.

## Delivery and verification

1. Deliver the read-only live inspector for all three resources, including real
   native reads, the trusted SDK boundary and wallet presentation.
2. Add durable native receipts and finalized per-action accounting, then app
   totals and activity history with explicit coverage.
3. Add supported historical reconstruction and cost estimates without weakening
   source/finality/attribution guarantees.

Each delivery is independently usable; absent later functionality is not
represented by placeholder counters, synthetic histories or no-op APIs.

Verification must cover:

- refresh performs no claims, registrations, signatures or transactions;
- period rollover, separate collection policies and chain-clock boundaries;
- incomplete/malformed RPC batches cannot report free slots or zero usage;
- PGAS claim capacity remains distinct from balance and spendability;
- Bulletin exhaustion by bytes, submissions or expiry independently;
- integer precision, missing metadata and partially unavailable chains;
- old requests cannot populate a new wallet, network or product view;
- disposal/timeout cannot leave unresolved admin requests;
- the actual Wallet surface at desktop and narrow viewport sizes.

Receipt/history deliveries additionally require retry deduplication, finality
transitions, fees on failed dispatch, deposit refunds, concurrent tabs and
explicit historical coverage.

Native implementation changes require a matching generated/built client, host
binding and Wasm package set with recorded provenance. The browser must not
advertise an inspection API backed by an older Wasm binary. No application
runtime ABI change or product capability expansion is necessary.

## Alternatives rejected

- **Count debug events:** captures are incomplete and allocation responses are
  not balances, consumption or finality evidence.
- **One allowance percentage:** conflates independent claim, balance, byte,
  submission and expiry constraints.
- **Hard-code tier quotas:** silently becomes wrong across networks/upgrades.
- **Read private allowance keys into the UI:** unnecessary privilege exposure.
- **Infer app spending from account deltas:** misclassifies external transfers,
  claims, deposits, refunds and unrelated account activity.

## References

- `packages/truapi-debug/src/wallet-view.ts` and `event-store.ts`.
- `packages/ui/src/bridge.ts`: wallet-owner lifecycle and inspector controls.
- Native host `runtime/statement_allowance/collection.rs` and `slot.rs`: dynamic
  collection policies, periods and alias occupancy.
- Native host `runtime/statement_allowance/pgas.rs`: Asset Hub claims/balances.
- Native host `runtime/statement_allowance.rs`: Bulletin authorization records.
- Native host `runtime/signing_host/sso_responder.rs`: existing resource-specific
  allocation and collection-selection policy.
