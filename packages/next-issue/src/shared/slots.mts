/** The slot of one issue: freed while it waits to land, taken back for each agent it runs meanwhile. */
export type Slot = {
  free: () => void;
  take: () => Promise<boolean>;
};

/** The `concurrency` slots of a run; an issue that waits for a slot comes before a new claim. */
export class Slots {
  private readonly size: number;
  private used = 0;
  private readonly waiting: Array<() => void> = [];
  private changed: { promise: Promise<void>; resolve: () => void } | undefined;

  constructor(size: number) {
    this.size = size;
  }

  open(): boolean {
    return this.used < this.size && this.waiting.length === 0;
  }

  claim(): Slot {
    this.used += 1;
    let held = true;
    return {
      free: () => {
        if (held) {
          held = false;
          this.release();
        }
      },
      take: async () => {
        if (held) {
          return false;
        }
        await this.acquire();
        held = true;
        return true;
      },
    };
  }

  freed(): Promise<void> {
    if (this.changed === undefined) {
      let resolve = (): void => undefined;
      const promise = new Promise<void>((settle) => {
        resolve = settle;
      });
      this.changed = { promise, resolve };
    }
    return this.changed.promise;
  }

  private acquire(): Promise<void> {
    if (this.open()) {
      this.used += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.used -= 1;
    this.changed?.resolve();
    this.changed = undefined;
  }
}
