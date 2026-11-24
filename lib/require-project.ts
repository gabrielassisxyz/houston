import "server-only";
import { ConfigError, getProject, type DemoProject, type ProjectEntry } from "./config";

/**
 * Look up a project in the app registry (including the demo project) without
 * probing any tracker CLI or filesystem folder. Throws ConfigError
 * (`unknown_project`) when the id is not registered.
 */
export function requireProject(projectId: string): ProjectEntry | DemoProject {
  const project = getProject(projectId);
  if (!project) {
    throw new ConfigError(`Unknown project: ${projectId}`, "unknown_project");
  }
  return project;
}
