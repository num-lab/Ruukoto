export class DesktopBuildError extends Error {
  code: "desktop_build_invalid";
}
export function checkBuild(outDir?: string): void;
