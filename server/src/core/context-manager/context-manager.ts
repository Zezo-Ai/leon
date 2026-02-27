import fs from 'node:fs'
import path from 'node:path'

import { CONTEXT_PATH, LEON_DISABLED_CONTEXT_FILES } from '@/constants'
import { TOOLKIT_REGISTRY, LLM_PROVIDER } from '@/core'
import { LogHelper } from '@/helpers/log-helper'
import { ContextFile } from '@/core/context-manager/context-file'
import { ContextProbeHelper } from '@/core/context-manager/context-probe-helper'
import { HomeContextFile } from '@/core/context-manager/files/home-context-file'
import { HostSystemContextFile } from '@/core/context-manager/files/host-system-context-file'
import { GpuComputeContextFile } from '@/core/context-manager/files/gpu-compute-context-file'
import { StorageContextFile } from '@/core/context-manager/files/storage-context-file'
import { SystemResourcesContextFile } from '@/core/context-manager/files/system-resources-context-file'
import { NetworkContextFile } from '@/core/context-manager/files/network-context-file'
import { BrowserHistoryContextFile } from '@/core/context-manager/files/browser-history-context-file'
import { LeonRuntimeContextFile } from '@/core/context-manager/files/leon-runtime-context-file'
import { ActivityContextFile } from '@/core/context-manager/files/activity-context-file'
import { LeonContextFile } from '@/core/context-manager/files/leon-context-file'
import { ArchitectureContextFile } from '@/core/context-manager/files/architecture-context-file'

interface ContextFileMetadata {
  lastGeneratedAt: number
}

const CONTEXT_REFRESH_TTL_MS = 10 * 60 * 1_000

export default class ContextManager {
  private static instance: ContextManager

  private _isLoaded = false
  private manifest = ''
  private refreshIntervalId: NodeJS.Timeout | null = null
  private readonly metadata = new Map<string, ContextFileMetadata>()
  private readonly probeHelper = new ContextProbeHelper()
  private readonly allContextFiles: ContextFile[] = [
    new HomeContextFile(),
    new HostSystemContextFile(this.probeHelper),
    new GpuComputeContextFile(this.probeHelper),
    new StorageContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new SystemResourcesContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new NetworkContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new BrowserHistoryContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new ActivityContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new LeonContextFile(),
    new ArchitectureContextFile(),
    new LeonRuntimeContextFile(this.probeHelper, {
      getAgentLLMName: () => LLM_PROVIDER.agentLLMName,
      getLocalLLMName: () => LLM_PROVIDER.localLLMName
    })
  ]
  private readonly disabledContextFiles = this.parseContextFileList(
    LEON_DISABLED_CONTEXT_FILES
  )
  private readonly contextFiles: ContextFile[] = this.allContextFiles.filter(
    (definition) => !this.disabledContextFiles.has(definition.filename)
  )

  public constructor() {
    if (!ContextManager.instance) {
      LogHelper.title('Context Manager')
      LogHelper.success('New instance')

      ContextManager.instance = this
    }
  }

  public get isLoaded(): boolean {
    return this._isLoaded
  }

  public async load(): Promise<void> {
    if (this._isLoaded) {
      return
    }

    try {
      await fs.promises.mkdir(CONTEXT_PATH, { recursive: true })
      this.cleanupDisabledContextFiles()

      for (const definition of this.contextFiles) {
        this.refreshContextFile(definition, true)
      }

      this.manifest = this.buildManifest()
      this._isLoaded = true
      this.schedulePeriodicRefresh()

      LogHelper.title('Context Manager')
      LogHelper.success(`Loaded ${this.contextFiles.length} context files`)
    } catch (e) {
      LogHelper.title('Context Manager')
      LogHelper.error(`Failed to load context files: ${e}`)
    }
  }

  public getManifest(): string {
    if (!this._isLoaded) {
      return ''
    }

    for (const definition of this.contextFiles) {
      this.refreshContextFile(definition)
    }

    this.manifest = this.buildManifest()
    return this.manifest
  }

  public getContextFileContent(filename: string): string | null {
    if (!this._isLoaded) {
      return null
    }

    const definition = this.resolveDefinition(filename)
    if (!definition) {
      return null
    }

    this.refreshContextFile(definition)

    const filePath = this.getContextFilePath(definition.filename)
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch (e) {
      LogHelper.title('Context Manager')
      LogHelper.error(`Failed to read context file "${definition.filename}": ${e}`)

      return null
    }
  }

  public getContextForToolkit(toolkitId: string): string {
    const contextFiles = this.getContextFilesForToolkit(toolkitId)
    if (contextFiles.length === 0) {
      return ''
    }

    const chunks: string[] = []
    for (const filename of contextFiles) {
      const content = this.getContextFileContent(filename)

      if (!content) {
        continue
      }

      chunks.push(`### ${filename}\n${content.trim()}`)
    }

    return chunks.join('\n\n')
  }

  public getContextFilesForToolkit(toolkitId: string): string[] {
    if (!this._isLoaded || !toolkitId) {
      return []
    }

    const rawContextFiles = TOOLKIT_REGISTRY.getToolkitContextFiles(toolkitId)
    if (!rawContextFiles || rawContextFiles.length === 0) {
      return []
    }

    return [...new Set(rawContextFiles)]
      .map((filename) => this.normalizeFilename(filename))
      .filter(
        (filename) => filename.length > 0 && this.resolveDefinition(filename) !== null
      )
  }

  private getContextFilePath(filename: string): string {
    return path.join(CONTEXT_PATH, filename)
  }

  private normalizeFilename(filename: string): string {
    const trimmedFilename = filename.trim()

    if (!trimmedFilename) {
      return ''
    }

    const fileBasename = path.basename(trimmedFilename, '.md').toUpperCase()
    return `${fileBasename}.md`
  }

  private resolveDefinition(filename: string): ContextFile | null {
    const normalized = this.normalizeFilename(filename)

    if (!normalized) {
      return null
    }

    return (
      this.contextFiles.find((definition) => definition.filename === normalized) ||
      null
    )
  }

  private isContextFileStale(definition: ContextFile): boolean {
    const filePath = this.getContextFilePath(definition.filename)

    if (!fs.existsSync(filePath)) {
      return true
    }

    const fileMetadata = this.metadata.get(definition.filename)
    if (!fileMetadata) {
      return true
    }

    const effectiveTtlMs = definition.ttlMs ?? CONTEXT_REFRESH_TTL_MS

    return Date.now() - fileMetadata.lastGeneratedAt >= effectiveTtlMs
  }

  private refreshContextFile(definition: ContextFile, force = false): void {
    if (!force && !this.isContextFileStale(definition)) {
      return
    }

    const filePath = this.getContextFilePath(definition.filename)
    const content = this.ensureTrailingNewline(definition.generate())

    fs.mkdirSync(CONTEXT_PATH, { recursive: true })
    fs.writeFileSync(filePath, content, 'utf-8')
    this.metadata.set(definition.filename, {
      lastGeneratedAt: Date.now()
    })
  }

  private ensureTrailingNewline(content: string): string {
    if (content.endsWith('\n')) {
      return content
    }

    return `${content}\n`
  }

  private extractSummary(content: string): string | null {
    const firstNonEmptyLine = content
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)

    if (!firstNonEmptyLine || !firstNonEmptyLine.startsWith('>')) {
      return null
    }

    return firstNonEmptyLine.slice(1).trim()
  }

  private buildManifest(): string {
    const summaryLines: string[] = []

    for (const definition of this.contextFiles) {
      const filePath = this.getContextFilePath(definition.filename)
      if (!fs.existsSync(filePath)) {
        continue
      }

      const content = fs.readFileSync(filePath, 'utf-8')
      const summary = this.extractSummary(content)
      if (!summary) {
        continue
      }

      const contextName = definition.filename.replace('.md', '')
      summaryLines.push(`- ${contextName}: ${summary}`)
    }

    return summaryLines.join('\n')
  }

  private schedulePeriodicRefresh(): void {
    if (this.refreshIntervalId) {
      return
    }

    this.refreshIntervalId = setInterval(
      () => {
        for (const definition of this.contextFiles) {
          this.refreshContextFile(definition)
        }

        this.manifest = this.buildManifest()
      },
      CONTEXT_REFRESH_TTL_MS
    )

    if (typeof this.refreshIntervalId.unref === 'function') {
      this.refreshIntervalId.unref()
    }
  }

  private parseContextFileList(rawFileList: string): Set<string> {
    return new Set(
      rawFileList
        .split(/[,;\n]/)
        .map((value) => this.normalizeFilename(value))
        .filter((value) => value.length > 0)
    )
  }

  private cleanupDisabledContextFiles(): void {
    for (const filename of this.disabledContextFiles) {
      const filePath = this.getContextFilePath(filename)
      this.metadata.delete(filename)

      if (!fs.existsSync(filePath)) {
        continue
      }

      try {
        fs.rmSync(filePath, { force: true })
      } catch {
        continue
      }
    }
  }
}
