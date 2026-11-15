export type HuntSwitch = {
  on: () => boolean;
  // Aborted at the next change, so a wait can end as soon as hunting turns on or off.
  changed: () => AbortSignal;
};

export type HuntToggle = HuntSwitch & { set: (on: boolean) => void };

export function huntSwitch(initial: boolean): HuntToggle {
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
