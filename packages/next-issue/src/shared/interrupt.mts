export type Interrupts = {
  afterIssue: () => boolean;
  afterRound: () => boolean;
  // A sleep also ends (false) when `woken` aborts.
  sleep: (ms: number, woken?: AbortSignal) => Promise<boolean>;
};
