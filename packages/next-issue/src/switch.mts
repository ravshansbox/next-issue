export type Switch = {
  on: () => boolean;
  // Aborted at the next change, so a wait can end as soon as the switch turns on or off.
  changed: () => AbortSignal;
};

export type Toggle = Switch & { set: (on: boolean) => void };

export function onOff(initial: boolean): Toggle {
  let on = initial;
  let controller = new AbortController();
  return {
    on: () => on,
    changed: () => controller.signal,
    set: (next) => {
      if (next === on) {
        return;
      }
      on = next;
      controller.abort();
      controller = new AbortController();
    },
  };
}
