"use client";
import * as React from "react";
import type { Bead, BeadType } from "@/lib/schema";
import type { Meta } from "@/lib/api-client";
import { namespaceId } from "@/lib/aggregate";
import { AppProvider } from "@/components/app-context";

export interface CreateRequest {
  parent?: string;
  type?: BeadType;
}

export interface ProjectScopeProps {
  projectId: string;
  /** The project's beads under their own ids, as the project's own page would hold them. */
  beads: Bead[];
  index: Map<string, Bead>;
  meta?: Meta;
  humanAllowlist: string[];
  readOnly: boolean;
  /** The page's handlers, which take namespaced ids. */
  selectBead: (id: string | null) => void;
  openDetail: (id: string) => void;
  pushDetail: (id: string) => void;
  openEpic: (id: string) => void;
  /** Receives the scope's project and the own id of the parent, if any. */
  openCreate: (projectId: string, request: CreateRequest) => void;
  children: React.ReactNode;
}

/**
 * One project of the all-projects page, provided to the ordinary components inside it as if it
 * were that project's page: every hook they call addresses this project under the ids its tracker
 * knows. The handlers turn an own id back into the namespaced one before it leaves the scope.
 */
export function ProjectScope(props: ProjectScopeProps) {
  const { projectId, selectBead, openDetail, pushDetail, openEpic, openCreate } = props;
  const namespaced = (id: string) => namespaceId(projectId, id);
  const value = {
    projectId,
    beads: props.beads,
    index: props.index,
    meta: props.meta,
    humanAllowlist: props.humanAllowlist,
    readOnly: props.readOnly,
    loading: false,
    selectedBeadId: null,
    selectBead: (id: string | null) => selectBead(id === null ? null : namespaced(id)),
    openDetail: (id: string) => openDetail(namespaced(id)),
    pushDetail: (id: string) => pushDetail(namespaced(id)),
    openCreate: (request: CreateRequest = {}) => openCreate(projectId, request),
    openEpic: (id: string) => openEpic(namespaced(id)),
  };
  return <AppProvider value={value}>{props.children}</AppProvider>;
}
