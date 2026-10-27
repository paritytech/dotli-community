// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { DockPosition } from './model/createDockStorage.js';
import type { PanelSection } from './model/createSectionStorage.js';
import { Button } from './shared/Button.js';
import { SectionTabs } from './SectionTabs.js';
import { ChevronDownIcon } from './icons/ChevronDownIcon.js';
import { ChevronUpIcon } from './icons/ChevronUpIcon.js';
import { CloseIcon } from './icons/CloseIcon.js';
import { DockBottomIcon } from './icons/DockBottomIcon.js';
import { DockRightIcon } from './icons/DockRightIcon.js';
import s from './Header.module.css';

export function Header(props: {
  section: PanelSection;
  /** Called while collapsed too, where it also expands the panel. */
  onSelectSection: (section: PanelSection) => void;
  collapsed: boolean;
  dock: DockPosition;
  /** The picked dock, or the bottom on a narrow viewport. */
  placement: DockPosition;
  /** Hide leaves debug mode. Re-entry is the Settings "Open in debug mode" button. */
  onExit: () => void;
  onToggleDock: () => void;
  onToggleCollapse: () => void;
}): JSX.Element {
  const dockLabel = (): string => getDockLabel(props.dock);
  const collapseLabel = (): string => (props.collapsed ? 'Expand' : 'Collapse');

  return (
    <div class={s['header']} data-testid="td-header" data-dock={props.placement}>
      <SectionTabs section={props.collapsed ? null : props.section} onSelect={props.onSelectSection} />
      <span class={s['spacer']} />
      <Button
        testId="td-dock"
        icon
        class={s['dock']}
        title={dockLabel()}
        label={dockLabel()}
        onClick={props.onToggleDock}
      >
        {renderDockIcon(props.dock)}
      </Button>
      <Button
        testId="td-collapse"
        icon
        title={collapseLabel()}
        label={collapseLabel()}
        expanded={!props.collapsed}
        onClick={props.onToggleCollapse}
      >
        {props.collapsed ? <ChevronUpIcon /> : <ChevronDownIcon />}
      </Button>
      <Button testId="td-close" icon title="Hide" label="Hide" onClick={props.onExit}>
        <CloseIcon />
      </Button>
    </div>
  );
}

/** The dock toggle names the dock it moves the panel to. */
function getDockLabel(dock: DockPosition): string {
  switch (dock) {
    case 'right':
      return 'Dock to bottom';
    case 'bottom':
      return 'Dock to right';
  }
}

function renderDockIcon(dock: DockPosition): JSX.Element {
  switch (dock) {
    case 'right':
      return <DockBottomIcon />;
    case 'bottom':
      return <DockRightIcon />;
  }
}
