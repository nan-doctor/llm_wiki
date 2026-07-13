import type { PersistedGuardState } from "../guard/state-machine.js"

export interface GuardStateRepository {
  load(): Promise<PersistedGuardState | null>
  save(state: PersistedGuardState): Promise<void>
}
