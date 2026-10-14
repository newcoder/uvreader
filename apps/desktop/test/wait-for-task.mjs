// Shared test helper: the workshop queue drains serially and the runners do
// real work (fonts, DocVortex, python), so a fixed sleep is a coin flip on a
// busy machine - CI tripped on `'running' !== 'done'` twice. Poll instead.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TERMINAL = new Set(["done", "failed", "cancelled"]);

export async function waitForTask(queue, id, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = queue.snapshot().tasks.find((entry) => entry.id === id);
    if (task && TERMINAL.has(task.status)) return task;
    if (Date.now() > deadline) return task;
    await sleep(10);
  }
}
