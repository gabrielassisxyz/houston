"use client";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AppProvider } from "@/components/app-context";
import { MobileSidebar, Sidebar } from "@/components/sidebar";
import type { Bead } from "@/lib/schema";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useUrlState } from "@/hooks/use-url-state";
import { SEARCH_PAGE_ID } from "@/lib/aggregate";
import { obsidianLink } from "@/lib/obsidian-link";

const SEARCH_LIMIT = 20;
const DEBOUNCE_MS = 350;

const CHECKING = "Verificando a configuração…";
const CAPS_FAILED = "Não foi possível verificar a configuração.";
const UNCONFIGURED_TITLE = "A busca de notas não está configurada.";
const UNCONFIGURED_HINT = "Defina notesServiceUrl no arquivo de configuração e reinicie o Houston.";
const UNAVAILABLE_TITLE = "O serviço de notas não está disponível.";
const INVALID_TITLE = "Busca inválida.";
const EMPTY_QUERY = "Digite um termo para buscar nas notas.";
const NO_HITS = "Nenhuma nota encontrada.";
const SEARCHING = "Buscando…";

interface SearchHit {
  id: string;
  title: string;
  path: string;
  kind: string;
  tags: string[];
  snippet: string;
}

interface SearchAnswer {
  hits: SearchHit[];
  total: number;
  limit: number;
  offset: number;
}

type SearchState =
  | { kind: "ok"; answer: SearchAnswer }
  | { kind: "invalid"; message: string }
  | { kind: "service"; status: "unconfigured" | "unavailable"; reason: string };

function Snippet({ text }: { text: string }) {
  const nodes: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  for (;;) {
    const start = rest.indexOf("");
    if (start === -1) {
      nodes.push(rest);
      break;
    }
    const end = rest.indexOf("", start + 1);
    if (end === -1) {
      nodes.push(rest);
      break;
    }
    if (start > 0) nodes.push(rest.slice(0, start));
    nodes.push(<mark key={key++}>{rest.slice(start + 1, end)}</mark>);
    rest = rest.slice(end + 1);
  }
  return <>{nodes}</>;
}

export function SearchShell() {
  const caps = useCapabilities();
  const { searchParams, updateUrl } = useUrlState();

  const qParam = searchParams.get("q") ?? "";
  const tagParam = searchParams.get("tag") ?? "";
  const folderParam = searchParams.get("folder") ?? "";
  const kindParam = searchParams.get("kind") ?? "";
  const offsetParam = searchParams.get("offset") ?? "";

  // The boxes hold what was typed until the URL catches up, like the board's
  // search box does, so fast typing keeps every keystroke even when
  // useSearchParams reflects each history update a render late. Back and
  // forward drop the pending text, since only the URL knows where the
  // browser went.
  const [pendingQ, setPendingQ] = React.useState<string | null>(null);
  const [pendingTag, setPendingTag] = React.useState<string | null>(null);
  const [pendingFolder, setPendingFolder] = React.useState<string | null>(null);
  if (pendingQ !== null && pendingQ === qParam) setPendingQ(null);
  if (pendingTag !== null && pendingTag === tagParam) setPendingTag(null);
  if (pendingFolder !== null && pendingFolder === folderParam) setPendingFolder(null);
  const qInput = pendingQ ?? qParam;
  const tagInput = pendingTag ?? tagParam;
  const folderInput = pendingFolder ?? folderParam;

  React.useEffect(() => {
    const reset = () => {
      setPendingQ(null);
      setPendingTag(null);
      setPendingFolder(null);
    };
    window.addEventListener("popstate", reset);
    return () => window.removeEventListener("popstate", reset);
  }, []);

  const writeParams = React.useCallback(
    (next: { q: string; tag: string; folder: string; kind: string }) => {
      updateUrl((params) => {
        if (next.q) params.set("q", next.q);
        else params.delete("q");
        if (next.tag) params.set("tag", next.tag);
        else params.delete("tag");
        if (next.folder) params.set("folder", next.folder);
        else params.delete("folder");
        if (next.kind) params.set("kind", next.kind);
        else params.delete("kind");
        params.delete("offset");
      });
    },
    [updateUrl],
  );

  const debounceRef = React.useRef<{ q: string; tag: string; folder: string } | null>(null);
  React.useEffect(() => {
    if (qInput === qParam && tagInput === tagParam && folderInput === folderParam) return;
    debounceRef.current = { q: qInput, tag: tagInput, folder: folderInput };
    const timer = setTimeout(() => {
      const pending = debounceRef.current;
      if (!pending) return;
      writeParams({ ...pending, kind: kindParam });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [qInput, tagInput, folderInput, kindParam, qParam, tagParam, folderParam, writeParams]);

  const setKind = React.useCallback(
    (kind: string) => {
      updateUrl((params) => {
        if (kind) params.set("kind", kind);
        else params.delete("kind");
        params.delete("offset");
      });
    },
    [updateUrl],
  );

  const setOffset = React.useCallback(
    (offset: number) => {
      updateUrl((params) => {
        if (offset > 0) params.set("offset", String(offset));
        else params.delete("offset");
      });
    },
    [updateUrl],
  );

  const trimmedQ = qParam.trim();
  const notesOn = caps.data?.notes === true;
  const vault = caps.data?.obsidianVault ?? null;
  const offsetNum = offsetParam === "" ? 0 : Number(offsetParam);

  const search = useQuery({
    queryKey: ["notes-search", qParam, tagParam, folderParam, kindParam, offsetParam],
    queryFn: async ({ signal }): Promise<SearchState> => {
      const params = new URLSearchParams();
      params.set("q", qParam);
      if (tagParam) params.set("tag", tagParam);
      if (folderParam) params.set("folder", folderParam);
      if (kindParam) params.set("kind", kindParam);
      params.set("limit", String(SEARCH_LIMIT));
      if (offsetParam) params.set("offset", offsetParam);
      const res = await fetch(`/api/notes/search?${params.toString()}`, {
        cache: "no-store",
        signal,
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 400) {
        const message =
          typeof (body as { error?: unknown }).error === "string" &&
          (body as { error: string }).error
            ? (body as { error: string }).error
            : INVALID_TITLE;
        return { kind: "invalid", message };
      }
      if (res.status === 503) {
        const status =
          (body as { status?: unknown }).status === "unconfigured"
            ? "unconfigured"
            : "unavailable";
        const reason =
          typeof (body as { reason?: unknown }).reason === "string"
            ? (body as { reason: string }).reason
            : "";
        return { kind: "service", status, reason };
      }
      if (!res.ok) {
        return { kind: "service", status: "unavailable", reason: `HTTP ${res.status}` };
      }
      return { kind: "ok", answer: body as SearchAnswer };
    },
    enabled: notesOn && trimmedQ !== "" && !caps.isPending,
    retry: false,
  });

  const providerValue = React.useMemo(
    () => ({
      projectId: SEARCH_PAGE_ID,
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

  let body: React.ReactNode;
  if (caps.isPending) {
    body = <p role="status">{CHECKING}</p>;
  } else if (caps.isError && !caps.data) {
    body = (
      <div role="status">
        <p>{CAPS_FAILED}</p>
      </div>
    );
  } else if (!notesOn) {
    body = (
      <div role="status">
        <p>{UNCONFIGURED_TITLE}</p>
        <p>{UNCONFIGURED_HINT}</p>
      </div>
    );
  } else if (trimmedQ === "") {
    body = (
      <div role="status">
        <p>{EMPTY_QUERY}</p>
      </div>
    );
  } else if (search.isPending) {
    body = (
      <div role="status">
        <p>{SEARCHING}</p>
      </div>
    );
  } else if (search.data?.kind === "invalid") {
    body = (
      <div role="alert">
        <p>{INVALID_TITLE}</p>
        <p>{search.data.message}</p>
      </div>
    );
  } else if (search.data?.kind === "service") {
    if (search.data.status === "unconfigured") {
      body = (
        <div role="status">
          <p>{UNCONFIGURED_TITLE}</p>
          <p>{UNCONFIGURED_HINT}</p>
        </div>
      );
    } else {
      body = (
        <div role="status">
          <p>{UNAVAILABLE_TITLE}</p>
          {search.data.reason ? <p>{search.data.reason}</p> : null}
        </div>
      );
    }
  } else if (search.isError) {
    body = (
      <div role="status">
        <p>{UNAVAILABLE_TITLE}</p>
      </div>
    );
  } else if (search.data?.kind === "ok") {
    const answer = search.data.answer;
    if (answer.total === 0) {
      body = (
        <div role="status">
          <p>{NO_HITS}</p>
        </div>
      );
    } else {
      const from = answer.offset + 1;
      const to = Math.min(answer.offset + answer.hits.length, answer.total);
      const prevOffset = answer.offset - answer.limit;
      const nextOffset = answer.offset + answer.limit;
      body = (
        <div className="flex min-h-0 flex-1 flex-col">
          <p role="status" className="px-1 py-2 text-[12.5px] text-[var(--text-3)]">
            {`Mostrando ${from}–${to} de ${answer.total}`}
          </p>
          <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {answer.hits.map((hit) => {
              const href = obsidianLink(vault, hit.path);
              return (
              <li
                key={hit.id}
                data-testid="search-hit"
                data-hit-id={hit.id}
                className="rounded-[10px] border border-border bg-[var(--surface)] p-3"
              >
                <div className="truncate text-[13.5px] font-[600]">{hit.title}</div>
                <div className="truncate font-mono text-[11.5px] text-[var(--text-3)]">
                  {href ? <a href={href}>{hit.path}</a> : hit.path}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-[11.5px] text-[var(--text-3)]">
                  <span>{hit.kind}</span>
                  {hit.tags.map((tag) => (
                    <span key={`${hit.id}-${tag}`}>{tag}</span>
                  ))}
                </div>
                <p className="mt-1 text-[12.5px] text-[var(--text-2)]">
                  <Snippet text={hit.snippet} />
                </p>
              </li>
              );
            })}
          </ul>
          <div className="flex items-center gap-2 py-3">
            <button
              type="button"
              disabled={answer.offset <= 0}
              onClick={() => setOffset(Math.max(0, prevOffset))}
              className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
            >
              Anterior
            </button>
            <button
              type="button"
              disabled={answer.offset + answer.limit >= answer.total}
              onClick={() => setOffset(nextOffset)}
              className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
            >
              Próxima
            </button>
          </div>
        </div>
      );
    }
  } else {
    body = (
      <div role="status">
        <p>{SEARCHING}</p>
      </div>
    );
  }

  void offsetNum;

  return (
    <AppProvider value={providerValue}>
      <div className="flex h-full flex-col overflow-hidden bg-background text-foreground text-sm">
        <MobileSidebar projectId={SEARCH_PAGE_ID} views={[]} />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar projectId={SEARCH_PAGE_ID} views={[]} />
          <div className="flex min-w-0 flex-1 flex-col">
            <main
              aria-label="Busca"
              lang="pt-BR"
              className="relative flex min-h-0 min-w-0 flex-1 flex-col p-4"
            >
              <h1>Busca</h1>
              <form
                role="search"
                aria-label="Buscar nas notas"
                onSubmit={(event) => event.preventDefault()}
                className="flex flex-wrap gap-2"
              >
                <input
                  data-notes-search
                  aria-label="Buscar nas notas"
                  value={qInput}
                  onChange={(event) => setPendingQ(event.target.value)}
                  placeholder="Buscar nas notas"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-[38px] min-w-[200px] flex-1 rounded-[9px] border border-border bg-[var(--surface-2)] px-3 text-[13px] outline-none focus:border-[var(--brand)]"
                />
                <input
                  data-notes-tag
                  aria-label="Filtrar por tag"
                  value={tagInput}
                  onChange={(event) => setPendingTag(event.target.value)}
                  placeholder="tag"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-[38px] w-[140px] rounded-[9px] border border-border bg-[var(--surface-2)] px-3 text-[13px] outline-none focus:border-[var(--brand)]"
                />
                <input
                  data-notes-folder
                  aria-label="Filtrar por pasta"
                  value={folderInput}
                  onChange={(event) => setPendingFolder(event.target.value)}
                  placeholder="pasta"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-[38px] w-[140px] rounded-[9px] border border-border bg-[var(--surface-2)] px-3 text-[13px] outline-none focus:border-[var(--brand)]"
                />
                <select
                  data-notes-kind
                  aria-label="Filtrar por tipo"
                  value={kindParam}
                  onChange={(event) => setKind(event.target.value)}
                  className="h-[38px] rounded-[9px] border border-border bg-[var(--surface-2)] px-3 text-[13px] outline-none focus:border-[var(--brand)]"
                >
                  <option value="">todos os tipos</option>
                  <option value="plano">plano</option>
                  <option value="implementacao">implementacao</option>
                  <option value="evidencia">evidencia</option>
                  <option value="nota">nota</option>
                </select>
              </form>
              <div className="mt-3 flex min-h-0 flex-1 flex-col">{body}</div>
            </main>
          </div>
        </div>
      </div>
    </AppProvider>
  );
}
