// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product strings land as JSX text and every style comes from the closed mapping in customStyles.ts.
// Nodes match by tag and children by position, so an updated tree keeps a focused field's caret and text.

import { For, Match, Switch } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { RendererNode } from '@parity/truapi';
import { BoxCell, BoxNode } from './BoxNode.js';
import { ButtonNode } from './ButtonNode.js';
import { ColumnNode } from './ColumnNode.js';
import { ImageNode } from './ImageNode.js';
import { MaterialsNode } from './MaterialsNode.js';
import { RowNode } from './RowNode.js';
import { SpacerNode } from './SpacerNode.js';
import { TextFieldNode } from './TextFieldNode.js';
import { TextNode } from './TextNode.js';
import type { CustomActionHandler, CustomImageLoad, NodeTag, NodeValue } from './types.js';

/** What a rendered tree asks of the message around it. */
type NodeHost = { onAction: CustomActionHandler; loadImage: CustomImageLoad };

/** One node of a product-authored render tree. `Nil` renders nothing. */
export function CustomNode(props: NodeHost & { node: RendererNode }): JSX.Element {
  return (
    <Switch>
      <Match when={valueOf(props.node, 'String')}>{value => <>{value().text}</>}</Match>

      <Match when={valueOf(props.node, 'Box')}>
        {value => (
          <BoxNode value={value()}>
            <Children nodes={value().children} cell={BoxCell} onAction={props.onAction} loadImage={props.loadImage} />
          </BoxNode>
        )}
      </Match>

      <Match when={valueOf(props.node, 'Column')}>
        {value => (
          <ColumnNode value={value()}>
            <Children nodes={value().children} onAction={props.onAction} loadImage={props.loadImage} />
          </ColumnNode>
        )}
      </Match>

      <Match when={valueOf(props.node, 'Row')}>
        {value => (
          <RowNode value={value()}>
            <Children nodes={value().children} onAction={props.onAction} loadImage={props.loadImage} />
          </RowNode>
        )}
      </Match>

      <Match when={valueOf(props.node, 'Spacer')}>{value => <SpacerNode value={value()} />}</Match>

      <Match when={valueOf(props.node, 'Text')}>
        {value => (
          <TextNode value={value()}>
            <Children nodes={value().children} onAction={props.onAction} loadImage={props.loadImage} />
          </TextNode>
        )}
      </Match>

      <Match when={valueOf(props.node, 'Button')}>
        {value => <ButtonNode value={value()} onAction={props.onAction} />}
      </Match>

      <Match when={valueOf(props.node, 'TextField')}>
        {value => <TextFieldNode value={value()} onAction={props.onAction} />}
      </Match>

      <Match when={valueOf(props.node, 'Image')}>
        {value => <ImageNode value={value()} loadImage={props.loadImage} />}
      </Match>

      <Match when={valueOf(props.node, 'Materials')}>
        {value => (
          <MaterialsNode>
            <Children nodes={value().children} onAction={props.onAction} loadImage={props.loadImage} />
          </MaterialsNode>
        )}
      </Match>
    </Switch>
  );
}

/** `node`'s value when it is a `tag` node, for a non-keyed `Match`. */
function valueOf<Tag extends NodeTag>(node: RendererNode, tag: Tag): NodeValue<Tag> | false {
  // TypeScript cannot narrow a union by a generic tag.
  return node.tag === tag ? ((node as { value?: unknown }).value as NodeValue<Tag>) : false;
}

/** A cell that adds no element. */
function Bare(props: { children?: JSX.Element }): JSX.Element {
  return <>{props.children}</>;
}

/** A node's children by position, each in the parent's `cell` when it places them in cells. */
function Children(
  props: NodeHost & { nodes: RendererNode[]; cell?: (props: { children?: JSX.Element }) => JSX.Element },
): JSX.Element {
  return (
    <For each={props.nodes} keyed={false}>
      {child => {
        const Cell = props.cell ?? Bare;
        return (
          <Cell>
            <CustomNode node={child()} onAction={props.onAction} loadImage={props.loadImage} />
          </Cell>
        );
      }}
    </For>
  );
}
