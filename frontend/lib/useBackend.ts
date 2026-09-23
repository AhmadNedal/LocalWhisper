"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BackendClient } from "./api";
import type { BackendStatus } from "./desktop";

export type BackendState =
  | { kind: "no-desktop" }
  | { kind: "starting" }
  | { kind: "ready"; client: BackendClient }
  | { kind: "error"; code: string; message: string };

/** Connects to the Python backend that Electron starts and supervises. */
export function useBackend(): { state: BackendState; retry: () => void } {
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [hasDesktop, setHasDesktop] = useState(true);

  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop) {
      setHasDesktop(false);
      return;
    }
    let active = true;
    const unsubscribe = desktop.onBackendStatus((s) => active && setStatus(s));
    desktop.getBackend().then((s) => active && setStatus(s));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const retry = useCallback(() => {
    setStatus({ state: "starting" });
    window.desktop?.restartBackend().then(setStatus);
  }, []);

  const state = useMemo<BackendState>(() => {
    if (!hasDesktop) return { kind: "no-desktop" };
    if (!status || status.state === "starting" || status.state === "stopped" || status.state === "locked") return { kind: "starting" };
    if (status.state === "error") return { kind: "error", code: status.code, message: status.message };
    return { kind: "ready", client: new BackendClient(status.url, status.token) };
  }, [status, hasDesktop]);

  return { state, retry };
}

/** useState persisted in localStorage (per-user UI preferences only). */
export function usePersistentState<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as T;
        // Objects are merged over defaults so newly added settings get a value.
        const isObject = typeof initial === "object" && initial !== null && !Array.isArray(initial);
        setValue(isObject ? ({ ...initialAsObject(initial), ...(parsed as object) } as T) : parsed);
      }
    } catch {
      /* storage unavailable or corrupted: keep defaults */
    }
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }, [key, value, loaded]);

  return [value, setValue];
}

function initialAsObject<T>(initial: T): object {
  return typeof initial === "object" && initial !== null && !Array.isArray(initial) ? initial : {};
}
