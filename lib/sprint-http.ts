import "server-only";
import { NextResponse } from "next/server";
import { fail } from "./api";
import { sprintFailure } from "./sprints";

/**
 * The response for an error raised in a sprint route: a sprint refusal with its own status, a
 * body that is not JSON as bad input, and anything else the way every other route answers it.
 */
export function sprintRouteFailure(err: unknown) {
  const known = sprintFailure(err);
  if (known) return NextResponse.json(known.body, { status: known.status });
  if (err instanceof SyntaxError) {
    return NextResponse.json({ error: "The request body is not valid JSON", code: "invalid_input" }, { status: 400 });
  }
  return fail(err);
}
