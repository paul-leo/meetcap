/**
 * Pure manifest helpers — the bookkeeping for a logical recording that may span
 * multiple segments (e.g. a crash + resume). No fs/electron here so it can be
 * unit-tested directly; the IPC layer in index.ts does the actual file IO.
 */
import type { MeetingInfo, RecordingManifest } from 'meetcap-core'

export function createManifest(args: {
  key: string
  meeting: MeetingInfo | null
  mimeType: string
  createdAt: number
}): RecordingManifest {
  return {
    key: args.key,
    meeting: args.meeting,
    mimeType: args.mimeType,
    createdAt: args.createdAt,
    status: 'active',
    segments: [],
  }
}

/** Append a new (active) segment; returns its index. */
export function addSegment(manifest: RecordingManifest, file: string, startedAt: number): number {
  manifest.segments.push({ file, startedAt, status: 'active' })
  manifest.status = 'active'
  return manifest.segments.length - 1
}

/** Mark a segment closed with its duration. */
export function closeSegment(manifest: RecordingManifest, index: number, durationMs: number): void {
  const seg = manifest.segments[index]
  if (seg) {
    seg.status = 'closed'
    seg.durationMs = durationMs
  }
}

/** Finalize the logical recording (normal stop / meeting ended). */
export function finalizeManifest(manifest: RecordingManifest): void {
  manifest.status = 'finalized'
}

/** A manifest is interrupted if it was never finalized (process died mid-capture). */
export function isInterrupted(manifest: RecordingManifest): boolean {
  return manifest.status === 'active'
}
