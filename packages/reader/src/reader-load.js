export function readerLoadAbortError() {
  const error = new Error("Reader load cancelled");
  error.name = "AbortError";
  return error;
}

export function throwIfReaderLoadAborted(signal) {
  if (signal?.aborted) throw readerLoadAbortError();
}

export function isReaderLoadAbort(error, signal) {
  return !!signal?.aborted || error?.name === "AbortError";
}

export function createReaderLoadCoordinator() {
  let generation = 0;
  let controller = null;

  const isCurrent = (token) => !!token
    && token.generation === generation
    && token.signal === controller?.signal
    && !token.signal.aborted;

  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      generation += 1;
      return { generation, signal: controller.signal };
    },
    isCurrent,
    finish(token) {
      if (isCurrent(token)) controller = null;
    },
    cancel() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  };
}

// A background Obsidian window can suspend RAF until it is revealed. Opening
// must not wait forever for that frame before revealLeaf gets a chance to run.
export function waitForReaderFrame(win) {
  return new Promise((resolve) => {
    let frame = null;
    const finish = () => {
      win.clearTimeout(timer);
      if (frame !== null) win.cancelAnimationFrame(frame);
      resolve();
    };
    const timer = win.setTimeout(finish, 100);
    frame = win.requestAnimationFrame(finish);
  });
}
