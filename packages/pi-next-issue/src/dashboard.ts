import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Input,
  type KeybindingsManager,
  type TUI,
  truncateToWidth,
} from '@earendil-works/pi-tui';
import { errorText } from './errors.ts';
import { type Answer, guidanceProblem } from './hand-overs.ts';
import { type PastRun, runDetails, runLine } from './past.ts';
import { going, type Progress, type Question } from './protocol.ts';
import { handledNote, issueLine } from './status.ts';

export type DashboardAction = { label: string; args: string };

export type DashboardOptions = {
  progress: () => Progress | undefined;
  actions: (progress: Progress | undefined) => DashboardAction[];
  pastRuns: () => Promise<PastRun[]>;
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

function windowStart(chosen: number, size: number, total: number): number {
  return Math.max(0, Math.min(chosen - Math.floor((size - 1) / 2), total - size));
}

type PastView = { lines: string[]; page: number; top: number };

function pastLines(
  runs: PastRun[] | undefined,
  chosen: number,
  room: number,
  top: number,
): PastView {
  if (runs === undefined) {
    return { lines: ['Loading past runs…'], page: 0, top: 0 };
  }
  const run = runs[chosen];
  if (run === undefined) {
    return { lines: ['No past runs.'], page: 0, top: 0 };
  }
  const details = runDetails(run);
  const listRows = Math.min(runs.length, Math.max(1, room - 2 - details.length));
  const start = windowStart(chosen, listRows, runs.length);
  const title =
    listRows < runs.length ? `Past runs (${chosen + 1} of ${runs.length})` : 'Past runs';
  const detailRows = Math.max(1, room - 2 - listRows);
  const fits = details.length <= detailRows;
  const page = fits ? details.length : Math.max(1, detailRows - 1);
  const shown = fits ? 0 : Math.max(0, Math.min(top, details.length - page));
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
  let selected = 0;
  let tab: (typeof TABS)[number] = 'Active';
  let past: PastRun[] | undefined;
  let chosenRun = 0;
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
  const unsubscribe = options.subscribe(redraw);
  const timer = setInterval(redraw, TICK_MS);
  timer.unref?.();
  const dispose = () => {
    unsubscribe();
    clearInterval(timer);
  };
  const actions = () => options.actions(options.progress());
  const showPast = () => {
    tab = 'Past';
    past = undefined;
    chosenRun = 0;
    detailsTop = 0;
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
      return past?.length ?? 0;
    }
    if (tab === 'Hand-overs') {
      return answering === undefined ? waiting().length : ANSWERS.length;
    }
    return actions().length;
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
    } else if (tab === 'Past') {
      chosenRun = (chosenRun + step + total) % total;
      detailsTop = 0;
    } else {
      selected = (selected + step + total) % total;
    }
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
      const choices = options.actions(progress);
      selected = Math.min(selected, Math.max(0, choices.length - 1));
      const tabs = TABS.map((name) =>
        name === tab ? theme.fg('accent', theme.bold(`[${name}]`)) : theme.fg('dim', ` ${name} `),
      ).join(' ');
      const height = Math.floor((options.tui.terminal.rows * DASHBOARD_HEIGHT) / 100);
      const view = pastLines(past, chosenRun, height - FRAME_ROWS, detailsTop);
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
            ? [...view.lines, '', theme.fg('dim', '↑↓ choose · tab switch · esc close')]
            : [
                ...activeLines(progress, Date.now()),
                '',
                'Actions',
                ...choices.map(({ label }, index) =>
                  index === selected ? theme.fg('accent', `> ${label}`) : `  ${label}`,
                ),
                '',
                theme.fg('dim', '↑↓ choose · enter run · tab switch · esc close'),
              ];
      return box([tabs, '', ...body], width);
    },
    handleInput(data: string): void {
      if (guidance !== undefined) {
        guidance.input.handleInput(data);
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
      } else if (keybindings.matches(data, 'tui.select.confirm') && tab === 'Active') {
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
