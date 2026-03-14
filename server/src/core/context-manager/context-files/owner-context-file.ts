import fs from 'node:fs'

import { ContextFile } from '@/core/context-manager/context-file'
import {
  buildOwnerDocument,
  OWNER_CONTEXT_PATH,
  readOwnerProfileSync
} from '@/core/context-manager/owner-profile'

export const OWNER_CONTEXT_TTL_MS: number | null = null

export class OwnerContextFile extends ContextFile {
  public readonly filename = 'OWNER.md'
  public readonly ttlMs: number | null

  public constructor(ttlMs: number | null) {
    super()
    this.ttlMs = ttlMs
  }

  public generate(): string {
    if (fs.existsSync(OWNER_CONTEXT_PATH)) {
      try {
        return fs.readFileSync(OWNER_CONTEXT_PATH, 'utf8').trimEnd()
      } catch {
        // Fall back to the derived skeleton below.
      }
    }

    return buildOwnerDocument(readOwnerProfileSync())
  }
}
