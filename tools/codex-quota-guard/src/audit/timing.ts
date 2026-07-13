export type AuditEventKind = "quotaThreshold" | "liveCanary"

export interface AuditClock {
  utcNow(): string
  monotonicNow(): number
}

export type AuditPoint =
  | "quotaSnapshotObserved"
  | "thresholdDetected"
  | "activeTurnResolved"
  | "interruptRequested"
  | "interruptAcknowledged"
  | "turnTerminalStateObserved"
  | "goalPauseRequested"
  | "goalPauseAcknowledged"
  | "backgroundTerminalCleaned"

export interface LatencyMetrics {
  snapshotToDetectionMs: number | null
  detectionToInterruptRequestMs: number | null
  interruptRequestToAcknowledgementMs: number | null
  interruptRequestToTerminalStateMs: number | null
}

export interface EventAudit {
  eventKind: AuditEventKind
  quotaSnapshotObservedAt: string | null
  thresholdDetectedAt: string | null
  activeTurnResolvedAt: string | null
  interruptRequestedAt: string | null
  interruptAcknowledgedAt: string | null
  turnTerminalStateObservedAt: string | null
  goalPauseRequestedAt: string | null
  goalPauseAcknowledgedAt: string | null
  backgroundTerminalCleanedAt: string | null
  latencies: LatencyMetrics
}

export type AuditMonotonicPoints = Partial<Record<AuditPoint, number>>

const internalPoints = new WeakMap<EventAudit, AuditMonotonicPoints>()

const timestampFields: Record<AuditPoint, keyof Omit<EventAudit, "eventKind" | "latencies">> = {
  quotaSnapshotObserved: "quotaSnapshotObservedAt",
  thresholdDetected: "thresholdDetectedAt",
  activeTurnResolved: "activeTurnResolvedAt",
  interruptRequested: "interruptRequestedAt",
  interruptAcknowledged: "interruptAcknowledgedAt",
  turnTerminalStateObserved: "turnTerminalStateObservedAt",
  goalPauseRequested: "goalPauseRequestedAt",
  goalPauseAcknowledged: "goalPauseAcknowledgedAt",
  backgroundTerminalCleaned: "backgroundTerminalCleanedAt",
}

export function createAuditRecord(eventKind: AuditEventKind): EventAudit {
  const audit: EventAudit = {
    eventKind,
    quotaSnapshotObservedAt: null,
    thresholdDetectedAt: null,
    activeTurnResolvedAt: null,
    interruptRequestedAt: null,
    interruptAcknowledgedAt: null,
    turnTerminalStateObservedAt: null,
    goalPauseRequestedAt: null,
    goalPauseAcknowledgedAt: null,
    backgroundTerminalCleanedAt: null,
    latencies: emptyLatencies(),
  }
  internalPoints.set(audit, {})
  return audit
}

export function observeAuditPoint(
  audit: EventAudit,
  point: AuditPoint,
  utcTimestamp: string,
  monotonicTimestamp: number,
  points: AuditMonotonicPoints = pointsFor(audit),
): void {
  audit[timestampFields[point]] = utcTimestamp
  points[point] = monotonicTimestamp
  audit.latencies = calculateLatencies(points)
}

export function finalizeLatencies(
  audit: EventAudit,
  points: AuditMonotonicPoints = pointsFor(audit),
): LatencyMetrics {
  audit.latencies = calculateLatencies(points)
  return audit.latencies
}

function pointsFor(audit: EventAudit): AuditMonotonicPoints {
  let points = internalPoints.get(audit)
  if (!points) {
    points = {}
    internalPoints.set(audit, points)
  }
  return points
}

function calculateLatencies(points: AuditMonotonicPoints): LatencyMetrics {
  return {
    snapshotToDetectionMs: difference(
      points.quotaSnapshotObserved,
      points.thresholdDetected,
    ),
    detectionToInterruptRequestMs: difference(
      points.thresholdDetected,
      points.interruptRequested,
    ),
    interruptRequestToAcknowledgementMs: difference(
      points.interruptRequested,
      points.interruptAcknowledged,
    ),
    interruptRequestToTerminalStateMs: difference(
      points.interruptRequested,
      points.turnTerminalStateObserved,
    ),
  }
}

function difference(start: number | undefined, end: number | undefined): number | null {
  if (start === undefined || end === undefined) return null
  return Math.max(0, end - start)
}

function emptyLatencies(): LatencyMetrics {
  return {
    snapshotToDetectionMs: null,
    detectionToInterruptRequestMs: null,
    interruptRequestToAcknowledgementMs: null,
    interruptRequestToTerminalStateMs: null,
  }
}
