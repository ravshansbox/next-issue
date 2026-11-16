import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  type Component,
  type KeybindingsManager,
  type TUI,
  truncateToWidth,
} from '@earendil-works/pi-tui';
import { going, type Progress } from './protocol.ts';
import { handledNote, issueLine } from './status.ts';

export type DashboardAction = { label: string; args: string };

export type DashboardOptions = {
  progress: () => Progress | undefined;
  actions: (progress: Progress | undefined) => DashboardAction[];
  act: (args: string) => void;
  subscribe: (listener: () => void) => () => void;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  done: () => void;
};

const TABS = ['Active'] as const;
const TICK_MS = 1000;

function onOff(on: boolean | undefined): string {
  return on === true ? 'on' : 'off';
}

function listed(title: string, lines: string[]): string[] {
  return [title, ...(lines.length === 0 ? ['none'] : lines).map((line) => `  ${line}`)];
}

function activeLines(progress: Progress | undefined, now: number): string[] {
  const error = progress?.error === undefined ? [] : [`Error: ${progress.error}`];
  const last = progress === undefined ? [] : [`Last run: ${progress.status}`];
  if (going(progress)) {
    return [
      `Status: ${progress.status}`,
      `Watching: ${onOff(progress.watching)}`,
      `Hunting: ${onOff(progress.hunting)}`,
      ...(progress.open === undefined ? [] : [`Open issues: ${progress.open}`]),
      '',
      ...listed(
        'Running issues',
        progress.issues.map((item) => issueLine(item, now)),
      ),
      ...listed('Handled issues', progress.handled.map(handledNote)),
      ...error,
    ];
  }
  return ['No run is going.', ...last, ...error];
}

export function dashboard(options: DashboardOptions): Component & { dispose(): void } {
  const { theme, keybindings } = options;
  let selected = 0;
  const redraw = () => options.tui.requestRender();
  const unsubscribe = options.subscribe(redraw);
  const timer = setInterval(redraw, TICK_MS);
  timer.unref?.();
  const dispose = () => {
    unsubscribe();
    clearInterval(timer);
  };
  const actions = () => options.actions(options.progress());

  const box = (lines: string[], width: number): string[] => {
    const inner = Math.max(1, width - 4);
    const title = ' next-issue ';
    const top = `╭${'─'.repeat(Math.max(0, width - 2 - title.length))}╮`;
    const border = (text: string) => theme.fg('border', text);
    return [
      border(top.slice(0, 2)) + theme.fg('accent', title) + border(top.slice(2)),
      ...lines.map(
        (line) => `${border('│')} ${truncateToWidth(line, inner, '…', true)} ${border('│')}`,
      ),
      border(`╰${'─'.repeat(Math.max(0, width - 2))}╯`),
    ];
  };

  return {
    render(width: number): string[] {
      const progress = options.progress();
      const choices = options.actions(progress);
      selected = Math.min(selected, Math.max(0, choices.length - 1));
      const tabs = TABS.map((tab) => theme.fg('accent', theme.bold(`[${tab}]`))).join(' ');
      return box(
        [
          tabs,
          '',
          ...activeLines(progress, Date.now()),
          '',
          'Actions',
          ...choices.map(({ label }, index) =>
            index === selected ? theme.fg('accent', `> ${label}`) : `  ${label}`,
          ),
          '',
          theme.fg('dim', '↑↓ choose · enter run · esc close'),
        ],
        width,
      );
    },
    handleInput(data: string): void {
      const count = actions().length;
      if (keybindings.matches(data, 'tui.select.cancel')) {
        dispose();
        options.done();
        return;
      }
      if (keybindings.matches(data, 'tui.select.up') && count > 0) {
        selected = (selected - 1 + count) % count;
      } else if (keybindings.matches(data, 'tui.select.down') && count > 0) {
        selected = (selected + 1) % count;
      } else if (keybindings.matches(data, 'tui.select.confirm')) {
        const action = actions()[selected];
        if (action !== undefined) {
          options.act(action.args);
        }
      } else {
        return;
      }
      redraw();
    },
    invalidate(): void {},
    dispose,
  };
}
