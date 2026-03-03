import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONTEXT_PATH, LEON_DISABLED_CONTEXT_FILES } from '@/constants'
import { TOOLKIT_REGISTRY, LLM_PROVIDER } from '@/core'
import { LogHelper } from '@/helpers/log-helper'
import { ContextFile } from '@/core/context-manager/context-file'
import { ContextProbeHelper } from '@/core/context-manager/context-probe-helper'
import { HomeContextFile } from '@/core/context-manager/context-files/home-context-file'
import { HostSystemContextFile } from '@/core/context-manager/context-files/host-system-context-file'
import { GpuComputeContextFile } from '@/core/context-manager/context-files/gpu-compute-context-file'
import { StorageContextFile } from '@/core/context-manager/context-files/storage-context-file'
import { SystemResourcesContextFile } from '@/core/context-manager/context-files/system-resources-context-file'
import { BrowserHistoryContextFile } from '@/core/context-manager/context-files/browser-history-context-file'
import { LeonRuntimeContextFile } from '@/core/context-manager/context-files/leon-runtime-context-file'
import { ActivityContextFile } from '@/core/context-manager/context-files/activity-context-file'
import { LocalInventoryContextFile } from '@/core/context-manager/context-files/local-inventory-context-file'
import { NetworkEcosystemContextFile } from '@/core/context-manager/context-files/network-ecosystem-context-file'
import { WorkspaceIntelligenceContextFile } from '@/core/context-manager/context-files/workspace-intelligence-context-file'
import { HabitsContextFile } from '@/core/context-manager/context-files/habits-context-file'
import { MediaProfileContextFile } from '@/core/context-manager/context-files/media-profile-context-file'
import { LeonContextFile } from '@/core/context-manager/context-files/leon-context-file'
import { ArchitectureContextFile } from '@/core/context-manager/context-files/architecture-context-file'

interface ContextFileMetadata {
  lastGeneratedAt: number
}

const CONTEXT_REFRESH_TTL_MS = 10 * 60 * 1_000
const CONTEXT_FILES_SOURCE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'context-files'
)
const SOURCE_AWARE_STATIC_CONTEXT_FILES = new Set([
  'LEON.md',
  'ARCHITECTURE.md'
])
const RETIRED_CONTEXT_FILES = [
  'LOCAL_ECOSYSTEM.md',
  'NETWORK.md',
  'AUTOMATION_OPPORTUNITIES.md',
  'MEDIA_TASTES.md'
]
const RETIRED_STATE_FILES = ['.media-tastes-state.json']

export default class ContextManager {
  private static instance: ContextManager

  private _isLoaded = false
  private manifest = ''
  private refreshIntervalId: NodeJS.Timeout | null = null
  private isBootRefreshInProgress = false
  private readonly metadata = new Map<string, ContextFileMetadata>()
  private readonly probeHelper = new ContextProbeHelper()
  private readonly allContextFiles: ContextFile[] = [
    new HomeContextFile(CONTEXT_REFRESH_TTL_MS),
    new HostSystemContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new GpuComputeContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new StorageContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new SystemResourcesContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new BrowserHistoryContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new ActivityContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new LocalInventoryContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new NetworkEcosystemContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new WorkspaceIntelligenceContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new HabitsContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new MediaProfileContextFile(this.probeHelper, CONTEXT_REFRESH_TTL_MS),
    new LeonContextFile(),
    new ArchitectureContextFile(),
    new LeonRuntimeContextFile(this.probeHelper, {
      getAgentLLMName: () => LLM_PROVIDER.agentLLMName,
      getLocalLLMName: () => LLM_PROVIDER.localLLMName
    }, CONTEXT_REFRESH_TTL_MS)
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
      this.cleanupRetiredContextFiles()
      this.refreshContextFilesAtBootInBackground()

      await this.syncContextReadFilenameEnum()

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

  private refreshContextFilesAtBootInBackground(): void {
    if (this.isBootRefreshInProgress) {
      return
    }

    this.isBootRefreshInProgress = true

    setImmediate(() => {
      try {
        // Keep startup fast while still regenerating context files at boot.
        for (const definition of this.contextFiles) {
          this.refreshContextFile(definition, true)
        }

        this.manifest = this.buildManifest()
      } finally {
        this.isBootRefreshInProgress = false
      }
    })
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

    let generatedFileMtimeMs = 0
    try {
      generatedFileMtimeMs = fs.statSync(filePath).mtimeMs
    } catch {
      return true
    }

    if (SOURCE_AWARE_STATIC_CONTEXT_FILES.has(definition.filename)) {
      const sourceUpdatedAt = this.getContextSourceUpdatedAt(definition)
      if (
        typeof sourceUpdatedAt === 'number' &&
        sourceUpdatedAt > generatedFileMtimeMs
      ) {
        return true
      }
    }

    if (definition.ttlMs === null) {
      return false
    }

    const fileMetadata = this.metadata.get(definition.filename)
    let lastGeneratedAt = fileMetadata?.lastGeneratedAt

    if (!lastGeneratedAt) {
      lastGeneratedAt = generatedFileMtimeMs
      this.metadata.set(definition.filename, {
        lastGeneratedAt
      })
    }

    const effectiveTtlMs = definition.ttlMs

    return Date.now() - lastGeneratedAt >= effectiveTtlMs
  }

  private getContextSourceUpdatedAt(definition: ContextFile): number | null {
    const sourceFilePath = this.resolveContextSourcePath(definition)
    if (!sourceFilePath) {
      return null
    }

    try {
      return fs.statSync(sourceFilePath).mtimeMs
    } catch {
      return null
    }
  }

  private resolveContextSourcePath(definition: ContextFile): string | null {
    const sourceBasename = this.getContextSourceBasename(definition.filename)
    const tsPath = path.join(CONTEXT_FILES_SOURCE_DIR, `${sourceBasename}.ts`)
    if (fs.existsSync(tsPath)) {
      return tsPath
    }

    const jsPath = path.join(CONTEXT_FILES_SOURCE_DIR, `${sourceBasename}.js`)
    if (fs.existsSync(jsPath)) {
      return jsPath
    }

    return null
  }

  private getContextSourceBasename(filename: string): string {
    return `${path.basename(filename, '.md').toLowerCase().replaceAll('_', '-')}-context-file`
  }

  private async syncContextReadFilenameEnum(): Promise<void> {
    try {
      if (!TOOLKIT_REGISTRY.isLoaded) {
        await TOOLKIT_REGISTRY.load()
      }

      const filenames = this.contextFiles
        .map((definition) => definition.filename)
        .sort((a, b) => a.localeCompare(b))

      const isUpdated = TOOLKIT_REGISTRY.setFunctionParameterEnum(
        'structured_knowledge',
        'context',
        'readContextFile',
        'filename',
        filenames
      )

      if (isUpdated) {
        LogHelper.title('Context Manager')
        LogHelper.info(
          `Synced readContextFile.filename enum with ${filenames.length} context file(s)`
        )
      }
    } catch (error) {
      LogHelper.title('Context Manager')
      LogHelper.warning(
        `Failed to sync readContextFile.filename enum: ${String(error)}`
      )
    }
  }

  private refreshContextFile(definition: ContextFile, force = false): void {
    if (!force && !this.isContextFileStale(definition)) {
      return
    }

    const filePath = this.getContextFilePath(definition.filename)
    try {
      const content = this.ensureTrailingNewline(definition.generate())

      fs.mkdirSync(CONTEXT_PATH, { recursive: true })
      fs.writeFileSync(filePath, content, 'utf-8')
      this.metadata.set(definition.filename, {
        lastGeneratedAt: Date.now()
      })
    } catch (e) {
      LogHelper.title('Context Manager')
      LogHelper.error(
        `Failed to refresh context file "${definition.filename}": ${String(e)}`
      )
    }
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

      summaryLines.push(`- ${definition.filename}: ${summary}`)
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

  private cleanupRetiredContextFiles(): void {
    for (const filename of RETIRED_CONTEXT_FILES) {
      const filePath = this.getContextFilePath(filename)

      if (!fs.existsSync(filePath)) {
        continue
      }

      try {
        fs.rmSync(filePath, { force: true })
      } catch {
        continue
      }
    }

    for (const filename of RETIRED_STATE_FILES) {
      const filePath = this.getContextFilePath(filename)

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
