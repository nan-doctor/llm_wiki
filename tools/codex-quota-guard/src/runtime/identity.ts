import type { CapabilityMatrix } from "./capabilities.js"
import type {
  RuntimeChange,
  RuntimeContext,
  RuntimeIdentity,
  RuntimeIdentityField,
} from "./types.js"

const IDENTITY_FIELDS: RuntimeIdentityField[] = [
  "codexExecutable",
  "codexExecutableRealPath",
  "codexVersion",
  "protocolFingerprint",
]

export function runtimeIdentityFromContext(context: RuntimeContext): RuntimeIdentity {
  const realPath = context.executable.codexExecutableRealPath
  const version = context.executable.codexVersion
  const fingerprint = context.protocolFingerprint
  if (!context.executable.launchAllowed || !realPath || !version || !fingerprint) {
    throw new Error("当前 RuntimeContext 缺少可持久化的 Codex 运行身份")
  }
  return {
    codexExecutable: context.executable.codexExecutable,
    codexExecutableRealPath: realPath,
    codexVersion: version,
    protocolFingerprint: fingerprint,
  }
}

export function compareRuntimeIdentity(
  previous: RuntimeIdentity | null,
  current: RuntimeIdentity,
): RuntimeChange[] {
  if (!previous) return []
  return IDENTITY_FIELDS.flatMap((field) => previous[field] === current[field]
    ? []
    : [{ field, previous: previous[field], current: current[field] }])
}

export function invalidateRuntimeEvidence(
  matrix: CapabilityMatrix,
  changed: boolean,
): CapabilityMatrix {
  const result = structuredClone(matrix)
  if (!changed) return result
  for (const evidence of Object.values(result)) {
    evidence.runtimeVerified = null
    evidence.status = evidence.schemaDetected ? "schemaDetected" : "unavailable"
    evidence.detail = "Codex 运行身份已变化，需要重新验证"
  }
  return result
}
