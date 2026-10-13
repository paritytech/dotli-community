# `@dotli/ui-entities`

Domain building blocks for the UI: one entity or one control each, such as a chat bubble, a permission row or an account
icon. They show domain data and take everything as props.

## Responsibility

- Views for accounts, chat messages, permissions, the appearance setting, network health, a chain's peers and recent
  blocks.
- The domain icons: the account, the shields and the permissions.
- Pure helpers beside them: display names and initials, relative time, the permission's icon, the health word, the block
  strip's motion and countdown.
- Not owned: flows, stores and data sources. A component that owns a subscription, an action and its error copy is a
  flow and lives in the app. A screen both apps show goes to the shared widgets.

## Design

- Props only. An entity reads no store and fetches nothing. It reports the user's intent through a callback such as
  `CustomActionHandler`.
- Entities group by domain: account, chat, permissions, settings and chains. Each Solid view has a CSS module beside it.
  Most have a story that carries their tests.
- Each icon is a Solid component that draws an `<svg>` in `currentColor`, one module per icon, and takes the UI layer's
  icon props. An icon with no domain comes from the UI layer's icons.
- Chat: `MessageBubble` renders a `ChatMessage`. `CustomNode` renders a product's custom body. Both draw their actions
  with one chat action button. The echo hold and relative time logic is kept apart from the views so it runs under Node.
- Lint holds its imports to the UI layer and TrUAPI's types, for dynamic imports too.
- Solid views load in islands and lazy chunks, never on a boot path. Boot modules must not import this package.

## Public API

### `@dotli/ui-entities`

- Account: `AccountAvatar`, `AccountSession`, `sessionDisplayName`, `sessionInitials`, `sessionUsername`.
- Chains: `ChainGroup`, `ChainSummary`, `ChainBar`, `BarHealth`, `ChainUse`, `HISTORY_SLOTS`, `healthWord`,
  `NetworkHealth`.
- Chat: `ContactIcon`, `ContactRow`, `chatUnreadLabel`, `MessageBubble`, `CustomBody`, `CustomNode`,
  `CustomActionHandler`, `ResizeHandle`, `ChatMessage`.
- Permissions: `PermissionRow`, `permissionIcon` (a permission's icon component), and the types `PermissionEntry`,
  `PermissionName`, `PermissionStatus`.
- Settings: `AppearancePicker`, `ThemeChoice`.
- Icons: `UserIcon`, `TrustedShieldIcon`, `VerifiedShieldIcon`.
