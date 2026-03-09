import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'

import { LOGS_PATH } from '@/constants'
import { LogHelper } from '@/helpers/log-helper'

interface ToolCallLogEntry {
  toolName: string
  params: Record<string, unknown> | null
}

interface OwnerQueryToolCallRecord {
  ownerQuery: string
  toolCalls: ToolCallLogEntry[]
}

interface ToolCallLoggerSettings {
  loggerName: string
  fileName: string
  nbOfLogsToKeep: number
}

export class ToolCallLogger {
  private readonly settings: ToolCallLoggerSettings
  private readonly toolCallLogPath: string
  private readonly activeQueryStore = new AsyncLocalStorage<string>()
  private readonly pendingRecords = new Map<string, OwnerQueryToolCallRecord>()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(settings: ToolCallLoggerSettings) {
    LogHelper.title(settings.loggerName)
    LogHelper.success('New instance')

    this.settings = settings
    this.toolCallLogPath = path.join(LOGS_PATH, this.settings.fileName)
  }

  private async ensureLogFile(): Promise<void> {
    if (!fs.existsSync(this.toolCallLogPath)) {
      await fs.promises.writeFile(this.toolCallLogPath, '[]', 'utf-8')
    }
  }

  private async loadAll(): Promise<OwnerQueryToolCallRecord[]> {
    await this.ensureLogFile()

    const content = await fs.promises.readFile(this.toolCallLogPath, 'utf-8')
    const parsed = JSON.parse(content)

    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed as OwnerQueryToolCallRecord[]
  }

  private async persistRecord(record: OwnerQueryToolCallRecord): Promise<void> {
    const existingRecords = await this.loadAll()

    existingRecords.push(record)

    const trimmedRecords = existingRecords.slice(
      -this.settings.nbOfLogsToKeep
    )

    await fs.promises.writeFile(
      this.toolCallLogPath,
      JSON.stringify(trimmedRecords, null, 2),
      'utf-8'
    )
  }

  private queuePersist(record: OwnerQueryToolCallRecord): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(() => this.persistRecord(record))
      .catch((error) => {
        LogHelper.title(this.settings.loggerName)
        LogHelper.error(`Failed to persist tool call record: ${error}`)
      })

    return this.writeQueue
  }

  public async runOwnerQuery<T>(
    ownerQuery: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const queryId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    this.pendingRecords.set(queryId, {
      ownerQuery,
      toolCalls: []
    })

    try {
      return await this.activeQueryStore.run(queryId, fn)
    } finally {
      const record = this.pendingRecords.get(queryId)
      this.pendingRecords.delete(queryId)

      if (record) {
        await this.queuePersist(record)
      }
    }
  }

  public recordToolCall(input: {
    toolkitId: string
    toolId: string
    functionName: string
    params: Record<string, unknown> | null
  }): void {
    const queryId = this.activeQueryStore.getStore()
    if (!queryId) {
      return
    }

    const record = this.pendingRecords.get(queryId)
    if (!record) {
      return
    }

    record.toolCalls.push({
      toolName: `${input.toolkitId}.${input.toolId}.${input.functionName}`,
      params: input.params
    })
  }
}
