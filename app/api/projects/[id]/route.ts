import { removeProject, updateProject } from "@/lib/config";
import { resetStore } from "@/lib/store";
import { ok, fail } from "@/lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    removeProject(id);
    resetStore(id);
    return ok({ removed: id });
  } catch (e) {
    return fail(e);
  }
}

const patchSchema = z
  .object({ name: z.string().trim().min(1).optional(), pipelineRepo: z.string().optional() })
  .refine((v) => v.name !== undefined || v.pipelineRepo !== undefined, {
    message: "Invalid input",
  });

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const patch = patchSchema.parse(await req.json());
    const entry = updateProject(id, patch);
    if (!entry) return ok({ error: "not found" }, 404);
    return ok(entry);
  } catch (e) {
    return fail(e);
  }
}
