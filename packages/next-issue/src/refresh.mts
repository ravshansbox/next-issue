export type Refresher = {
  // Aborted at the next refresh, so a wait that holds it ends when a client asks for new issues.
  refreshed: () => AbortSignal;
  refresh: () => void;
};

export function refresher(): Refresher {
  let controller = new AbortController();
  return {
    refreshed: () => controller.signal,
    refresh: () => {
      controller.abort();
      controller = new AbortController();
    },
  };
}
