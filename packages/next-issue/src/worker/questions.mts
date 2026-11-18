import { loadConfig } from '../shared/config.mts';
import { message } from '../shared/errors.mts';
import { detectRepo } from '../shared/git.mts';
import { waitingQuestions } from '../shared/hand-over-comments.mts';
import { PORTS } from '../shared/ports.mts';
import type { Question, WorkerMessage } from '../shared/protocol.mts';

export type ListQuestions = (root: string) => Promise<Question[]>;

type Questions = Extract<WorkerMessage, { type: 'questions' | 'questions-error' }>;

type Delivery = { read: number; value: Questions };

export type Peer = { send: (data: string) => void };

export async function listQuestions(root: string): Promise<Question[]> {
  const config = await loadConfig(root);
  return waitingQuestions(await detectRepo(root, config.remote), config, PORTS);
}

async function readQuestions(list: ListQuestions, root: string): Promise<Questions> {
  try {
    return { type: 'questions', root, questions: await list(root) };
  } catch (error) {
    return { type: 'questions-error', root, message: message(error) };
  }
}

function questionsReply(
  delivered: WeakMap<Peer, Map<string, Delivery>>,
  socket: Peer,
  root: string,
  delivery: Delivery,
  id?: string,
): Questions | undefined {
  const seen = delivered.get(socket) ?? new Map<string, Delivery>();
  const last = seen.get(root);
  if (last === undefined || last.read < delivery.read) {
    seen.set(root, delivery);
    delivered.set(socket, seen);
    return id === undefined ? delivery.value : { ...delivery.value, id };
  }
  return id === undefined ? undefined : { ...last.value, id };
}

type SendQuestions = (root: string, targets: () => Iterable<Peer>, id?: string) => Promise<void>;

export function questionSender(list: ListQuestions): SendQuestions {
  const reads = new Map<string, number>();
  const delivered = new WeakMap<Peer, Map<string, Delivery>>();
  return async (root, targets, id) => {
    const read = (reads.get(root) ?? 0) + 1;
    reads.set(root, read);
    const value = await readQuestions(list, root);
    for (const socket of targets()) {
      const reply = questionsReply(delivered, socket, root, { read, value }, id);
      if (reply !== undefined) {
        send(socket, reply);
      }
    }
  };
}

export function send(socket: Peer, value: WorkerMessage): void {
  socket.send(JSON.stringify(value));
}
