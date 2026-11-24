import { listProjects } from "@/lib/config";
import { subscribeAllBeadsChange } from "@/lib/all-projects";
import { registerSseStream } from "@/lib/sse-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Keep the connection alive and let the server notice dead sockets. */
const HEARTBEAT_MS = 25_000;

/**
 * Signal-only stream: a `change` event when any project's tracker changes.
 * The projects watched are those registered when the stream opens; one added
 * later is picked up when the client reconnects.
 */
export async function GET(req: Request) {
  const projectIds = listProjects().map((p) => p.id);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The consumer went away without an abort. A bare flag here would
          // turn the later close() into a no-op and keep every watcher.
          close();
        }
      };

      const unsub = subscribeAllBeadsChange(projectIds, () =>
        send("event: change\ndata: 1\n\n"),
      );
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);

      let unregister = () => {};
      function close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsub();
        unregister();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      unregister = registerSseStream(close);
      req.signal.addEventListener("abort", close);
      // Last, so nothing is sent before there is something to release.
      send(": connected\n\n");
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
