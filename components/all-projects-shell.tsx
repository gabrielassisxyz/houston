"use client";
import * as React from "react";
import { toast } from "sonner";
import type { Bead, BeadType } from "@/lib/schema";
import type { Meta } from "@/lib/api-client";
import {
  ALL_PROJECT_ID,
  projectOf,
  splitId,
  type AllBead,
  type AllBeadsMeta,
  type FailedProject,
  type ProjectSummary,
} from "@/lib/aggregate";
import { makeIndex } from "@/lib/beads-view";
import { filtersFromSearchParams } from "@/lib/filters";
import { allProjectsViews, type View } from "@/lib/views";
import { useAllBeads, useAllBeadsStream } from "@/hooks/use-all-beads";
import { useUrlState } from "@/hooks/use-url-state";
import { useViewerMode } from "@/hooks/use-viewer-mode";
import { AppProvider } from "@/components/app-context";
import { Board } from "@/components/board/board";
import { ListView } from "@/components/list-view";
import { EpicsView } from "@/components/epics-view";
import { BeadDetailDrawer } from "@/components/bead-detail-drawer";
import { CreateBeadModal } from "@/components/create-bead-modal";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { MobileSidebar, Sidebar } from "@/components/sidebar";
import { SprintBoardBar } from "@/components/sprints/sprint-board-bar";
import { ProjectChooser, type ProjectChoice } from "@/components/project-chooser";
import {
  ProjectScope,
  type CreateRequest,
  type ProjectScopeProps,
} from "@/components/project-scope";

const MAX_TRAIL = 25;

const ALL_VIEWS = allProjectsViews();
type AllView = "board" | "list" | "epics";

function viewOf(requested: string | null): AllView {
  return requested === "list" || requested === "epics" ? requested : "board";
}

function localIdOf(id: string): string {
  return splitId(id)?.localId ?? id;
}

/** The bead as its own project knows it, so the ordinary drawer shows the ids people use. */
function restoreBead(bead: AllBead): Bead {
  const restored: Bead = {
    ...bead,
    id: bead.local_id,
    dependencies: bead.dependencies.map((dep) => ({
      ...dep,
      depends_on_id: localIdOf(dep.depends_on_id),
      ...(dep.issue_id !== undefined ? { issue_id: localIdOf(dep.issue_id) } : {}),
    })),
  };
  if (bead.parent) restored.parent = localIdOf(bead.parent);
  return restored;
}

function projectMeta(meta: AllBeadsMeta, projectId: string, readOnly: boolean): Meta {
  return {
    kind: meta.projects.find((p) => p.id === projectId)?.kind ?? "br",
    humanActor: meta.humanActor,
    humanAllowlist: meta.humanAllowlist,
    pollIntervalMs: meta.pollIntervalMs,
    readOnly,
  };
}

/** The project's name, with its id when another project has the same name. */
function projectLabel(projects: ProjectSummary[], projectId: string): string {
  const project = projects.find((p) => p.id === projectId);
  if (!project) return projectId;
  const shared = projects.some((p) => p.id !== project.id && p.name === project.name);
  return shared ? `${project.name} (${project.id})` : project.name;
}

/** Every project that could be read, empty ones included; a project that failed has no choice. */
function projectChoices(projects: ProjectSummary[]): ProjectChoice[] {
  return projects.map((p) => ({ id: p.id, label: projectLabel(projects, p.id) }));
}

/**
 * The one project the address filters the page to. Nothing checks the filter before it gets
 * here, so two ids, an unknown id or the page's own pseudo id preset nothing.
 */
function filteredProject(
  params: Parameters<typeof filtersFromSearchParams>[0],
  projects: ProjectSummary[],
): string | undefined {
  const named = filtersFromSearchParams(params).projects;
  if (named.length !== 1) return undefined;
  return projects.some((p) => p.id === named[0]) ? named[0] : undefined;
}

/** One project's part of the merged list, as that project's own page would hold it. */
function useProjectSlice(
  beads: AllBead[],
  meta: AllBeadsMeta | undefined,
  projectId: string | undefined,
  readOnly: boolean,
) {
  const restored = React.useMemo(
    () => (projectId ? beads.filter((b) => b.project.id === projectId).map(restoreBead) : []),
    [beads, projectId],
  );
  const index = React.useMemo(() => makeIndex(restored), [restored]);
  const projectInfo = React.useMemo(
    () => (meta && projectId ? projectMeta(meta, projectId, readOnly) : undefined),
    [meta, projectId, readOnly],
  );
  return { beads: restored, index, meta: projectInfo };
}

/** A bead to create and its project; no project yet means the step that asks for one. */
interface CreateIntent {
  open: boolean;
  projectId: string;
  parentLocalId: string;
  type?: BeadType;
}

const NO_INTENT: CreateIntent = { open: false, projectId: "", parentLocalId: "" };

function writeBeadParam(id: string | null, mode: "push" | "replace"): void {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("bead", id);
  else url.searchParams.delete("bead");
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (mode === "push") window.history.pushState(window.history.state, "", next);
  else window.history.replaceState(window.history.state, "", next);
}

function missingMessage(id: string, failed: FailedProject[]): string {
  const owner = splitId(id)?.projectId;
  const down = failed.find((p) => p.id === owner);
  if (down) return `Bead ${localIdOf(id)} belongs to ${down.name}, which could not be read`;
  return `Bead ${id} not found in any project`;
}

/**
 * The drawer's trail of opened beads, seeded from `?bead=` and kept in step with it.
 * Ids are the namespaced ones; a bead that is not in the list (deleted, or its project
 * failed) opens nothing, but stays in the trail until a response settles whether it exists.
 */
function useDetailTrail(
  index: Map<string, Bead>,
  loaded: boolean,
  failed: FailedProject[],
) {
  const [stack, setStack] = React.useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    const seed = new URLSearchParams(window.location.search).get("bead");
    return seed ? [seed] : [];
  });
  const rawOpenId = stack.length ? stack[stack.length - 1] : null;
  const openId = rawOpenId && loaded && !index.has(rawOpenId) ? null : rawOpenId;
  const toasted = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!loaded || !rawOpenId || index.has(rawOpenId)) {
      if (loaded) toasted.current = null;
      return;
    }
    if (toasted.current === rawOpenId) return;
    toasted.current = rawOpenId;
    toast.error(missingMessage(rawOpenId, failed));
  }, [loaded, rawOpenId, index, failed]);

  React.useEffect(() => {
    const restore = () => {
      const id = new URLSearchParams(window.location.search).get("bead");
      if (id === rawOpenId) return;
      setStack(id ? [id] : []);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [rawOpenId]);

  React.useEffect(() => {
    writeBeadParam(openId, "replace");
  }, [openId, rawOpenId]);

  const open = React.useCallback((id: string) => setStack([id]), []);
  const push = React.useCallback(
    (id: string) => {
      if (stack[stack.length - 1] === id) return;
      writeBeadParam(id, "push");
      setStack((s) => [...s, id].slice(-MAX_TRAIL));
    },
    [stack],
  );
  const back = React.useCallback(() => {
    setStack((current) => {
      const next = current.slice(0, -1);
      while (next.length && !index.has(next[next.length - 1])) next.pop();
      return next;
    });
  }, [index]);
  const close = React.useCallback(() => setStack([]), []);

  return { stack, openId, open, push, back, close };
}

function FailedNotice({ failed }: { failed: FailedProject[] }) {
  if (failed.length === 0) return null;
  return (
    <div
      role="alert"
      className="shrink-0 border-b border-destructive/40 bg-destructive/5 px-4 py-2 text-[12.5px] text-destructive"
    >
      {failed.map((project) => (
        <p key={project.id}>
          <span className="font-semibold">{project.name}</span> could not be read, so its beads are
          missing from this page: {project.error}
        </p>
      ))}
    </div>
  );
}

/** The views and the ways out are the sidebar's, as on a project's page. */
function Header() {
  return (
    <header className="flex shrink-0 items-center gap-4 border-b border-border bg-[var(--surface)] px-4 py-2">
      <h1 className="text-[14px] font-semibold text-[var(--text)]">All projects</h1>
    </header>
  );
}

export function AllProjectsShell() {
  const { searchParams, updateUrl } = useUrlState();
  const view = viewOf(searchParams.get("view"));
  // Only the view changes: the filters ride along, as they do on a project's page.
  const setView = React.useCallback(
    (next: View) => updateUrl((params) => params.set("view", next)),
    [updateUrl],
  );
  const { data, isLoading, error } = useAllBeads();
  useAllBeadsStream();

  const beads = React.useMemo<AllBead[]>(() => data?.beads ?? [], [data]);
  const index = React.useMemo(() => makeIndex(beads), [beads]);
  const failed = React.useMemo<FailedProject[]>(() => data?.meta.failed ?? [], [data]);
  const projects = React.useMemo<ProjectSummary[]>(() => data?.meta.projects ?? [], [data]);
  const loaded = !isLoading && !error && !!data;
  const trail = useDetailTrail(index, loaded, failed);
  const { open: openTrail, push: pushTrail, close: closeTrail } = trail;
  const [selectedBeadId, selectBead] = React.useState<string | null>(null);
  const [focusEpic, setFocusEpic] = React.useState<{ id: string; nonce: number } | null>(null);
  const focusNonce = React.useRef(0);
  const clearFocusEpic = React.useCallback(() => setFocusEpic(null), []);

  const openDetail = React.useCallback(
    (id: string) => {
      selectBead(id);
      openTrail(id);
    },
    [openTrail],
  );
  const pushDetail = React.useCallback(
    (id: string) => {
      selectBead(id);
      pushTrail(id);
    },
    [pushTrail],
  );
  const openEpic = React.useCallback(
    (epicId: string) => {
      closeTrail();
      updateUrl((params) => params.set("view", "epics"));
      setFocusEpic({ id: epicId, nonce: (focusNonce.current += 1) });
    },
    [closeTrail, updateUrl],
  );

  const viewer = useViewerMode();
  // Until the mode is known the page behaves as read-only, as the project page does.
  const readOnly = viewer.data?.readOnly ?? true;
  const [intent, setIntent] = React.useState<CreateIntent>(NO_INTENT);
  const [intentMode, setIntentMode] = React.useState(readOnly);
  if (intentMode !== readOnly) {
    setIntentMode(readOnly);
    // Cleared rather than hidden, so the dialog does not come back by itself with editing.
    if (readOnly) setIntent(NO_INTENT);
  }
  const openCreate = React.useCallback(
    (projectId: string, request: CreateRequest) => {
      if (readOnly) return;
      setIntent({ open: true, projectId, parentLocalId: request.parent ?? "", type: request.type });
    },
    [readOnly],
  );
  const closeCreate = React.useCallback((open: boolean) => {
    if (!open) setIntent(NO_INTENT);
  }, []);
  // The page's own New buttons. A parent is a bead of this page, so it names its project.
  const createFromPage = React.useCallback(
    (request: CreateRequest = {}) => {
      if (request.parent) {
        const owner = splitId(request.parent);
        if (owner) openCreate(owner.projectId, { ...request, parent: owner.localId });
        return;
      }
      // The epics view neither shows nor applies the project filter.
      const preset = view === "epics" ? undefined : filteredProject(searchParams, projects);
      // Without one, the step asks: the project is never the one the last bead went to.
      openCreate(preset ?? "", request);
    },
    [openCreate, view, searchParams, projects],
  );
  const chooseProject = React.useCallback((projectId: string) => {
    setIntent((current) => (current.open ? { ...current, projectId } : current));
  }, []);

  const opened = trail.openId ? index.get(trail.openId) : undefined;
  const openProject = opened ? projectOf(opened as AllBead) : undefined;
  const drawerSlice = useProjectSlice(beads, data?.meta, openProject?.id, readOnly);
  const createSlice = useProjectSlice(
    beads,
    data?.meta,
    intent.open ? intent.projectId : undefined,
    readOnly,
  );

  const errorMessage = error ? (error as Error).message : undefined;
  const humanAllowlist = data?.meta.humanAllowlist ?? [];
  const handlers = { humanAllowlist, readOnly, selectBead, openDetail, pushDetail, openEpic, openCreate };
  // This page's context carries no project meta, so the actor's name is handed over.
  const sidebar = {
    view,
    onView: setView,
    projectId: ALL_PROJECT_ID,
    views: ALL_VIEWS,
    actorName: data?.meta.humanActor,
  };

  return (
    <AppProvider
      value={{
        projectId: ALL_PROJECT_ID,
        beads,
        index,
        humanAllowlist,
        readOnly,
        loading: isLoading,
        error: errorMessage,
        selectedBeadId,
        selectBead,
        openDetail,
        pushDetail,
        openCreate: createFromPage,
        openEpic,
        doneWindowDefault: "none",
      }}
    >
      <div className="flex h-full flex-col overflow-hidden bg-background text-foreground text-sm">
        <ReadOnlyBanner />
        <MobileSidebar {...sidebar} />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar {...sidebar} />
          <div className="flex min-w-0 flex-1 flex-col">
            <Header />
            {/* The epics view obeys no filter here, so it is never the view of one sprint. */}
            {view !== "epics" && <SprintBoardBar />}
            <FailedNotice failed={failed} />
            <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              {errorMessage ? (
                <div className="flex flex-1 items-center justify-center p-8">
                  <div className="max-w-md rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center">
                    <p className="text-sm font-medium text-destructive">Couldn’t read the projects</p>
                    <p className="mt-2 text-sm text-muted-foreground">{errorMessage}</p>
                  </div>
                </div>
              ) : (
                <>
                  {view === "board" && <Board />}
                  {view === "list" && <ListView />}
                  {view === "epics" && (
                    <EpicsView focusEpic={focusEpic} onFocusHandledAction={clearFocusEpic} />
                  )}
                </>
              )}
            </main>
          </div>
        </div>
      </div>
      {openProject && (
        <ProjectDrawer
          // A write still on its way reads its project again when it is sent and when it is
          // answered. Going from one project's bead to another's must therefore start a new
          // panel: reusing this one would send that write to the bead of the same id in the
          // project now shown.
          key={openProject.id}
          scope={{ projectId: openProject.id, ...drawerSlice, ...handlers }}
          stack={trail.stack}
          openId={trail.openId}
          onBack={trail.back}
          onClose={trail.close}
        />
      )}
      {intent.open && !readOnly && intent.projectId === "" && (
        <ProjectChooser
          choices={projectChoices(projects)}
          type={intent.type}
          onChooseAction={chooseProject}
          onCloseAction={() => closeCreate(false)}
        />
      )}
      {/* Never under the page's own provider: the form uploads an image to its project before
          the bead exists, and the page's project is none. */}
      {intent.open && !readOnly && intent.projectId !== "" && (
        <ProjectScope projectId={intent.projectId} {...createSlice} {...handlers}>
          <CreateBeadModal
            open
            parent={intent.parentLocalId}
            type={intent.type}
            projectLabel={projectLabel(data?.meta.projects ?? [], intent.projectId)}
            onOpenChange={closeCreate}
          />
        </ProjectScope>
      )}
    </AppProvider>
  );
}

interface ProjectDrawerProps {
  scope: Omit<ProjectScopeProps, "children">;
  stack: string[];
  openId: string | null;
  onBack: () => void;
  onClose: () => void;
}

/**
 * The ordinary drawer under the opened bead's own project, so its ids, its copy-link, its
 * attachment addresses and every write it makes are that project's.
 */
function ProjectDrawer({ scope, stack, openId, onBack, onClose }: ProjectDrawerProps) {
  const previous = stack.length > 1 ? stack[stack.length - 2] : null;
  return (
    <ProjectScope {...scope}>
      <BeadDetailDrawer
        openId={openId ? localIdOf(openId) : null}
        canGoBack={stack.length > 1}
        backTo={previous ? localIdOf(previous) : null}
        onBack={onBack}
        onClose={onClose}
      />
    </ProjectScope>
  );
}
