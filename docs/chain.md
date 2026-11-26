# The chain and the links

Two read routes serve the chain of a bead: one answers the chain of a bead in
a project for the pages, and the other takes any identifier and answers every
bead in every project that carries it, plus what the snapshot says. Both are
reads, so viewer mode leaves them alone, and every answer of both, 400 and 404
included, carries `Cache-Control: no-store`.

## The chain of a bead

`GET /api/p/[projectId]/beads/[id]/chain` answers the chain of one bead. An
unknown project or an unknown bead answers 404.

The answer is one object:

- `bead`: the bead itself, with `id`, `projectId`, `type`, `status`, `title`,
  and `externalRef` when the bead carries a reference.
- `tracker`: the work-tracker item the reference names, or null when the bead
  carries none. It is one of three states:
  - `found`, with `source`, `number`, `title`, `status`, `link` (null when the
    record's link is not an address on the configured ticket host), `sprint`
    when the record names a non-blank one, `approvals`, `freshness`, and
    `lastConfirmedAt` beside `historical` only.
  - `absent`, with `approvals`, when every ticket source was read wholly and
    none holds the number.
  - `unconfirmed`, with `reason` and `approvals`, when the snapshot is
    unavailable or a ticket source went unread.
- `descendants`: only on an epic, every bead under it at any depth, each with
  `id`, `type`, `status`, `title`, `externalRef` when one is set, and its own
  `tracker` item.
- `epic`: only on a bead that is not an epic, the nearest enclosing epic with
  `id`, `status`, `title`, `externalRef` when one is set, and its `tracker`
  item, or null when no epic sits above the bead.
- `pipeline`: only when the project names a pipeline repository. It is one of
  three states:
  - `found`, with `runs` (newest first, each with `id`, `createdAt`,
    `status`, `conclusion`, `head`, `link` and `existingPrs`), `prs` (by number,
    each with `number`, `base`, `head`, `anomalies` and `link`), `issues`,
    `changes` (each with `number` and `link`), and `freshness` (`historical`
    carries `lastConfirmedAt`; an issue for the repository reads `partial`).
  - `absent`, when the source was read wholly and holds nothing for the
    repository.
  - `unconfirmed`, with `reason` and `issues` when any name the repository.
- `snapshot`: `available` true, or false with the `reason` the file could not
  be read. The demo project has no pipeline part either way.
- `notes`: only when the notes service is configured; absent otherwise. For an
  epic the hub asks about its id, every descendant's id and every
  `externalRef` among them; for any other bead its id and its `externalRef`.
  Identifiers are de-duplicated without regard to case and any holding a comma
  is left out, because the refs route splits its `ids` list on commas. Calls go
  in batches of at most 200 identifiers with `hop=1`, so the one-hop notes come
  back in the same call, and stop for the rest of the request after the first
  unavailable answer. It is one of two states:
  - `available`, with the direct notes grouped by `kind` (`plano`,
    `implementacao`, `evidencia`, `nota`, each with `id`, `title`, `path`,
    `kind`, `tags` and `matchedRefs`), then `linked` (each with `id`, `title`,
    `path`, `kind` and `tags`) and `linkedOmitted`. With more than one batch
    the direct notes are merged by id with their `matchedRefs` joined, direct
    notes are dropped from the merged `linked`, `linked` is de-duplicated by id,
    sorted by path and cut to 20, and `linkedOmitted` is the sum of each
    batch's `linkedOmitted` plus what the cut removed. Each batch returns only
    its first 20 linked notes, so across batches that sum is an upper bound,
    not a count; with one batch, the usual case, it is exact.
  - `unavailable`, with `reason`, when the service is configured but gave
    nothing usable. Everything else in the chain is unchanged.

The panel shows the groups as "Planejamento", "Implementação", "Evidências",
"Notas" and "Notas ligadas", and reads "Notas indisponíveis." with the reason
when the part is unavailable.

## The links of an identifier

`GET /api/links/[id]` answers `{ id, snapshot, ticket, beads, unreadable }`
for agents, who know an identifier and not a project. The identifier is
trimmed and answered back as `id`. A blank identifier, one longer than 128
characters, or one holding an ASCII control character answers 400.

- `snapshot`: `available` true, or false with `reason`.
- `ticket`: the identifier itself as a tracker item, in the same three states
  as above, with its links checked the same way. When the snapshot is
  unavailable it is `unconfirmed` with the reason and no approvals. It is
  returned even when no bead carries the identifier.
- `beads`: at most one entry for every bead whose id is the identifier or
  whose reference matches it, both trimmed and compared without regard to
  case, in every project. Each entry carries `projectId`, `projectName` and
  the bead's `chain`, so no second request is needed.
- `unreadable`: every registered project that threw or ran past the
  per-project limit, each with `id`, `name` and `error`, so a missing bead is
  never confused with a project that could not be looked at.
- `notes`: the top-level notes for the identifier itself, in the same two
  states as a chain's `notes` part, so an identifier no bead carries still
  returns its notes. Each bead's `chain` carries its own `notes` part, read
  with the same batching and merge rules; after the first unavailable answer
  the rest of the request makes no further notes call and every remaining part
  reads unavailable with that reason.

One snapshot read serves the whole answer: the ticket lookup and every chain
are resolved against the same bytes, so a rewrite of the file during the
request never splits one answer across two snapshots.
