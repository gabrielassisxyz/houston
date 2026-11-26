"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCapabilities, type Capabilities } from "@/hooks/use-capabilities";
import { hasOpenOverlay } from "@/hooks/use-app-keyboard";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
  );
}

/**
 * The cached capabilities without subscribing to the `["capabilities"]`
 * query: a second subscription next to the sidebar's breaks the hydration of
 * every page when notes are configured.
 */
function useCapabilitiesSnapshot(): Capabilities | undefined {
  const client = useQueryClient();
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] === "capabilities") force();
    });
    return unsubscribe;
  }, [client]);
  return client.getQueryData<Capabilities>(["capabilities"]);
}

/**
 * Cmd/Ctrl+Shift+F opens the notes search from any page. Mounted inside the
 * query provider so it can read the capabilities; the per-project keyboard
 * layer cannot host it because it only mounts in the project shell.
 *
 * Its own read keeps a separate query key: a second subscription to
 * `["capabilities"]` next to the sidebar's breaks the hydration of every
 * page when notes are configured. Because this component mounts on every
 * page, the read also happens on `/sprints` and `/sprints/[id]`, which
 * otherwise read no capabilities. The extra request per page is the cost of
 * keeping the shortcut's enablement independent of whichever shell the page
 * happens to render.
 *
 * On /search itself it focuses the query box instead of navigating, which
 * would drop the filters in the URL. It cannot fire from inside the framed
 * work dashboard: key events in the frame never reach this window. The
 * current address is read from `window.location` in the handler, so the
 * component never subscribes to the router during render.
 */
export function SearchShortcut() {
  const router = useRouter();
  const cached = useCapabilitiesSnapshot();
  const own = useQuery({
    queryKey: ["notes-capabilities"],
    queryFn: ({ signal }) => fetchCapabilities(signal),
    retry: false,
  });
  const caps = cached ?? own.data;
  const enabled = caps?.notes === true;
  const enabledRef = React.useRef(enabled);

  React.useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (!enabledRef.current) return;
      if (event.defaultPrevented) return;
      if (event.repeat) return;
      if (event.altKey) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (!event.shiftKey) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key !== "f") return;
      if (hasOpenOverlay()) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      if (window.location.pathname === "/search") {
        document.querySelector<HTMLInputElement>("input[data-notes-search]")?.focus();
        return;
      }
      router.push("/search");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, router]);

  return null;
}
