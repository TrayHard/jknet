import { useEffect, useState } from "react";

/**
 * The current time, read again every `everyMs` while `enabled`.
 *
 * The session carries stamps, not clocks: how long the server has run, how
 * long the relay ticket has left and when the empty server stops are all
 * `now` minus a stamp, so the screen that prints them keeps its own clock
 * instead of asking the core every second.
 */
export function useNow(everyMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs, enabled]);

  return now;
}
