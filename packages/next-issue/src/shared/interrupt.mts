export type Interrupts = {
  afterIssue: () => boolean;
  afterRound: () => boolean;
  sleep: (ms: number, woken?: AbortSignal) => Promise<boolean>;
};
