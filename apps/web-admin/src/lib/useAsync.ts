import { useCallback, useEffect, useRef, useState } from "react";

export type AsyncState<T> = {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** Re-run the loader. Keeps showing the previous data while it runs. */
  reload: () => void;
};

/**
 * Runs `load` whenever `deps` change and exposes its result. A response that
 * lands after the deps moved on is dropped, so switching employee or day can
 * never paint the previous one's data. `pollMs` refreshes in the background
 * (paused while the tab is hidden).
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[], pollMs?: number): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const run = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const execute = useCallback((background: boolean) => {
    const id = ++run.current;
    if (!background) setLoading(true);
    loadRef
      .current()
      .then((value) => {
        if (run.current !== id) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (run.current !== id) return;
        setError(err);
      })
      .finally(() => {
        if (run.current === id) setLoading(false);
      });
  }, []);

  useEffect(() => {
    setData(undefined);
    execute(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!pollMs) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      execute(true);
    }, pollMs);
    return () => clearInterval(timer);
  }, [execute, pollMs]);

  const reload = useCallback(() => execute(true), [execute]);
  return { data, error, loading, reload };
}
