import type { WebSocket } from 'ws';
import { loadConfig } from './config.mts';
import { detectRepo } from './git.mts';
import { waitingQuestions } from './hand-over-comments.mts';
import { message } from './errors.mts';
import { PORTS } from './ports.mts';
import type { Question, WorkerMessage } from './protocol.mts';

export type ListQuestions = (root: string) => Promise<Question[]>;

type Questions = Extract<WorkerMessage, { type: 'questions' | 'questions-error' }>;

type Delivery = { read: number; value: Questions };

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
  delivered: WeakMap<WebSocket, Map<string, Delivery>>,
  socket: WebSocket,
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

type SendQuestions = (
  root: string,
  targets: () => Iterable<WebSocket>,
  id?: string,
) => Promise<void>;

export function questionSender(list: ListQuestions): SendQuestions {
  const reads = new Map<string, number>();
  const delivered = new WeakMap<WebSocket, Map<string, Delivery>>();
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

export function send(socket: WebSocket, value: WorkerMessage): void {
  socket.send(JSON.stringify(value));
}
