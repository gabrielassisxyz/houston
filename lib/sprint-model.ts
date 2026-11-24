// The sprint model, shared by the server store and the browser: types, validation and the
// label and point helpers. No `server-only` import on purpose.
import { z } from "zod";

export type Size = "S" | "M" | "L" | "XL";
export type SprintState = "planned" | "active" | "closing" | "closed";

/** One bead as a sprint remembers it. `id` is the bead's id in its own tracker. */
export type BeadRef = {
  projectId: string;
  projectName: string;
  id: string;
  title: string;
  size: Size | null;
  points: number;
};

export type SprintSummary = {
  plannedCount: number;
  plannedPoints: number;
  done: BeadRef[];
  spillover: BeadRef[];
  added: BeadRef[];
  removed: BeadRef[];
  unreadable: string[];
};

export type Sprint = {
  id: string;
  name: string;
  start: string;
  end: string;
  capacity: number;
  state: SprintState;
  createdAt: string;
  startedAt: string | null;
  closedAt: string | null;
  planned: BeadRef[] | null;
  unreadableAtStart: string[];
  summary: SprintSummary | null;
  pending: BeadRef[];
};

export const SIZE_POINTS: Record<Size, number> = { S: 1, M: 2, L: 3, XL: 5 };

const SPRINT_PREFIX = "sprint:";
const SIZE_PREFIX = "size:";

export function sprintLabel(id: string): string {
  return `${SPRINT_PREFIX}${id}`;
}

export function sprintIdsOf(labels: readonly string[]): string[] {
  return labels.filter((l) => l.startsWith(SPRINT_PREFIX)).map((l) => l.slice(SPRINT_PREFIX.length));
}

/** The board of every project narrowed to one sprint, with its closed beads shown too. */
export function sprintBoardHref(id: string): string {
  const params = new URLSearchParams();
  params.append("label", sprintLabel(id));
  params.append("done", "all");
  return `/all?${params.toString()}`;
}

/**
 * The sprint a label filter narrows a page to: one label, and it is a sprint's. With a second
 * label beside it the page shows more than that sprint, so it is no sprint view.
 */
export function sprintIdOfFilter(labels: readonly string[]): string | null {
  if (labels.length !== 1) return null;
  return sprintIdsOf(labels)[0] ?? null;
}

export function sizeOf(labels: readonly string[]): Size | null {
  for (const label of labels) {
    if (!label.startsWith(SIZE_PREFIX)) continue;
    const size = label.slice(SIZE_PREFIX.length);
    if (Object.prototype.hasOwnProperty.call(SIZE_POINTS, size)) return size as Size;
  }
  return null;
}

export function pointsOf(labels: readonly string[]): number {
  const size = sizeOf(labels);
  return size ? SIZE_POINTS[size] : 0;
}

// A calendar date that exists: `2026-02-30` matches the shape and is still not a day.
function isRealDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date written YYYY-MM-DD")
  .refine(isRealDate, "must be a real calendar date");
const nameSchema = z.string().trim().min(1).max(80);
const capacitySchema = z.number().int().min(0).max(9999);

export const sizeSchema = z.enum(["S", "M", "L", "XL"]);

export const beadRefSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  id: z.string(),
  title: z.string(),
  size: sizeSchema.nullable(),
  points: z.number(),
});

export const sprintSummarySchema = z.object({
  plannedCount: z.number(),
  plannedPoints: z.number(),
  done: z.array(beadRefSchema),
  spillover: z.array(beadRefSchema),
  added: z.array(beadRefSchema),
  removed: z.array(beadRefSchema),
  unreadable: z.array(z.string()),
});

export const sprintSchema = z.object({
  id: dateSchema,
  name: nameSchema,
  start: dateSchema,
  end: dateSchema,
  capacity: capacitySchema,
  state: z.enum(["planned", "active", "closing", "closed"]),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  planned: z.array(beadRefSchema).nullable(),
  unreadableAtStart: z.array(z.string()),
  summary: sprintSummarySchema.nullable(),
  pending: z.array(beadRefSchema),
});

export const sprintsFileSchema = z.object({
  version: z.literal(1),
  sprints: z.array(sprintSchema),
});

export const createSprintSchema = z
  .strictObject({ name: nameSchema, start: dateSchema, end: dateSchema, capacity: capacitySchema })
  .superRefine((value, ctx) => {
    if (value.end < value.start) {
      ctx.addIssue({ code: "custom", path: ["end"], message: "must be on or after start" });
    }
  });

export const patchSprintSchema = z
  .strictObject({ name: nameSchema.optional(), end: dateSchema.optional(), capacity: capacitySchema.optional() })
  .refine((value) => Object.keys(value).length > 0, "at least one of name, end or capacity is required");

export type CreateSprintInput = z.infer<typeof createSprintSchema>;
export type PatchSprintInput = z.infer<typeof patchSprintSchema>;
