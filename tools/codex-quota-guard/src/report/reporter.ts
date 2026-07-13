import type { PersistedGuardState } from "../guard/state-machine.js"

export interface ThresholdReporter {
  write(state: PersistedGuardState): Promise<void>
}
