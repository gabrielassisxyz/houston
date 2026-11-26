"use client";
import * as React from "react";
import { useChain } from "@/hooks/use-chain";
import type {
  Chain,
  ChainApproval,
  ChainDescendant,
  ChainEpic,
  ChainPipeline,
  TrackerItem,
} from "@/lib/chain";

function formatPtBrDate(raw: string): string | null {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function freshnessText(item: { freshness: string; lastConfirmedAt?: string }): string {
  if (item.freshness === "confirmed") return "confirmado";
  if (item.freshness === "partial") return "parcial";
  if (item.freshness === "historical") {
    const at = item.lastConfirmedAt ?? "";
    const formatted = formatPtBrDate(at);
    // An unparsable date is shown as plain text, never through the en-US helpers.
    return `histórico, confirmado em ${formatted ?? at}`;
  }
  return item.freshness;
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function TrackerLink({ link, text }: { link: string | null; text: string }) {
  if (link) return <ExtLink href={link}>{text}</ExtLink>;
  return <span>{text}</span>;
}

function ApprovalRow({ approval }: { approval: ChainApproval }) {
  return (
    <div data-chain-approval={approval.number}>
      <span>{approval.number}</span>
      {" · "}
      <span>{approval.title}</span>
      {approval.recordType !== "" && (
        <>
          {" · "}
          <span>{approval.recordType}</span>
        </>
      )}
      {" · "}
      <span>{approval.state}</span>
      {" · "}
      <span>{freshnessText(approval)}</span>
      {" · "}
      <TrackerLink link={approval.link} text={approval.link ?? "sem link"} />
    </div>
  );
}

function TrackerBlock({ tracker }: { tracker: TrackerItem }) {
  if (tracker.state === "absent") {
    return (
      <div data-tracker-state="absent">
        <span>fora do escopo coletado</span>
        {tracker.approvals.map((a) => (
          <ApprovalRow key={a.number} approval={a} />
        ))}
      </div>
    );
  }
  if (tracker.state === "unconfirmed") {
    return (
      <div data-tracker-state="unconfirmed">
        <span>não confirmado</span>
        {" · "}
        <span>{tracker.reason}</span>
        {tracker.approvals.map((a) => (
          <ApprovalRow key={a.number} approval={a} />
        ))}
      </div>
    );
  }
  return (
    <div data-tracker-state={tracker.freshness}>
      <span>{tracker.number}</span>
      {" · "}
      <span>{tracker.title}</span>
      {" · "}
      <span>{tracker.status}</span>
      {"sprint" in tracker && tracker.sprint && (
        <>
          {" · "}
          <span>{tracker.sprint}</span>
        </>
      )}
      {" · "}
      <span>{freshnessText(tracker)}</span>
      {" · "}
      <TrackerLink link={tracker.link} text={tracker.link ?? tracker.number} />
      {tracker.approvals.map((a) => (
        <ApprovalRow key={a.number} approval={a} />
      ))}
    </div>
  );
}

function EpicTrackerLine({ label, tracker }: { label: string; tracker: TrackerItem | null }) {
  if (!tracker) return null;
  if (tracker.state === "absent") {
    return (
      <div data-tracker-state="absent">
        <span>{label}</span>
        {" · "}
        <span>fora do escopo coletado</span>
        {tracker.approvals.map((a) => (
          <ApprovalRow key={a.number} approval={a} />
        ))}
      </div>
    );
  }
  if (tracker.state === "unconfirmed") {
    return (
      <div data-tracker-state="unconfirmed">
        <span>{label}</span>
        {" · "}
        <span>não confirmado</span>
        {" · "}
        <span>{tracker.reason}</span>
        {tracker.approvals.map((a) => (
          <ApprovalRow key={a.number} approval={a} />
        ))}
      </div>
    );
  }
  return (
    <div data-tracker-state={tracker.freshness}>
      <span>{label}</span>
      {" · "}
      <span>{tracker.number}</span>
      {" · "}
      <span>{tracker.status}</span>
      {" · "}
      <span>{freshnessText(tracker)}</span>
      {" · "}
      <TrackerLink link={tracker.link} text={tracker.link ?? tracker.number} />
      {tracker.approvals.map((a) => (
        <ApprovalRow key={a.number} approval={a} />
      ))}
    </div>
  );
}

function EpicRow({ epic }: { epic: ChainEpic }) {
  return (
    <div data-chain-epic={epic.id}>
      <span>{epic.id}</span>
      {" · "}
      <span>{epic.status}</span>
      {" · "}
      <span>{epic.title}</span>
      <EpicTrackerLine label={`tracker de ${epic.id}`} tracker={epic.tracker} />
    </div>
  );
}

function DescendantRow({ descendant }: { descendant: ChainDescendant }) {
  return (
    <div data-chain-descendant={descendant.id}>
      <span>{descendant.id}</span>
      {" · "}
      <span>{descendant.status}</span>
      {" · "}
      <span>{descendant.title}</span>
      <EpicTrackerLine label={`tracker de ${descendant.id}`} tracker={descendant.tracker} />
    </div>
  );
}

function PipelineBlock({ pipeline }: { pipeline: ChainPipeline }) {
  if (pipeline.state === "absent") {
    return (
      <div data-pipeline-state="absent">
        <span>fora do escopo coletado</span>
      </div>
    );
  }
  if (pipeline.state === "unconfirmed") {
    return (
      <div data-pipeline-state="unconfirmed">
        <span>não confirmado</span>
        {" · "}
        <span>{pipeline.reason}</span>
        {(pipeline.issues ?? []).map((issue, i) => (
          <div key={i} data-pipeline-issue={issue.part}>
            <span>{issue.part}</span>
            {issue.repo && (
              <>
                {" · "}
                <span>{issue.repo}</span>
              </>
            )}
            {typeof issue.runId === "number" && (
              <>
                {" · "}
                <span>{`run ${issue.runId}`}</span>
              </>
            )}
            {issue.error && (
              <>
                {" · "}
                <span>{issue.error}</span>
              </>
            )}
            {typeof issue.limit === "number" && (
              <>
                {" · "}
                <span>{`limite ${issue.limit}`}</span>
              </>
            )}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div data-pipeline-state={pipeline.freshness}>
      <span>{freshnessText(pipeline)}</span>
      {pipeline.runs.map((run) => (
        <div key={run.id} data-pipeline-run={run.id}>
          <span>{`run ${run.id}`}</span>
          {" · "}
          <span>{run.status}</span>
          {" · "}
          <TrackerLink link={run.link} text={run.link ?? `run ${run.id}`} />
          {run.existingPrs.map((pr) => (
            <span key={pr.number}>
              {" · "}
              <TrackerLink link={pr.link} text={pr.link ?? `PR ${pr.number}`} />
            </span>
          ))}
        </div>
      ))}
      {pipeline.prs.map((pr) => (
        <div key={pr.number} data-pipeline-pr={pr.number}>
          <span>{`PR ${pr.number}`}</span>
          {" · "}
          <TrackerLink link={pr.link} text={pr.link ?? `PR ${pr.number}`} />
          {pr.anomalies.map((anomaly) => (
            <span key={anomaly}>
              {" · "}
              <span>{anomaly}</span>
            </span>
          ))}
        </div>
      ))}
      {pipeline.issues.map((issue, i) => (
        <div key={i} data-pipeline-issue={issue.part}>
          <span>{issue.part}</span>
          {issue.repo && (
            <>
              {" · "}
              <span>{issue.repo}</span>
            </>
          )}
          {typeof issue.runId === "number" && (
            <>
              {" · "}
              <span>{`run ${issue.runId}`}</span>
            </>
          )}
          {issue.error && (
            <>
              {" · "}
              <span>{issue.error}</span>
            </>
          )}
          {typeof issue.limit === "number" && (
            <>
              {" · "}
              <span>{`limite ${issue.limit}`}</span>
            </>
          )}
        </div>
      ))}
      {pipeline.changes.map((change) => (
        <div key={change.number} data-pipeline-change={change.number}>
          <span>{change.number}</span>
          {" · "}
          <TrackerLink link={change.link} text={change.link ?? change.number} />
        </div>
      ))}
    </div>
  );
}

function isEmptyChain(chain: Chain): boolean {
  const hasTracker = chain.tracker !== null && chain.tracker !== undefined;
  const hasEpic = "epic" in chain && chain.epic !== null && chain.epic !== undefined;
  const hasDescendants = Array.isArray(chain.descendants) && chain.descendants.length > 0;
  const hasPipeline = chain.pipeline !== null && chain.pipeline !== undefined;
  return !hasTracker && !hasEpic && !hasDescendants && !hasPipeline;
}

export function ChainSection({
  projectId,
  beadId,
  enabled = true,
}: {
  projectId: string;
  beadId: string;
  enabled?: boolean;
}) {
  const query = useChain(projectId, beadId, enabled);
  return (
    <div lang="pt-BR" data-chain-section={`${projectId}:${beadId}`}>
      <h3>Relacionados</h3>
      {query.isPending && <div data-chain-loading>Carregando relacionados…</div>}
      {query.isError && (
        <div data-chain-error>
          <span>Não foi possível carregar os relacionados.</span>
          <button type="button" onClick={() => void query.refetch()}>
            Tentar de novo
          </button>
        </div>
      )}
      {query.data && isEmptyChain(query.data) && (
        <div data-chain-empty>Nenhum item ligado a este bead.</div>
      )}
      {query.data && !isEmptyChain(query.data) && (
        <>
          {query.data.tracker && <TrackerBlock tracker={query.data.tracker} />}
          {"epic" in query.data && query.data.epic && <EpicRow epic={query.data.epic} />}
          {Array.isArray(query.data.descendants) &&
            query.data.descendants.map((d) => <DescendantRow key={d.id} descendant={d} />)}
          {query.data.pipeline && <PipelineBlock pipeline={query.data.pipeline} />}
        </>
      )}
    </div>
  );
}
