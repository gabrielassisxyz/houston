"use client";
import * as React from "react";
import { Icon } from "@/components/icons";
import { useTheme } from "@/components/theme-provider";
import { useApp, type View } from "@/components/app-context";
import { ProjectSwitcher } from "@/components/project-switcher";
import { initials, avatarColor, needsHuman, readyHumanGate } from "@/lib/beads-view";
import { useGamification } from "@/hooks/use-beads";
import { BuildBadge } from "@/components/build-badge";
import { ResizeHandle } from "@/components/resize-handle";
import { useResizableWidth } from "@/hooks/use-resizable-width";
import { cn } from "@/lib/utils";
import { navViews, type ViewNavItem } from "@/lib/views";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Briefcase, Menu, Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCapabilities } from "@/hooks/use-capabilities";

export interface SidebarProps {
  view?: View;
  onView?: (v: View) => void;
  kind?: "bd" | "br" | "demo";
  projectId: string;
  live?: boolean;
  /** The views to offer, for a page that has fewer than a project's own. */
  views?: ViewNavItem[];
  /** The human actor's name, for a page whose context carries no project meta. */
  actorName?: string;
  /** Render the same navigation inside the mobile Sheet. */
  mobile?: boolean;
  /** Close an owning mobile Sheet after project routing. */
  onProjectNavigate?: () => void;
}

export function Sidebar({
  view,
  onView,
  kind,
  projectId,
  live,
  views,
  actorName,
  mobile = false,
  onProjectNavigate,
}: SidebarProps) {
  const { mode, toggle } = useTheme();
  const { meta, beads, index } = useApp();
  const actor = actorName ?? meta?.humanActor ?? "you";
  const epicCount = beads.filter((b) => b.issue_type === "epic").length;
  // "Needs You" = agent-flagged beads (bd human) + ready human-approval gates.
  const needsYouCount =
    beads.filter(needsHuman).length + beads.filter((b) => readyHumanGate(b, index)).length;
  const game = useGamification(projectId, !!meta?.gamification);
  const { width, startResize } = useSidebarWidth();
  const pathname = usePathname();
  const caps = useCapabilities();
  const workUrl = caps.data?.workDashboardUrl;
  const viewList = views ?? navViews(!!meta?.gamification);
  const showViews = viewList.length > 0;
  const showWork = !!workUrl;
  const showSearch = caps.data?.notes === true;
  const showDestinations = showWork || showSearch;
  const workActive = pathname === "/work";
  const searchActive = pathname === "/search";

  return (
    <aside
      style={mobile ? undefined : { width }}
      className={cn(
        mobile
          ? "flex h-full w-full min-w-0 flex-col overflow-y-auto border-0 bg-[var(--surface)] p-[18px_14px]"
          : "relative hidden flex-shrink-0 flex-col border-r border-border bg-[var(--surface)] p-[18px_14px] md:flex",
      )}
    >
      {!mobile && <ResizeHandle label="Resize sidebar" onPointerDown={startResize} className="right-0" />}
      <div className="flex items-center gap-[10px] px-2 pb-[18px] pt-1">
        <div
          className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[9px] text-white"
          style={{ background: "var(--brand)", boxShadow: "0 2px 8px -2px var(--brand)" }}
        >
          <Icon name="logo" size={17} />
        </div>
        <div className="text-sm font-[650] leading-[1.15] tracking-[-.01em]">
          Houston
        </div>
      </div>

      <ProjectSwitcher projectId={projectId} kind={kind} live={live} onNavigate={onProjectNavigate} />


      <nav className="flex flex-col gap-[2px]">
        {showViews ? (
          <div data-nav-group="views" className="flex flex-col gap-[2px]">
            {viewList.map((n) => {
              const active = view === n.key;
              return (
                <button
                  key={n.key}
                  onClick={() => onView?.(n.key)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex w-full items-center gap-[10px] rounded-[9px] px-[10px] py-2 text-left text-[13.5px] transition-colors",
                    active
                      ? "bg-[var(--brand-weak)] font-semibold text-[var(--brand)]"
                      : "font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
                  )}
                >
                  <Icon name={n.icon} size={17} className="flex-shrink-0" />
                  <span className="flex-1">{n.label}</span>
                  {n.key === "epics" && epicCount > 0 && (
                    <span className="font-mono text-[11px] text-[var(--text-3)]">{epicCount}</span>
                  )}
                  {n.key === "needsyou" && needsYouCount > 0 && (
                    <span
                      className="min-w-[18px] rounded-full px-[6px] py-px text-center text-[11px] font-semibold text-white"
                      style={{ background: "var(--brand)" }}
                    >
                      {needsYouCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : null}
        {showViews && showDestinations ? (
          <div aria-hidden="true" className="mx-2 my-1 border-t border-border" />
        ) : null}
        {showDestinations ? (
          <div data-nav-group="destinations" className="flex flex-col gap-[2px]">
            {showWork ? (
              <Link
                href="/work"
                aria-current={workActive ? "page" : undefined}
                onClick={() => onProjectNavigate?.()}
                className={cn(
                  "flex w-full items-center gap-[10px] rounded-[9px] px-[10px] py-2 text-left text-[13.5px] transition-colors",
                  workActive
                    ? "bg-[var(--brand-weak)] font-semibold text-[var(--brand)]"
                    : "font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
                )}
              >
                <Briefcase size={17} className="flex-shrink-0" aria-hidden="true" />
                <span className="flex-1">Trabalho</span>
              </Link>
            ) : null}
            {showSearch ? (
              <Link
                href="/search"
                aria-current={searchActive ? "page" : undefined}
                onClick={() => onProjectNavigate?.()}
                className={cn(
                  "flex w-full items-center gap-[10px] rounded-[9px] px-[10px] py-2 text-left text-[13.5px] transition-colors",
                  searchActive
                    ? "bg-[var(--brand-weak)] font-semibold text-[var(--brand)]"
                    : "font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
                )}
              >
                <Search size={17} className="flex-shrink-0" aria-hidden="true" />
                <span className="flex-1">Busca</span>
              </Link>
            ) : null}
          </div>
        ) : null}
      </nav>

      <div className="mt-auto flex flex-col gap-[10px]">
        {meta?.gamification && game.data && (
          <div className="rounded-[10px] border border-border bg-[var(--surface)] px-[11px] py-[9px]">
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="font-[650]">Level {game.data.you.level}</span>
              <span className="font-mono text-[var(--text-3)]">{game.data.you.xp} XP</span>
            </div>
            <div className="mt-[6px] h-[6px] overflow-hidden rounded-full bg-[var(--surface-3)]">
              <div
                className="h-full rounded-full transition-[width]"
                style={{
                  width: `${Math.round(game.data.you.progress * 100)}%`,
                  background: "var(--brand)",
                }}
              />
            </div>
            <div className="mt-[4px] text-[10.5px] text-[var(--text-3)]">
              {game.data.you.closed} closed ·{" "}
              {Math.max(0, game.data.you.span - game.data.you.intoLevel)} XP to L
              {game.data.you.level + 1}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 px-1">
          <div
            className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold text-white"
            style={{ background: avatarColor(actor) }}
          >
            {initials(actor)}
          </div>
          <div className="flex-1 leading-[1.15]">
            <div className="text-[12.5px] font-[550]">{actor}</div>
            <div className="text-[11px] text-[var(--text-3)]">human actor</div>
          </div>
          <button
            onClick={toggle}
            title="Toggle theme"
            className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-border bg-[var(--surface)] text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          >
            <Icon name={mode === "dark" ? "sun" : "moon"} size={15} />
          </button>
        </div>

        <BuildBadge />
      </div>
    </aside>
  );
}

/**
 * The bar a narrow screen shows in place of the sidebar, and the sheet that opens the same
 * sidebar from it. Choosing a view or a project closes the sheet.
 */
export function MobileSidebar(props: Omit<SidebarProps, "mobile" | "onProjectNavigate">) {
  const [open, setOpen] = React.useState(false);
  const { onView } = props;
  const chooseView = React.useCallback(
    (next: View) => {
      onView?.(next);
      setOpen(false);
    },
    [onView],
  );
  React.useEffect(() => {
    const desktop = window.matchMedia("(min-width: 48rem)");
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false);
    };
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, []);

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-[var(--surface)] px-3 py-2 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger
          type="button"
          aria-label="Open navigation and project menu"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border border-border bg-[var(--surface-2)] text-[var(--text-2)] hover:bg-[var(--surface-3)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        >
          <Menu size={18} aria-hidden="true" />
          <span className="sr-only">Open navigation and project menu</span>
        </SheetTrigger>
        <SheetContent
          side="left"
          className="w-[min(88vw,300px)] max-w-[88vw] gap-0 overflow-hidden border-r border-border bg-[var(--surface)] p-0"
        >
          <SheetTitle className="sr-only">Project and view navigation</SheetTitle>
          <SheetDescription className="sr-only">
            Choose a project or review view.
          </SheetDescription>
          <Sidebar {...props} mobile onView={chooseView} onProjectNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-[var(--text)]">
        Houston
      </div>
    </div>
  );
}

const DEFAULT_WIDTH = 228;

function subscribeNever() {
  return () => {};
}

function useSidebarWidth() {
  const { width, startResize } = useResizableWidth({
    storageKey: "bmus.width.sidebar",
    defaultWidth: DEFAULT_WIDTH,
    min: 180,
    max: 400,
    deltaFactor: 1,
  });
  // The sidebar renders on the server, which can't see the saved width, so
  // apply it only after hydration or React reports a markup mismatch.
  const hydrated = React.useSyncExternalStore(subscribeNever, () => true, () => false);
  return { width: hydrated ? width : DEFAULT_WIDTH, startResize };
}
