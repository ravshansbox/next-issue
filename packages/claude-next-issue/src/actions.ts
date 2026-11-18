import { errorText } from './errors.ts';
import { type Answer, answerHandOver } from './hand-overs.ts';
import { type Host, must } from './host.ts';
import type { Question, StopPoint } from './protocol.ts';
import { refreshRun, startRun, stopRun, switchRun } from './tools.ts';
import type { WorkerClient } from './worker.ts';

export type Note = { text: string; isError: boolean };

export async function act(client: WorkerClient, args: string): Promise<Note> {
  const [action = '', value] = args.split(' ');
  try {
    const text =
      action === 'start'
        ? await startRun(client)
        : action === 'stop'
          ? await stopRun(client, value as StopPoint)
          : action === 'watch' || action === 'hunt'
            ? await switchRun(client, action, value === 'on')
            : await refreshRun(client);
    return { text, isError: false };
  } catch (error) {
    return { text: `next-issue cannot ${action}: ${errorText(error)}`, isError: true };
  }
}

export async function answer(
  client: WorkerClient,
  host: Host,
  question: Question,
  given: Answer,
): Promise<string> {
  await answerHandOver((args) => must(host, ['gh', ...args], client.root), question, given);
  if (client.questions !== undefined) {
    client.questions = client.questions.filter((item) => item.issue !== question.issue);
  }
  await client.askQuestions();
  if (given.kind === 'give-up') {
    return `Gave up on #${question.issue}.`;
  }
  const refreshed = await refreshRun(client);
  const done = given.guidance === undefined ? 'Retried' : 'Posted the guidance and retried';
  return `${done} #${question.issue}. ${refreshed}`;
}
