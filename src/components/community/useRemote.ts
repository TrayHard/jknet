import { useCallback, useEffect, useRef, useState } from "react";

/** One read of the service as a screen holds it. */
export interface Remote<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** Reads again, keeping the data on screen until the answer comes. */
  reload: () => void;
  /** Replaces the data with what a write answered, without a request. */
  set: (update: T | ((current: T | undefined) => T | undefined)) => void;
}

/**
 * Reads `load` whenever `key` changes, and never while it is `null`.
 *
 * The community screens run in three hosts, and only the launcher has React
 * Query, so the screens keep their reads themselves. An answer that arrives
 * after the key moved on is dropped: a page opened meanwhile never shows the
 * one before it.
 */
export function useRemote<T>(key: string | null, load: () => Promise<T>): Remote<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(key !== null);
  const [round, setRound] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  const epoch = useRef(0);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    const run = ++epoch.current;
    if (key === null) {
      lastKey.current = null;
      setData(undefined);
      setError(null);
      setLoading(false);
      return;
    }
    // A new key starts from nothing; a reload of the same key keeps what is shown.
    if (lastKey.current !== key) setData(undefined);
    lastKey.current = key;
    setLoading(true);
    setError(null);
    // A loader may refuse before it has a promise to return, such as for an
    // id of the wrong shape: that refusal is the read's error too.
    let pending: Promise<T>;
    try {
      pending = loader.current();
    } catch (failure) {
      pending = Promise.reject(failure);
    }
    pending
      .then((answer) => {
        if (epoch.current === run) setData(answer);
      })
      .catch((failure: unknown) => {
        if (epoch.current === run) setError(failure ?? new Error("request failed"));
      })
      .finally(() => {
        if (epoch.current === run) setLoading(false);
      });
    return () => {
      epoch.current += 1;
    };
  }, [key, round]);

  const reload = useCallback(() => setRound((value) => value + 1), []);
  const set = useCallback((update: T | ((current: T | undefined) => T | undefined)) => {
    setData((current) =>
      typeof update === "function" ? (update as (current: T | undefined) => T | undefined)(current) : update,
    );
  }, []);

  return { data, error, loading, reload, set };
}

/**
 * Runs one write at a time: a second press while the first is out does
 * nothing. `busy` is for the button, the lock for the press that comes
 * before the render.
 */
export function useAction(): {
  busy: boolean;
  run: (work: () => Promise<void>, onError?: (error: unknown) => void) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async (work: () => Promise<void>, onError?: (error: unknown) => void) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      if (alive.current) onError?.(error);
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);
  return { busy, run };
}
