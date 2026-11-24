export const APP_TITLE = "Houston";

export function projectTitle(projectName: string): string {
  const prefix = projectName.trim();
  return prefix ? `${prefix} | ${APP_TITLE}` : APP_TITLE;
}
