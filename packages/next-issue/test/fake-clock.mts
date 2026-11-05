import type { Clock } from '../src/poll.mts';

export function fakeClock(): Clock & { time: number } {
  const fake = {
    time: 0,
    now: () => fake.time,
    sleep: async (ms: number) => {
      fake.time += ms;
    },
  };
  return fake;
}
