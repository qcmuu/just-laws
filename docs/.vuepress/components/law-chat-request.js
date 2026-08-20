// Generation counter so an aborted turn cannot mutate a newer request's
// loading flag / AbortController. newChat() and ask() both call next();
// only the matching generation may touch widget-global state.

export function createRequestGeneration() {
  let generation = 0;
  return {
    next() {
      generation += 1;
      return generation;
    },
    isLive(id) {
      return id === generation;
    },
    current() {
      return generation;
    },
  };
}

// Shared finish-guard used by the widget and by the race test.
export function applyIfCurrent(gate, id, fn) {
  if (!gate.isLive(id)) return false;
  fn();
  return true;
}
