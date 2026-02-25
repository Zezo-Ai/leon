import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  CONTEXT_PATH,
  GLOBAL_DATA_PATH,
  LEON_VERSION,
  LLM_NAME,
  LLM_PROVIDER,
  LLM_VERSION,
  LOGS_PATH,
  MODELS_PATH,
  NODEJS_BRIDGE_VERSION,
  NVIDIA_CUBLAS_PATH,
  NVIDIA_CUBLAS_VERSION,
  NVIDIA_CUDA_VERSION,
  NVIDIA_CUDNN_PATH,
  NVIDIA_CUDNN_VERSION,
  NVIDIA_CUSPARSE_FULL_PATH,
  NVIDIA_CUSPARSE_FULL_VERSION,
  NVIDIA_CUSPARSE_PATH,
  NVIDIA_CUSPARSE_VERSION,
  NVIDIA_LIBS_PATH,
  NVIDIA_NCCL_PATH,
  NVIDIA_NCCL_VERSION,
  NVIDIA_NVJITLINK_PATH,
  NVIDIA_NVJITLINK_VERSION,
  NVIDIA_NVSHMEM_PATH,
  NVIDIA_NVSHMEM_VERSION,
  PYTHON_BRIDGE_VERSION,
  PYTHON_TCP_SERVER_VERSION,
  PYTORCH_PATH,
  PYTORCH_TORCH_PATH,
  PYTORCH_VERSION,
  SERVER_CORE_PATH,
  SKILLS_PATH,
  TMP_PATH,
  TOOLKITS_PATH
} from '@/constants'
import { TOOLKIT_REGISTRY } from '@/core'
import { LogHelper } from '@/helpers/log-helper'

interface ContextFileDefinition {
  filename: string
  ttlMs: number | null
  generator: () => string
}

interface ContextFileMetadata {
  lastGeneratedAt: number
}

const DYNAMIC_CONTEXT_TTL_MS = 30 * 60 * 1_000

export default class ContextManager {
  private static instance: ContextManager
  private _isLoaded = false
  private manifest = ''
  private readonly metadata = new Map<string, ContextFileMetadata>()

  private readonly contextFiles: ContextFileDefinition[] = [
    {
      filename: 'HOME.md',
      ttlMs: null,
      generator: this.generateHome.bind(this)
    },
    {
      filename: 'HOST_SYSTEM.md',
      ttlMs: null,
      generator: this.generateHostSystem.bind(this)
    },
    {
      filename: 'GPU_COMPUTE.md',
      ttlMs: null,
      generator: this.generateGpuCompute.bind(this)
    },
    {
      filename: 'STORAGE.md',
      ttlMs: DYNAMIC_CONTEXT_TTL_MS,
      generator: this.generateStorage.bind(this)
    },
    {
      filename: 'NETWORK.md',
      ttlMs: DYNAMIC_CONTEXT_TTL_MS,
      generator: this.generateNetwork.bind(this)
    },
    {
      filename: 'LEON_RUNTIME.md',
      ttlMs: null,
      generator: this.generateLeonRuntime.bind(this)
    }
  ]

  constructor() {
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

      for (const definition of this.contextFiles) {
        this.refreshContextFile(definition, true)
      }

      this.manifest = this.buildManifest()
      this._isLoaded = true

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
      .filter((filename) => filename.length > 0)
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

  private resolveDefinition(filename: string): ContextFileDefinition | null {
    const normalized = this.normalizeFilename(filename)

    if (!normalized) {
      return null
    }

    return (
      this.contextFiles.find((definition) => definition.filename === normalized) ||
      null
    )
  }

  private isContextFileStale(definition: ContextFileDefinition): boolean {
    const filePath = this.getContextFilePath(definition.filename)

    if (!fs.existsSync(filePath)) {
      return true
    }

    if (definition.ttlMs === null) {
      return false
    }

    const fileMetadata = this.metadata.get(definition.filename)
    if (!fileMetadata) {
      return true
    }

    return Date.now() - fileMetadata.lastGeneratedAt >= definition.ttlMs
  }

  private refreshContextFile(
    definition: ContextFileDefinition,
    force = false
  ): void {
    if (!force && !this.isContextFileStale(definition)) {
      return
    }

    const filePath = this.getContextFilePath(definition.filename)
    const content = this.ensureTrailingNewline(definition.generator())

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

  private generateHome(): string {
    const projectRoot = process.cwd()
    const serverSourcePath = path.join(projectRoot, 'server', 'src')

    return [
      `> Leon workspace rooted at ${projectRoot}. Key folders for skills, toolkits, models, logs and runtime temp are available.`,
      '# HOME',
      `- Project root: ${projectRoot}`,
      `- Skills path: ${SKILLS_PATH}`,
      `- Toolkits path: ${TOOLKITS_PATH}`,
      `- Global data path: ${GLOBAL_DATA_PATH}`,
      `- Models path: ${MODELS_PATH}`,
      `- Context path: ${CONTEXT_PATH}`,
      `- Server source path: ${serverSourcePath}`,
      `- Server core runtime path: ${SERVER_CORE_PATH}`,
      `- Logs path: ${LOGS_PATH}`,
      `- Temp path: ${TMP_PATH}`
    ].join('\n')
  }

  private generateHostSystem(): string {
    const username = this.getSafeUsername()
    const shell =
      process.env['SHELL'] ||
      process.env['COMSPEC'] ||
      process.env['ComSpec'] ||
      'unknown'

    return [
      `> Host system is ${os.platform()} ${os.release()} (${os.arch()}), user ${username}, shell ${shell}.`,
      '# HOST_SYSTEM',
      `- Platform: ${os.platform()}`,
      `- OS type: ${os.type()}`,
      `- OS release: ${os.release()}`,
      `- Architecture: ${os.arch()}`,
      `- Hostname: ${os.hostname()}`,
      `- Username: ${username}`,
      `- Home directory: ${os.homedir()}`,
      `- Shell: ${shell}`,
      `- Temporary directory: ${os.tmpdir()}`
    ].join('\n')
  }

  private generateGpuCompute(): string {
    const gpuProbe = this.probeNvidiaSmi()
    const hasTorchPath = fs.existsSync(PYTORCH_PATH)
    const hasTorchRuntimePath = fs.existsSync(PYTORCH_TORCH_PATH)
    const hasNvidiaLibsPath = fs.existsSync(NVIDIA_LIBS_PATH)

    const summary =
      gpuProbe.gpus.length > 0
        ? `GPU context detected ${gpuProbe.gpus.length} NVIDIA GPU(s), CUDA ${NVIDIA_CUDA_VERSION}, PyTorch ${PYTORCH_VERSION}.`
        : `GPU context has no NVIDIA GPU detected by nvidia-smi, CUDA ${NVIDIA_CUDA_VERSION}, PyTorch ${PYTORCH_VERSION}.`

    const gpuLines =
      gpuProbe.gpus.length > 0
        ? gpuProbe.gpus.map(
            (gpu, index) =>
              `- GPU ${index + 1}: ${gpu.name} | VRAM: ${gpu.memoryMb} MB | Driver: ${gpu.driverVersion}`
          )
        : ['- GPU list: none detected']

    return [
      `> ${summary}`,
      '# GPU_COMPUTE',
      `- Probe status: ${gpuProbe.status}`,
      ...gpuLines,
      `- CUDA version: ${NVIDIA_CUDA_VERSION}`,
      `- cuDNN version: ${NVIDIA_CUDNN_VERSION}`,
      `- cuBLAS version: ${NVIDIA_CUBLAS_VERSION}`,
      `- cuSPARSE version: ${NVIDIA_CUSPARSE_VERSION}`,
      `- cuSPARSE full version: ${NVIDIA_CUSPARSE_FULL_VERSION}`,
      `- NCCL version: ${NVIDIA_NCCL_VERSION}`,
      `- NVSHMEM version: ${NVIDIA_NVSHMEM_VERSION}`,
      `- NVJITLINK version: ${NVIDIA_NVJITLINK_VERSION}`,
      `- NVIDIA libs path: ${NVIDIA_LIBS_PATH} (${hasNvidiaLibsPath ? 'exists' : 'missing'})`,
      `- NVIDIA cuBLAS path: ${NVIDIA_CUBLAS_PATH} (${fs.existsSync(NVIDIA_CUBLAS_PATH) ? 'exists' : 'missing'})`,
      `- NVIDIA cuDNN path: ${NVIDIA_CUDNN_PATH} (${fs.existsSync(NVIDIA_CUDNN_PATH) ? 'exists' : 'missing'})`,
      `- NVIDIA cuSPARSE path: ${NVIDIA_CUSPARSE_PATH} (${fs.existsSync(NVIDIA_CUSPARSE_PATH) ? 'exists' : 'missing'})`,
      `- NVIDIA cuSPARSE full path: ${NVIDIA_CUSPARSE_FULL_PATH} (${fs.existsSync(NVIDIA_CUSPARSE_FULL_PATH) ? 'exists' : 'missing'})`,
      `- NVIDIA NCCL path: ${NVIDIA_NCCL_PATH} (${fs.existsSync(NVIDIA_NCCL_PATH) ? 'exists' : 'missing'})`,
      `- NVIDIA NVSHMEM path: ${NVIDIA_NVSHMEM_PATH} (${fs.existsSync(NVIDIA_NVSHMEM_PATH) ? 'exists' : 'missing'})`,
      `- NVIDIA NVJITLINK path: ${NVIDIA_NVJITLINK_PATH} (${fs.existsSync(NVIDIA_NVJITLINK_PATH) ? 'exists' : 'missing'})`,
      `- PyTorch version: ${PYTORCH_VERSION}`,
      `- PyTorch path: ${PYTORCH_PATH} (${hasTorchPath ? 'exists' : 'missing'})`,
      `- PyTorch torch path: ${PYTORCH_TORCH_PATH} (${hasTorchRuntimePath ? 'exists' : 'missing'})`
    ].join('\n')
  }

  private generateStorage(): string {
    const probeResult = this.probeStorage()
    const generatedAt = new Date().toISOString()

    const summary = probeResult.summary || 'Storage snapshot unavailable.'
    const entries =
      probeResult.entries.length > 0
        ? probeResult.entries.map(
            (entry) =>
              `- ${entry.filesystem}: total ${entry.size}, used ${entry.used}, free ${entry.available}, usage ${entry.usedPct}, mount ${entry.mountPoint}`
          )
        : ['- No storage entries collected']

    return [
      `> ${summary}`,
      '# STORAGE',
      `- Generated at: ${generatedAt}`,
      `- Source: ${probeResult.source}`,
      ...entries
    ].join('\n')
  }

  private generateNetwork(): string {
    const interfaces = os.networkInterfaces()
    const networkLines: string[] = []

    for (const [interfaceName, addresses] of Object.entries(interfaces)) {
      if (!addresses || addresses.length === 0) {
        continue
      }

      for (const address of addresses) {
        if (address.internal) {
          continue
        }

        networkLines.push(
          `- ${interfaceName} (${address.family}): ${address.address}`
        )
      }
    }

    const proxyEnv = {
      http: this.redactProxyValue(
        process.env['HTTP_PROXY'] || process.env['http_proxy'] || 'unset'
      ),
      https: this.redactProxyValue(
        process.env['HTTPS_PROXY'] || process.env['https_proxy'] || 'unset'
      ),
      noProxy: this.redactProxyValue(
        process.env['NO_PROXY'] || process.env['no_proxy'] || 'unset'
      )
    }

    const summary = `Network context has ${networkLines.length} non-internal IP address(es) and ${proxyEnv.http === 'unset' && proxyEnv.https === 'unset' ? 'no proxy configuration' : 'proxy configuration present'}.`

    return [
      `> ${summary}`,
      '# NETWORK',
      ...(
        networkLines.length > 0
          ? networkLines
          : ['- No non-internal network interfaces detected']
      ),
      `- HTTP proxy: ${proxyEnv.http}`,
      `- HTTPS proxy: ${proxyEnv.https}`,
      `- NO_PROXY: ${proxyEnv.noProxy}`
    ].join('\n')
  }

  private generateLeonRuntime(): string {
    return [
      `> Leon runtime ${LEON_VERSION || 'unknown'} on Node ${process.version} using provider ${LLM_PROVIDER || 'unset'} and model ${LLM_NAME} (${LLM_VERSION}).`,
      '# LEON_RUNTIME',
      `- Leon version: ${LEON_VERSION || 'unknown'}`,
      `- Node.js version: ${process.version}`,
      `- LLM provider: ${LLM_PROVIDER || 'unset'}`,
      `- LLM model: ${LLM_NAME} (${LLM_VERSION})`,
      `- Node.js bridge version: ${NODEJS_BRIDGE_VERSION}`,
      `- Python bridge version: ${PYTHON_BRIDGE_VERSION}`,
      `- Python TCP server version: ${PYTHON_TCP_SERVER_VERSION}`
    ].join('\n')
  }

  private getSafeUsername(): string {
    try {
      return os.userInfo().username
    } catch {
      return process.env['USER'] || process.env['USERNAME'] || 'unknown'
    }
  }

  private redactProxyValue(proxyValue: string): string {
    if (!proxyValue || proxyValue === 'unset') {
      return 'unset'
    }

    try {
      const parsedUrl = new URL(proxyValue)
      if (parsedUrl.username || parsedUrl.password) {
        parsedUrl.username = '***'
        parsedUrl.password = '***'
      }
      return parsedUrl.toString()
    } catch {
      const atSymbolIndex = proxyValue.lastIndexOf('@')
      if (atSymbolIndex > 0) {
        return `***@${proxyValue.slice(atSymbolIndex + 1)}`
      }

      return proxyValue
    }
  }

  private probeNvidiaSmi(): {
    status: string
    gpus: Array<{ name: string, memoryMb: string, driverVersion: string }>
  } {
    try {
      const rawOutput = execFileSync(
        'nvidia-smi',
        [
          '--query-gpu=name,memory.total,driver_version',
          '--format=csv,noheader,nounits'
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        }
      ).trim()

      if (!rawOutput) {
        return {
          status: 'no_output',
          gpus: []
        }
      }

      const gpus = rawOutput
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [name = 'unknown', memoryMb = 'unknown', driverVersion = 'unknown'] =
            line.split(',').map((part) => part.trim())
          return { name, memoryMb, driverVersion }
        })

      return {
        status: 'ok',
        gpus
      }
    } catch {
      return {
        status: 'unavailable',
        gpus: []
      }
    }
  }

  private probeStorage(): {
    source: string
    summary: string
    entries: Array<{
      filesystem: string
      size: string
      used: string
      available: string
      usedPct: string
      mountPoint: string
    }>
  } {
    try {
      const rawOutput = execFileSync('df', ['-hP'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim()

      const rows = rawOutput
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.replace(/\s+/g, ' ').split(' '))
        .filter((parts) => parts.length >= 6)
        .map((parts) => ({
          filesystem: parts[0] || 'unknown',
          size: parts[1] || 'unknown',
          used: parts[2] || 'unknown',
          available: parts[3] || 'unknown',
          usedPct: parts[4] || 'unknown',
          mountPoint: parts.slice(5).join(' ') || 'unknown'
        }))

      const targetRow =
        rows.find((row) => row.mountPoint === os.homedir()) ||
        rows.find((row) => row.mountPoint === '/home') ||
        rows.find((row) => row.mountPoint === '/') ||
        rows[0]

      const summary = targetRow
        ? `Storage snapshot shows ${targetRow.available} free on ${targetRow.mountPoint}.`
        : 'Storage snapshot unavailable.'

      return {
        source: 'df -hP',
        summary,
        entries: rows.slice(0, 12)
      }
    } catch {
      return {
        source: 'df -hP (failed)',
        summary: 'Storage snapshot unavailable.',
        entries: []
      }
    }
  }
}
