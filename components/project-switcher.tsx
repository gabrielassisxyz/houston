"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Plus, LayoutGrid, Layers, CalendarRange, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useProjects } from "@/hooks/use-projects";
import { ALL_PROJECT_ID, SEARCH_PAGE_ID, WORK_PAGE_ID } from "@/lib/aggregate";
import { FolderBrowserModal } from "@/components/folder-browser-modal";

export function ProjectSwitcher({
  projectId,
  kind,
  live,
  onNavigate,
}: {
  projectId: string;
  kind?: "bd" | "br" | "demo";
  /** Whether the SSE change stream is connected (real projects only). */
  live?: boolean;
  /** Allows a containing mobile navigation Sheet to close after routing. */
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const { data } = useProjects();
  const [addOpen, setAddOpen] = React.useState(false);

  const projects = data?.projects ?? [];
  const demo = projects.find((p) => p.id === "demo");
  const recents = projects.filter((p) => p.id !== "demo");
  const current = projects.find((p) => p.id === projectId);
  // The page over every project has no project of its own to name, and no stream state to show.
  const isAll = projectId === ALL_PROJECT_ID;
  const isWork = projectId === WORK_PAGE_ID;
  const isSearch = projectId === SEARCH_PAGE_ID;
  const currentName = isAll
    ? "All projects"
    : isWork
      ? "Trabalho"
      : isSearch
        ? "Busca"
        : current?.name ?? (projectId === "demo" ? "Demo" : projectId);

  const isDemo = kind === "demo";
  const isLive = !isDemo && !!live;
  const dot = (
    <span
      title={isLive ? "Live — changes stream in instantly" : undefined}
      className={
        "h-[7px] w-[7px] flex-shrink-0 rounded-full" + (isLive ? " animate-pulse" : "")
      }
      style={{
        background: isDemo ? "#d97706" : "#22c55e",
        boxShadow: `0 0 0 3px ${isDemo ? "#d9770622" : "#22c55e22"}`,
      }}
    />
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Select project, current project ${currentName}`}
          className="mb-[6px] flex w-full items-center gap-[9px] rounded-[10px] border border-border bg-[var(--surface-2)] px-[11px] py-[9px] text-left hover:bg-[var(--surface-3)] focus:outline-none"
        >
          {!isAll && !isWork && !isSearch && dot}
          <div className="min-w-0 flex-1 leading-[1.15]">
            <div className="truncate text-[13px] font-[600] text-[var(--text)]">{currentName}</div>
            <div className="text-[10.5px] text-[var(--text-3)]">
              {isAll
                ? "every project"
                : isWork
                  ? "painel do trabalho"
                  : isSearch
                    ? "busca de notas"
                    : isDemo
                      ? "sample data"
                      : isLive
                        ? "live"
                        : "project"}
            </div>
          </div>
          <ChevronsUpDown size={14} className="flex-shrink-0 text-[var(--text-3)]" />
        </DropdownMenuTrigger>

        <DropdownMenuContent className="w-[210px]">
          <DropdownMenuLabel>Switch project</DropdownMenuLabel>

          {demo && (
            <DropdownMenuItem onClick={() => { onNavigate?.(); router.push("/p/demo"); }}>
              <span className="flex-1 truncate">Demo</span>
              {projectId === "demo" && <Check size={14} />}
            </DropdownMenuItem>
          )}

          {recents.length > 0 && <DropdownMenuSeparator />}
          {recents.map((p) => (
            <DropdownMenuItem key={p.id} onClick={() => { onNavigate?.(); router.push(`/p/${p.id}`); }}>
              <span
                className="h-[6px] w-[6px] flex-shrink-0 rounded-full"
                style={{ background: p.hasBeads ? "#22c55e" : "#ef4444" }}
              />
              <span className="flex-1 truncate">{p.name}</span>
              {p.id === projectId && <Check size={14} />}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAddOpen(true)}>
            <Plus size={14} />
            <span>Add project…</span>
          </DropdownMenuItem>
          {recents.length >= 2 && (
            <DropdownMenuItem onClick={() => { onNavigate?.(); router.push("/all"); }}>
              <Layers size={14} />
              <span className="flex-1">All projects</span>
              {isAll && <Check size={14} />}
            </DropdownMenuItem>
          )}
          {recents.length >= 1 && (
            <DropdownMenuItem onClick={() => { onNavigate?.(); router.push("/sprints"); }}>
              <CalendarRange size={14} />
              <span>Sprints</span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => { onNavigate?.(); router.push("/"); }}>
            <LayoutGrid size={14} />
            <span>Project picker</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <FolderBrowserModal open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}
