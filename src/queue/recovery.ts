import type { Database } from 'bun:sqlite'

import type { PendingUrlsRepository } from '../db/repositories/pending-urls.repo.ts'
import type { SubmissionBatchesRepository } from '../db/repositories/batches.repo.ts'

export interface RecoveryResult {
  clearedLeases: number
  closedBatches: number
}

/**
 * Crash recovery. On boot, every lease and in-flight batch belongs to a dead
 * process: release the URLs and close the audit rows so work resumes cleanly.
 */
export function recoverFromCrash(db: Database, pendingUrls: PendingUrlsRepository, batches: SubmissionBatchesRepository): RecoveryResult {
  const now = Date.now()
  return db.transaction(() => {
    const clearedLeases = pendingUrls.clearAllLeases()
    const closedBatches = batches.closeDanglingInFlight(now)
    return { clearedLeases, closedBatches }
  })()
}
