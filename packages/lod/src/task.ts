/**
 * A promise that settles in a later task of the page's event loop: `scheduler.yield()`
 * where there is one, else a message round trip. Unlike setTimeout, neither is throttled
 * to one call a second in a background tab.
 */
export function nextTask(): Promise<void> {
  const scheduler: unknown = Reflect.get(globalThis, "scheduler");
  const yielding = typeof scheduler === "object" && scheduler !== null ? Reflect.get(scheduler, "yield") : undefined;
  if (typeof yielding === "function") return Promise.resolve(Reflect.apply(yielding, scheduler, [])).then(() => {});
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
