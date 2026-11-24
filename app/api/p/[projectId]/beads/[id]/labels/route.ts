import { getStore } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { ok, fail } from "@/lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; id: string }> };

// br's own rule, checked here so the answer names the label instead of relaying br's refusal.
const labelSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_:-]+$/, "label may hold only letters, digits, '-', '_' and ':'");

const bodySchema = z
  .strictObject({
    add: z.array(labelSchema).optional().default([]),
    remove: z.array(labelSchema).optional().default([]),
  })
  .refine((b) => b.add.length + b.remove.length > 0, { message: "at least one label to add or remove" })
  .refine((b) => !b.add.some((l) => b.remove.includes(l)), {
    message: "a label cannot be both added and removed",
  });

/** Add and remove single labels on one bead, leaving every other label as the tracker holds it. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { projectId, id } = await params;
    const store = await getStore(projectId);
    const edit = bodySchema.parse(await req.json());
    const bead = await store.editLabels(id, edit, getConfig().humanActor);
    return ok(bead);
  } catch (e) {
    return fail(e);
  }
}
