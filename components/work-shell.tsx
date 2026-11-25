"use client";
import * as React from "react";
import { AppProvider } from "@/components/app-context";
import { MobileSidebar, Sidebar } from "@/components/sidebar";
import type { Bead } from "@/lib/schema";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useWorkProbe } from "@/hooks/use-work-probe";
import { WORK_PAGE_ID } from "@/lib/aggregate";

const CHECKING = "Verificando o painel do trabalho…";
const CAPS_FAILED = "Não foi possível verificar a configuração.";
const UNCONFIGURED_TITLE = "O painel do trabalho não está configurado.";
const UNCONFIGURED_HINT = "Defina workDashboardUrl no arquivo de configuração e reinicie o Houston.";
const SELF_HINT = "Corrija workDashboardUrl no arquivo de configuração e reinicie o Houston.";
const UNREACHABLE_HINT = "Inicie o servidor do collector e tente de novo.";
const RETRY = "Tentar de novo";

// --- One-way fragment reader -------------------------------------------------

const hashListeners = new Set<() => void>();
let hashHistoryWrapped = false;

function notifyHashListeners() {
  for (const cb of hashListeners) cb();
}

/**
 * Wrap `pushState`/`replaceState` once, lazily, on the first subscription.
 * The wrapper calls the function it replaced and then notifies through
 * `queueMicrotask`, because a synchronous notification inside the App
 * Router's `useInsertionEffect` history write would schedule a React update
 * where React forbids one. The originals are never restored on unsubscribe,
 * since doing so could discard a wrapper installed after this one.
 */
function ensureHashHistoryWrapped() {
  if (hashHistoryWrapped) return;
  if (typeof window === "undefined" || !window.history) return;
  hashHistoryWrapped = true;
  const origPush = window.history.pushState.bind(window.history);
  const origReplace = window.history.replaceState.bind(window.history);
  window.history.pushState = function (
    ...args: Parameters<History["pushState"]>
  ) {
    const result = (origPush as (...a: Parameters<History["pushState"]>) => unknown)(...args);
    queueMicrotask(notifyHashListeners);
    return result as void;
  } as typeof window.history.pushState;
  window.history.replaceState = function (
    ...args: Parameters<History["replaceState"]>
  ) {
    const result = (origReplace as (...a: Parameters<History["replaceState"]>) => unknown)(...args);
    queueMicrotask(notifyHashListeners);
    return result as void;
  } as typeof window.history.replaceState;
}

function subscribeHash(cb: () => void) {
  hashListeners.add(cb);
  ensureHashHistoryWrapped();
  window.addEventListener("hashchange", cb);
  window.addEventListener("popstate", cb);
  return () => {
    hashListeners.delete(cb);
    window.removeEventListener("hashchange", cb);
    window.removeEventListener("popstate", cb);
  };
}

function getHashSnapshot() {
  return window.location.hash;
}

function getHashServerSnapshot() {
  return "";
}

function useHash() {
  return React.useSyncExternalStore(subscribeHash, getHashSnapshot, getHashServerSnapshot);
}

// --- Shell -------------------------------------------------------------------

function selfMessage(url: string) {
  return `O endereço configurado em workDashboardUrl (${url}) é o do próprio Houston.`;
}

export function WorkShell() {
  const caps = useCapabilities();
  const url = caps.data?.workDashboardUrl;
  const probe = useWorkProbe(url);
  const hash = useHash();

  const frameSrc = React.useMemo(() => {
    if (!url) return undefined;
    try {
      const next = new URL(url);
      next.hash = hash;
      return next.toString();
    } catch {
      return url;
    }
  }, [url, hash]);

  const providerValue = React.useMemo(
    () => ({
      projectId: WORK_PAGE_ID,
      beads: [] as Bead[],
      index: new Map<string, Bead>(),
      humanAllowlist: [] as string[],
      readOnly: false,
      loading: false,
      selectedBeadId: null as string | null,
      selectBead: () => {},
      openDetail: () => {},
      pushDetail: () => {},
      openCreate: () => {},
      openEpic: () => {},
    }),
    [],
  );

  // State 8 first for the layout flags: only a reachable answer shows the frame.
  // (The per-state logic below decides the same; this flag only seeds the layout.)

  let statusText: React.ReactNode = CHECKING;
  let statusExtra: React.ReactNode = null;
  let retry: { onRetry: () => void; disabled: boolean } | null = null;
  let showFrame = false;

  if (caps.isFetching && !caps.data && (caps.isError || caps.errorUpdatedAt > 0)) {
    statusText = CHECKING;
    retry = { onRetry: () => void caps.refetch(), disabled: true };
  } else if (caps.isPending) {
    statusText = CHECKING;
  } else if (caps.isError && !caps.data) {
    if (caps.isFetching) {
      statusText = CHECKING;
      retry = { onRetry: () => void caps.refetch(), disabled: true };
    } else {
      statusText = CAPS_FAILED;
      retry = { onRetry: () => void caps.refetch(), disabled: false };
    }
  } else if (!url) {
    statusText = UNCONFIGURED_TITLE;
    statusExtra = UNCONFIGURED_HINT;
  } else if (probe.isFetching && !probe.data && (probe.isError || probe.errorUpdatedAt > 0)) {
    statusText = CHECKING;
    retry = { onRetry: () => void probe.refetch(), disabled: true };
  } else if (probe.isPending) {
    statusText = CHECKING;
  } else if (
    probe.data?.configured === true &&
    "reason" in probe.data &&
    probe.data.reason === "self"
  ) {
    statusText = (
      <>
        {selfMessage(url).slice(0, selfMessage(url).indexOf(url))}
        <span className="break-all">{url}</span>
        {selfMessage(url).slice(selfMessage(url).indexOf(url) + url.length)}
      </>
    );
    statusExtra = SELF_HINT;
  } else if (probe.data && probe.data.configured === false) {
    statusText = UNCONFIGURED_TITLE;
    statusExtra = UNCONFIGURED_HINT;
  } else if (probe.isError || !(probe.data?.configured === true && probe.data?.reachable === true)) {
    if (probe.isFetching) {
      statusText = CHECKING;
      retry = { onRetry: () => void probe.refetch(), disabled: true };
    } else {
      statusText = (
        <>
          {"O painel do trabalho não respondeu em "}
          <span className="break-all">{url}</span>
          {"."}
        </>
      );
      statusExtra = UNREACHABLE_HINT;
      retry = { onRetry: () => void probe.refetch(), disabled: false };
    }
  } else {
    showFrame = true;
  }

  return (
    <AppProvider value={providerValue}>
      <div className="flex h-full flex-col overflow-hidden bg-background text-foreground text-sm">
        <MobileSidebar projectId={WORK_PAGE_ID} views={[]} />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar projectId={WORK_PAGE_ID} views={[]} />
          <div className="flex min-w-0 flex-1 flex-col">
            <main
              aria-label="Trabalho"
              lang="pt-BR"
              className="relative flex min-h-0 min-w-0 flex-1 flex-col"
            >
              <h1 className={showFrame ? "sr-only" : undefined}>Trabalho</h1>
              <div role="status" aria-live="polite" className={showFrame ? "sr-only" : undefined}>
                {showFrame ? null : (
                  <>
                    <p>{statusText}</p>
                    {statusExtra ? <p>{statusExtra}</p> : null}
                  </>
                )}
              </div>
              {!showFrame && retry ? (
                <div>
                  <button
                    type="button"
                    disabled={retry.disabled}
                    onClick={retry.onRetry}
                    className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
                  >
                    {RETRY}
                  </button>
                </div>
              ) : null}
              {showFrame && frameSrc ? (
                <iframe
                  src={frameSrc}
                  title="Painel do trabalho"
                  allow="clipboard-write"
                  className="h-full w-full flex-1 border-0"
                />
              ) : null}
            </main>
          </div>
        </div>
      </div>
    </AppProvider>
  );
}
