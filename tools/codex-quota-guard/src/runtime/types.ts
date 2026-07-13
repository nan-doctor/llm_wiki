export type ExecutableSelectionSource =
  | "cli"
  | "environment"
  | "config"
  | "path"
  | "discoveredCandidate"

export type ExecutableValidationStage =
  | "selection"
  | "stat"
  | "executable"
  | "version"
  | "app-server-help"

export interface ResolvedCodexExecutable {
  codexExecutable: string
  codexExecutableRealPath: string | null
  codexVersion: string | null
  executableSelectionSource: ExecutableSelectionSource
  launchAllowed: boolean
  discoveredCandidates: string[]
}
