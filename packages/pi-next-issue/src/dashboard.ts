import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Input,
  type KeybindingsManager,
  replaceControlCharacters,
  stripTerminalSequences,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import { errorText } from './errors.ts';
import { type Answer, guidanceProblem } from './hand-overs.ts';
import { ISSUES_LINE, type PastRun, runDetails, runLine } from './past.ts';
import { going, type Progress, type Question } from './protocol.ts';
import { handledNote, issueLine } from './status.ts';

export type DashboardAction = { label: string; args: string };

export type DashboardOptions = {
  progress: () => Progress | undefined;
  actions: (progress: Progress | undefined) => DashboardAction[];
  pastRuns: () => Promise<PastRun[]>;
  issueDetail: (issue: number, runId: string | undefined) => Promise<string[]>;
  questions: () => Question[] | undefined;
  connected: () => boolean;
  askQuestions: () => void;
  answer: (question: Question, answer: Answer) => Promise<string>;
  act: (args: string) => void;
  subscribe: (listener: () => void) => () => void;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  done: () => void;
};

const TABS = ['Active', 'Past', 'Hand-overs'] as const;
const ANSWERS = ['Retry', 'Retry with guidance', 'Give up'] as const;
const QUESTION_ROWS = 3;
const TICK_MS = 1000;
const FRAME_ROWS = 6;
export const DASHBOARD_HEIGHT = 90;

function onOff(on: boolean | undefined): string {
  return on === true ? 'on' : 'off';
}

type Row = { key: string; issue?: number; action?: DashboardAction };

type Detail = {
  issue: number;
  runId: string | undefined;
  live: boolean;
  stale: boolean;
  lines?: string[];
  top: number;
  asked: number;
};

function activeRows(progress: Progress | undefined, actions: DashboardAction[]): Row[] {
  const issues: Row[] = going(progress)
    ? [
        ...progress.issues.map((item) => ({ key: `running:${item.issue}`, issue: item.issue })),
        ...progress.handled.map((item, index) => ({ key: `handled:${index}`, issue: item.issue })),
      ]
    : [];
  return [...issues, ...actions.map((action) => ({ key: `action:${action.args}`, action }))];
}

function listed(title: string, lines: string[]): string[] {
  return [title, ...(lines.length === 0 ? ['  none'] : lines)];
}

function activeLines(
  progress: Progress | undefined,
  now: number,
  mark: (key: string, text: string) => string,
): string[] {
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
        progress.issues.map((item) => mark(`running:${item.issue}`, issueLine(item, now))),
      ),
      ...listed(
        'Handled issues',
        progress.handled.map((item, index) => mark(`handled:${index}`, handledNote(item))),
      ),
      ...error,
    ];
  }
  return ['No run is going.', ...last, ...error];
}

function windowStart(chosen: number, size: number, total: number): number {
  return Math.max(0, Math.min(chosen - Math.floor((size - 1) / 2), total - size));
}

type PastView = { lines: string[]; page: number; top: number };

function pastLines(
  runs: PastRun[] | undefined,
  chosen: number,
  room: number,
  top: number,
  picked: number | undefined,
): PastView {
  if (runs === undefined) {
    return { lines: ['Loading past runs…'], page: 0, top: 0 };
  }
  const run = runs[chosen];
  if (run === undefined) {
    return { lines: ['No past runs.'], page: 0, top: 0 };
  }
  const details = runDetails(run, picked);
  const listRows = Math.min(runs.length, Math.max(1, room - 2 - details.length));
  const start = windowStart(chosen, listRows, runs.length);
  const title =
    listRows < runs.length ? `Past runs (${chosen + 1} of ${runs.length})` : 'Past runs';
  const detailRows = Math.max(1, room - 2 - listRows);
  const fits = details.length <= detailRows;
  const page = fits ? details.length : Math.max(1, detailRows - 1);
  const focus = details.indexOf(ISSUES_LINE) + 1 + (picked ?? 0);
  const wanted = picked === undefined ? top : Math.min(Math.max(top, focus - page + 1), focus);
  const shown = fits ? 0 : Math.max(0, Math.min(wanted, details.length - page));
  const end = Math.min(details.length, shown + page);
  return {
    lines: [
      title,
      ...runs
        .slice(start, start + listRows)
        .map((item, index) => `${start + index === chosen ? '>' : ' '} ${runLine(item)}`),
      '',
      ...details.slice(shown, end),
      ...(fits ? [] : [`lines ${shown + 1}–${end} of ${details.length} · PgUp PgDn scroll`]),
    ],
    page,
    top: shown,
  };
}

function handOverLines(
  questions: Question[] | undefined,
  connected: boolean,
  chosen: number,
  room: number,
): string[] {
  if (questions === undefined && !connected) {
    return [
      'No worker is running, so pi cannot list the hand-overs. Answer them with the answer-hand-over skill.',
    ];
  }
  if (questions === undefined) {
    return ['Waiting for the hand-overs from the worker…'];
  }
  if (questions.length === 0) {
    return ['No issue waits for a person.'];
  }
  const shown = Math.min(questions.length, Math.max(1, Math.floor(room / QUESTION_ROWS)));
  const start = windowStart(chosen, shown, questions.length);
  const title =
    shown < questions.length
      ? `Waiting for a person (${chosen + 1} of ${questions.length})`
      : 'Waiting for a person';
  return [
    title,
    ...questions
      .slice(start, start + shown)
      .flatMap((question, index) => [
        `${start + index === chosen ? '>' : ' '} #${question.issue} ${question.title}`,
        `    ${question.reason.replace(/\s+/g, ' ')}`,
        `    ${question.url}`,
      ]),
  ];
}

export function dashboard(options: DashboardOptions): Component & { dispose(): void } {
  const { theme, keybindings } = options;
  let selectedKey: string | undefined;
  let tab: (typeof TABS)[number] = 'Active';
  let past: PastRun[] | undefined;
  let chosenRun = 0;
  let pickedIssue: number | undefined;
  let detail: Detail | undefined;
  let detailPage = 0;
  let wrapped: { source: string[]; width: number; lines: string[] } | undefined;
  let detailsTop = 0;
  let detailsPage = 0;
  let chosenQuestion = 0;
  let answering: Question | undefined;
  let answerChoice = 0;
  let guidance: { input: Input; question: Question } | undefined;
  let problem: string | undefined;
  let busy = false;
  let outcome: string | undefined;
  const redraw = () => options.tui.requestRender();
  const loadDetail = () => {
    const shown = detail;
    if (shown === undefined) {
      return;
    }
    shown.asked += 1;
    const asked = shown.asked;
    void options
      .issueDetail(shown.issue, shown.runId)
      .catch((error: unknown) => [`Could not read #${shown.issue}: ${errorText(error)}`])
      .then((lines) => {
        if (detail === shown && asked === shown.asked) {
          shown.lines = lines;
          redraw();
        }
      });
  };
  const openDetail = (issue: number, runId: string | undefined) => {
    detail = { issue, runId, live: runId === undefined, stale: false, top: 0, asked: 0 };
    loadDetail();
  };
  const unsubscribe = options.subscribe(() => {
    if (detail?.live === true) {
      detail.stale = true;
    }
    redraw();
  });
  const timer = setInterval(() => {
    if (detail?.stale === true) {
      detail.stale = false;
      loadDetail();
    }
    redraw();
  }, TICK_MS);
  timer.unref?.();
  const dispose = () => {
    unsubscribe();
    clearInterval(timer);
  };
  const actions = () => options.actions(options.progress());
  const rows = () => activeRows(options.progress(), actions());
  const selectedIndex = (list: Row[]) => {
    const index = list.findIndex((row) => row.key === selectedKey);
    return index >= 0
      ? index
      : Math.max(
          0,
          list.findIndex((row) => row.action !== undefined),
        );
  };
  const showPast = () => {
    tab = 'Past';
    past = undefined;
    chosenRun = 0;
    detailsTop = 0;
    pickedIssue = undefined;
    void options
      .pastRuns()
      .catch(() => [])
      .then((runs) => {
        past = runs;
        redraw();
      });
  };
  const waiting = () => options.questions() ?? [];
  const showHandOvers = () => {
    tab = 'Hand-overs';
    pickedIssue = undefined;
    chosenQuestion = 0;
    answering = undefined;
    outcome = undefined;
    options.askQuestions();
  };
  const send = (question: Question, answer: Answer) => {
    answering = undefined;
    guidance = undefined;
    busy = true;
    outcome = `Answering #${question.issue}…`;
    void options
      .answer(question, answer)
      .catch((error: unknown) => `Could not answer #${question.issue}: ${errorText(error)}`)
      .then((text) => {
        busy = false;
        outcome = text;
        redraw();
      });
  };
  const guide = (question: Question) => {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (text) => {
      problem = guidanceProblem(text);
      if (problem === undefined) {
        send(question, { kind: 'retry', guidance: text.trim() });
      }
    };
    input.onEscape = () => {
      guidance = undefined;
      problem = undefined;
    };
    answering = undefined;
    guidance = { input, question };
    problem = undefined;
  };
  const confirmAnswer = (question: Question) => {
    const choice = ANSWERS[answerChoice];
    if (choice === 'Retry') {
      send(question, { kind: 'retry' });
    } else if (choice === 'Retry with guidance') {
      guide(question);
    } else {
      send(question, { kind: 'give-up' });
    }
  };
  const confirmHandOver = () => {
    if (answering !== undefined) {
      confirmAnswer(answering);
      return;
    }
    const question = waiting()[chosenQuestion];
    if (question !== undefined && !busy) {
      answering = question;
      answerChoice = 0;
      outcome = undefined;
    }
  };
  const count = () => {
    if (tab === 'Past') {
      return pickedIssue === undefined
        ? (past?.length ?? 0)
        : (past?.[chosenRun]?.issues.length ?? 0);
    }
    if (tab === 'Hand-overs') {
      return answering === undefined ? waiting().length : ANSWERS.length;
    }
    return rows().length;
  };
  const move = (step: number) => {
    const total = count();
    if (total === 0) {
      return;
    }
    if (tab === 'Hand-overs' && answering !== undefined) {
      answerChoice = (answerChoice + step + total) % total;
    } else if (tab === 'Hand-overs') {
      chosenQuestion = (chosenQuestion + step + total) % total;
    } else if (tab === 'Past' && pickedIssue !== undefined) {
      pickedIssue = (pickedIssue + step + total) % total;
    } else if (tab === 'Past') {
      chosenRun = (chosenRun + step + total) % total;
      detailsTop = 0;
    } else {
      const list = rows();
      selectedKey = list[(selectedIndex(list) + step + total) % total]?.key;
    }
  };
  const confirmPast = () => {
    const run = past?.[chosenRun];
    if (run === undefined) {
      return;
    }
    const item = pickedIssue === undefined ? undefined : run.issues[pickedIssue];
    if (item !== undefined) {
      openDetail(item.issue, run.id);
    } else if (run.issues.length > 0) {
      pickedIssue = 0;
    }
  };
  const confirmActive = () => {
    const list = rows();
    const row = list[selectedIndex(list)];
    if (row?.issue !== undefined) {
      openDetail(row.issue, undefined);
    } else if (row?.action !== undefined) {
      options.act(row.action.args);
    }
  };
  const detailLines = (shown: Detail, width: number, room: number): string[] => {
    const source = shown.lines ?? [`Loading #${shown.issue}…`];
    if (wrapped?.source !== source || wrapped.width !== width) {
      wrapped = {
        source,
        width,
        lines: source.flatMap((line) =>
          wrapTextWithAnsi(replaceControlCharacters(stripTerminalSequences(line)), width),
        ),
      };
    }
    const lines = wrapped.lines;
    detailPage = Math.max(1, room - 1);
    shown.top = Math.max(0, Math.min(shown.top, lines.length - detailPage));
    const end = Math.min(lines.length, shown.top + detailPage);
    return [
      ...lines.slice(shown.top, end),
      `lines ${shown.top + 1}–${end} of ${lines.length}`,
      '',
      theme.fg('dim', '↑↓ PgUp PgDn scroll · esc back'),
    ];
  };

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
      const list = activeRows(progress, options.actions(progress));
      const chosenKey = list[selectedIndex(list)]?.key;
      const mark = (key: string, text: string) =>
        key === chosenKey ? theme.fg('accent', `> ${text}`) : `  ${text}`;
      const tabs = TABS.map((name) =>
        name === tab ? theme.fg('accent', theme.bold(`[${name}]`)) : theme.fg('dim', ` ${name} `),
      ).join(' ');
      const height = Math.floor((options.tui.terminal.rows * DASHBOARD_HEIGHT) / 100);
      if (detail !== undefined) {
        return box(
          [tabs, '', ...detailLines(detail, Math.max(1, width - 4), height - FRAME_ROWS)],
          width,
        );
      }
      const view = pastLines(past, chosenRun, height - FRAME_ROWS, detailsTop, pickedIssue);
      detailsTop = view.top;
      detailsPage = view.page;
      const questions = options.questions();
      chosenQuestion = Math.min(chosenQuestion, Math.max(0, (questions?.length ?? 0) - 1));
      const answerLines =
        answering === undefined
          ? []
          : [
              '',
              `Answer #${answering.issue} ${answering.title}`,
              ...ANSWERS.map((label, index) =>
                index === answerChoice ? theme.fg('accent', `> ${label}`) : `  ${label}`,
              ),
            ];
      const guidanceLines =
        guidance === undefined
          ? []
          : [
              '',
              `Guidance for #${guidance.question.issue} ${guidance.question.title}`,
              ...guidance.input.render(Math.max(1, width - 4)),
              ...(problem === undefined ? [] : [theme.fg('error', problem)]),
            ];
      const extra = answerLines.length + guidanceLines.length + (outcome === undefined ? 0 : 2);
      const help =
        guidance !== undefined
          ? 'enter post and retry · esc back'
          : answering !== undefined
            ? '↑↓ choose · enter answer · esc back'
            : '↑↓ choose · enter answer · tab switch · esc close';
      const handOvers = [
        ...handOverLines(
          questions,
          options.connected(),
          chosenQuestion,
          height - FRAME_ROWS - 1 - extra,
        ),
        ...answerLines,
        ...guidanceLines,
        ...(outcome === undefined ? [] : ['', outcome]),
        '',
        theme.fg('dim', help),
      ];
      const body =
        tab === 'Hand-overs'
          ? handOvers
          : tab === 'Past'
            ? [
                ...view.lines,
                '',
                theme.fg(
                  'dim',
                  pickedIssue === undefined
                    ? '↑↓ choose · enter issues · tab switch · esc close'
                    : '↑↓ choose · enter detail · esc back',
                ),
              ]
            : [
                ...activeLines(progress, Date.now(), mark),
                '',
                'Actions',
                ...list.flatMap(({ key, action }) =>
                  action === undefined ? [] : [mark(key, action.label)],
                ),
                '',
                theme.fg('dim', '↑↓ choose · enter open or run · tab switch · esc close'),
              ];
      return box([tabs, '', ...body], width);
    },
    handleInput(data: string): void {
      if (guidance !== undefined) {
        guidance.input.handleInput(data);
        redraw();
        return;
      }
      if (detail !== undefined) {
        if (keybindings.matches(data, 'tui.select.cancel')) {
          detail = undefined;
        } else if (keybindings.matches(data, 'tui.select.up')) {
          detail.top = Math.max(0, detail.top - 1);
        } else if (keybindings.matches(data, 'tui.select.down')) {
          detail.top += 1;
        } else if (keybindings.matches(data, 'tui.select.pageUp')) {
          detail.top = Math.max(0, detail.top - detailPage);
        } else if (keybindings.matches(data, 'tui.select.pageDown')) {
          detail.top += detailPage;
        } else {
          return;
        }
        redraw();
        return;
      }
      if (pickedIssue !== undefined && keybindings.matches(data, 'tui.select.cancel')) {
        pickedIssue = undefined;
        redraw();
        return;
      }
      if (answering !== undefined && keybindings.matches(data, 'tui.select.cancel')) {
        answering = undefined;
        redraw();
        return;
      }
      if (keybindings.matches(data, 'tui.select.cancel')) {
        dispose();
        options.done();
        return;
      }
      if (keybindings.matches(data, 'tui.input.tab')) {
        if (tab === 'Active') {
          showPast();
        } else if (tab === 'Past') {
          showHandOvers();
        } else {
          answering = undefined;
          tab = 'Active';
        }
      } else if (keybindings.matches(data, 'tui.select.up')) {
        move(-1);
      } else if (keybindings.matches(data, 'tui.select.down')) {
        move(1);
      } else if (keybindings.matches(data, 'tui.select.pageUp') && tab === 'Past') {
        detailsTop = Math.max(0, detailsTop - detailsPage);
      } else if (keybindings.matches(data, 'tui.select.pageDown') && tab === 'Past') {
        detailsTop += detailsPage;
      } else if (keybindings.matches(data, 'tui.select.confirm') && tab === 'Hand-overs') {
        confirmHandOver();
      } else if (keybindings.matches(data, 'tui.select.confirm') && tab === 'Past') {
        confirmPast();
      } else if (keybindings.matches(data, 'tui.select.confirm') && tab === 'Active') {
        confirmActive();
      } else {
        return;
      }
      redraw();
    },
    invalidate(): void {},
    dispose,
  };
}
