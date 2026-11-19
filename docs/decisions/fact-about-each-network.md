# A fact about each network the table does not hold

A developer builds UI that depends on a fact about the network the visitor picked, such as whether its tokens have real
value. The build keeps a static table that describes each network it knows, a deployment enables some of them and the
visitor picks one at runtime. No field of the table says the fact. The question is where the fact comes from:

- a field on each network's entry
- a derivation from the network's chain identity against a known list
- a build variable the deployment sets

## How to resolve

1. Add the fact as a required field on each network's entry in the table, set by hand for every network.
2. Keep the field out of the runtime override, as the entry's chain identity is.
3. Have the UI read the field from the exported table for the picked network.
4. Do not derive the fact from the chain's identity through a fixed list of known chains, and do not take it from a
   build variable, which describes the deployment rather than the network the visitor picked.

The owner chose the per-network field over both other sources, though the owner's first request allowed a build variable
when no good indicator could be found. The owner stated no further reason.

## Example

```ts
export interface NetworkEntry {
  readonly label: string;
  readonly relayGenesisHash: HexString;
  /** Tokens on this network have no real value. */
  readonly testnet: boolean;
}

export const NETWORKS = {
  mainland: { label: 'Mainland', relayGenesisHash: '0x91b1…', testnet: false },
  sandpit: { label: 'Sandpit', relayGenesisHash: '0x6408…', testnet: true },
} satisfies Record<string, NetworkEntry>;

// The UI reads the picked network's entry.
const showsTestNotice = NETWORKS[pickedNetwork].testnet;
```

Not this:

```ts
const VALUE_BEARING_RELAYS = new Set(['0x91b1…']);
const showsTestNotice = !VALUE_BEARING_RELAYS.has(NETWORKS[pickedNetwork].relayGenesisHash);

// Or: one answer for the whole deployment, whatever network the visitor picked.
const showsTestNotice = import.meta.env.PUBLIC_TESTNET === 'true';
```

## Cases

- The landing page showed a notice that a network is a test network whose tokens have no real value, and it had to show
  only on real test networks. The owner asked for the best indicator, with a build variable as the fallback, and chose a
  required test-network field on each network's config entry, not overridable at runtime, over a derivation from the
  relay chain's genesis hash and over a build variable. (feat/landing-horizon, PR #493,
  docs/_plans/testnet-notice-design.md)

Status: active
