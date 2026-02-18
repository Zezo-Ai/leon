import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execSync, spawnSync } from 'node:child_process'

import { downloadFile } from 'ipull'

import { TOOLKITS_PATH } from '@bridge/constants'
import { ToolkitConfig } from '@sdk/toolkit-config'
import {
  isWindows,
  isMacOS,
  setHuggingFaceURL,
  formatBytes,
  formatSpeed,
  formatETA,
  formatFilePath,
  extractArchive
} from '@sdk/utils'
import { leon } from '@sdk/leon'

// Progress callback type for reporting tool progress
export type ProgressCallback = (progress: {
  percentage?: number
  status?: string
  eta?: string
  speed?: string
  size?: string
}) => void

// Command execution options
export interface ExecuteCommandOptions {
  binaryName: string
  args: string[]
  options?: {
    cwd?: string
    timeout?: number
    encoding?: BufferEncoding
    sync?: boolean
    openInTerminal?: boolean
    waitForExit?: boolean
  }
  onProgress?: ProgressCallback
  onOutput?: (data: string, isError?: boolean) => void
  skipBinaryDownload?: boolean
}

export abstract class Tool {
  /**
   * Tool name
   */
  abstract get toolName(): string

  /**
   * Toolkit name
   */
  abstract get toolkit(): string

  /**
   * Tool description
   */
  abstract get description(): string

  /**
   * Enable CLI progress display for downloads (logs to stdout instead of stderr to avoid JSON interference)
   */
  protected cliProgress: boolean = true

  /**
   * Report tool status or information using leon.answer with automatic toolkit/tool context
   */
  protected async report(
    key: string,
    data?: Record<string, string | number>,
    toolGroupId?: string
  ): Promise<void> {
    const coreData: Record<string, unknown> = {
      isToolOutput: true,
      toolkitName: this.toolkit,
      toolName: this.toolName
    }

    if (toolGroupId) {
      coreData['toolGroupId'] = toolGroupId
    }

    await leon.answer({
      key,
      data: data || {},
      core: coreData
    })
  }

  /**
   * Escape shell argument by escaping special characters with backslashes
   * This follows the Unix/Linux shell escaping convention
   */
  private escapeShellArg(arg: string): string {
    // Don't escape URLs - they have their own structure
    try {
      new URL(arg)
      // If URL constructor succeeds, it's a valid URL - don't escape it
      return arg
    } catch {
      // Not a valid URL, continue with normal escaping
    }

    if (isWindows()) {
      // Windows: wrap in double quotes and escape internal quotes
      if (
        arg.includes(' ') ||
        arg.includes('"') ||
        arg.includes('&') ||
        arg.includes('|')
      ) {
        return `"${arg.replace(/"/g, '\\"')}"`
      }

      return arg
    }

    // Unix/Linux: escape special characters with backslashes
    return arg.replace(/(["\s'$`\\(){}[\]|&;<>*?!])/g, '\\$1')
  }

  /**
   * Execute a command with proper Leon messaging and progress tracking
   */
  protected async executeCommand(
    options: ExecuteCommandOptions
  ): Promise<string> {
    const {
      binaryName,
      args,
      options: execOptions = {},
      onProgress,
      onOutput,
      skipBinaryDownload
    } = options
    const { sync = false } = execOptions

    // Get binary path (auto-downloads if needed)
    const binaryPath = await this.getBinaryPath(binaryName, skipBinaryDownload)
    const commandString = `"${binaryPath}" ${args
      .map((arg) => this.escapeShellArg(arg))
      .join(' ')}`

    // Generate a unique group ID for this command execution
    const toolGroupId = `${this.toolkit}_${this.toolName}_${Date.now()}`

    await this.report(
      'bridges.tools.executing_command',
      {
        binary_name: binaryName,
        command: commandString
      },
      toolGroupId
    )

    if (execOptions.openInTerminal) {
      return this.executeTerminalCommand(
        binaryPath,
        args,
        commandString,
        execOptions,
        toolGroupId
      )
    }

    if (sync) {
      return this.executeSyncCommand(
        binaryPath,
        args,
        commandString,
        execOptions,
        toolGroupId
      )
    } else {
      return this.executeAsyncCommand(
        binaryPath,
        args,
        commandString,
        execOptions,
        toolGroupId,
        onProgress,
        onOutput
      )
    }
  }

  /**
   * Execute command synchronously
   */
  private executeSyncCommand(
    binaryPath: string,
    args: string[],
    commandString: string,
    execOptions: ExecuteCommandOptions['options'] = {},
    toolGroupId: string
  ): string {
    try {
      const startTime = Date.now()

      const result = execSync(
        `"${binaryPath}" ${args
          .map((arg) => this.escapeShellArg(arg))
          .join(' ')}`,
        {
          encoding: execOptions.encoding || 'utf8',
          timeout: execOptions.timeout,
          cwd: execOptions.cwd
        }
      )

      const executionTime = Date.now() - startTime

      this.report(
        'bridges.tools.command_completed',
        {
          command: commandString,
          execution_time: `${executionTime}ms`
        },
        toolGroupId
      )

      return result as string
    } catch (error: unknown) {
      this.report(
        'bridges.tools.command_failed',
        {
          command: commandString,
          error: (error as Error).message
        },
        toolGroupId
      )
      throw error
    }
  }

  /**
   * Execute command asynchronously with progress tracking
   */
  private executeAsyncCommand(
    binaryPath: string,
    args: string[],
    commandString: string,
    execOptions: ExecuteCommandOptions['options'] = {},
    toolGroupId: string,
    onProgress?: ProgressCallback,
    onOutput?: (data: string, isError?: boolean) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now()
      let outputBuffer = ''

      const childProcess = spawn(binaryPath, args, {
        cwd: execOptions.cwd
      })

      // Handle stdout
      childProcess.stdout.on('data', (data) => {
        const output = data.toString()
        outputBuffer += output

        if (onOutput) {
          onOutput(output, false)
        }

        // Call progress callback if provided
        if (onProgress) {
          onProgress({ status: 'running' })
        }
      })

      // Handle stderr
      childProcess.stderr.on('data', (data) => {
        const output = data.toString()
        outputBuffer += output

        if (onOutput) {
          onOutput(output, true)
        }
      })

      // Handle process completion
      childProcess.on('close', async (code) => {
        const executionTime = Date.now() - startTime

        if (code === 0) {
          await this.report(
            'bridges.tools.command_completed',
            {
              command: commandString,
              execution_time: `${executionTime}ms`
            },
            toolGroupId
          )

          if (onProgress) {
            onProgress({ status: 'completed', percentage: 100 })
          }

          resolve(outputBuffer)
        } else {
          await this.report(
            'bridges.tools.command_failed',
            {
              command: commandString,
              exit_code: code?.toString() ?? 'unknown',
              execution_time: `${executionTime}ms`
            },
            toolGroupId
          )
          reject(
            new Error(`Command failed with exit code ${code}: ${outputBuffer}`)
          )
        }
      })

      // Handle process errors
      childProcess.on('error', async (error) => {
        await this.report(
          'bridges.tools.command_error',
          {
            command: commandString,
            error: error.message
          },
          toolGroupId
        )
        reject(error)
      })

      // Handle timeout
      if (execOptions.timeout) {
        setTimeout(() => {
          childProcess.kill('SIGTERM')
          this.report(
            'bridges.tools.command_timeout',
            {
              command: commandString,
              timeout: `${execOptions.timeout}ms`
            },
            toolGroupId
          )
          reject(new Error(`Command timed out after ${execOptions.timeout}ms`))
        }, execOptions.timeout)
      }
    })
  }

  /**
   * Get binary path and ensure it's downloaded
   */
  async getBinaryPath(
    binaryName: string,
    skipBinaryDownload?: boolean
  ): Promise<string> {
    // For built-in commands like bash, just return the binary name
    if (skipBinaryDownload) {
      return binaryName
    }

    // Get tool name without "Tool" suffix for config lookup
    const toolConfigName = this.toolName.toLowerCase().replace('tool', '')
    const config = ToolkitConfig.load(this.toolkit, toolConfigName)
    const binaryUrl = ToolkitConfig.getBinaryUrl(config)

    await this.report('bridges.tools.checking_binary', {
      binary_name: binaryName
    })

    if (!binaryUrl) {
      await this.report('bridges.tools.no_binary_url', {
        binary_name: binaryName
      })
      throw new Error(`No download URL found for binary '${binaryName}'`)
    }

    // Extract the actual filename from the URL
    const urlPath = new URL(binaryUrl).pathname
    let actualFilename = path.basename(urlPath)

    // Strip archive extensions to get the base binary name
    const archiveExtensions = ['.tar.gz', '.tar.xz', '.tgz', '.zip', '.tar']
    for (const ext of archiveExtensions) {
      if (actualFilename.toLowerCase().endsWith(ext)) {
        actualFilename = actualFilename.slice(0, -ext.length)
        break
      }
    }

    const executable =
      isWindows() && !actualFilename.endsWith('.exe')
        ? `${actualFilename}.exe`
        : actualFilename

    const binsPath = path.join(TOOLKITS_PATH, this.toolkit, 'bins')

    // Ensure toolkit bins directory exists
    if (!fs.existsSync(binsPath)) {
      await this.report('bridges.tools.creating_bins_directory', {
        toolkit: this.toolkit
      })
      fs.mkdirSync(binsPath, { recursive: true })
    }

    const binaryPath = path.join(binsPath, executable)

    // Ensure binary is available before returning path
    if (!fs.existsSync(binaryPath)) {
      await this.downloadBinaryOnDemand(binaryName, binaryUrl, executable)
    }

    /**
     * Force chmod again in case it has been downloaded but somehow failed
     * so it could not chmod correctly earlier
     */
    if (!isWindows()) {
      await this.report('bridges.tools.applying_permissions', {
        binary_name: binaryName
      })
      fs.chmodSync(binaryPath, 0o755)
    }

    await this.report('bridges.tools.binary_ready', {
      binary_name: binaryName
    })

    return binaryPath
  }

  /**
   * Get resource path and ensure all resource files are downloaded
   * @param resourceName The name of the resource as defined in toolkit.json
   * @returns A promise that resolves to the path of the resource directory
   */
  async getResourcePath(resourceName: string): Promise<string> {
    // Get tool name without "Tool" suffix for config lookup
    const toolConfigName = this.toolName.toLowerCase().replace('tool', '')
    const config = ToolkitConfig.load(this.toolkit, toolConfigName)
    const resourceUrls = config.resources?.[resourceName]

    await this.report('bridges.tools.checking_resource', {
      resource_name: resourceName
    })

    if (
      !resourceUrls ||
      !Array.isArray(resourceUrls) ||
      resourceUrls.length === 0
    ) {
      await this.report('bridges.tools.no_resource_urls', {
        resource_name: resourceName
      })
      throw new Error(`No download URLs found for resource '${resourceName}'`)
    }

    const resourcePath = path.join(
      TOOLKITS_PATH,
      this.toolkit,
      'bins',
      resourceName
    )

    // Ensure toolkit bins directory exists
    if (!fs.existsSync(resourcePath)) {
      await this.report('bridges.tools.creating_resource_directory', {
        resource_name: resourceName,
        resource_path: formatFilePath(resourcePath)
      })

      fs.mkdirSync(resourcePath, { recursive: true })
    }

    // Check if all resource files exist and are complete
    if (this.isResourceComplete(resourcePath, resourceUrls)) {
      await this.report('bridges.tools.resource_already_exists', {
        resource_name: resourceName,
        resource_path: formatFilePath(resourcePath)
      })

      return resourcePath
    }

    await this.report('bridges.tools.downloading_resource', {
      resource_name: resourceName
    })

    // Download each resource file
    for (const resourceUrl of resourceUrls) {
      const adjustedUrl = await setHuggingFaceURL(resourceUrl)

      const relativePath = this.getResourceRelativePath(adjustedUrl)

      if (!relativePath) {
        throw new Error(`Invalid filename extracted from URL: ${adjustedUrl}`)
      }

      const fileName = path.basename(relativePath)
      const filePath = path.join(resourcePath, relativePath)

      await this.report('bridges.tools.downloading_resource_file', {
        resource_name: resourceName,
        file_name: fileName,
        url: adjustedUrl
      })

      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
        const engine = await downloadFile({
          url: adjustedUrl,
          savePath: filePath,
          cliProgress: false,
          parallelStreams: 3,
          skipExisting: false
        })

        this.listenDownloadProgress(engine, fileName)

        await engine.download()

        await this.report('bridges.tools.resource_file_downloaded', {
          resource_name: resourceName,
          file_name: fileName,
          file_path: filePath
        })
      } catch (error) {
        await this.report('bridges.tools.resource_file_download_failed', {
          resource_name: resourceName,
          file_name: fileName,
          url: adjustedUrl,
          error: (error as Error).message
        })
        throw new Error(
          `Failed to download resource file ${fileName}: ${
            (error as Error).message
          }`
        )
      }
    }

    await this.report('bridges.tools.resource_downloaded', {
      resource_name: resourceName,
      resource_path: formatFilePath(resourcePath)
    })

    return resourcePath
  }

  /**
   * Check if all resource files exist and are not empty
   * @param resourcePath Path to the resource directory
   * @param resourceUrls Array of resource URLs to check against
   * @returns True if all files exist and are not empty, false otherwise
   */
  private isResourceComplete(
    resourcePath: string,
    resourceUrls: string[]
  ): boolean {
    for (const resourceUrl of resourceUrls) {
      const relativePath = this.getResourceRelativePath(resourceUrl)

      if (!relativePath) {
        return false
      }

      const filePath = path.join(resourcePath, relativePath)

      if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
        return false
      }
    }
    return true
  }

  /**
   * Resolve a resource URL to a relative file path inside the resource directory.
   * Preserves subfolders (e.g., speech_tokenizer/config.json) when present.
   */
  private getResourceRelativePath(resourceUrl: string): string {
    const urlPath = new URL(resourceUrl).pathname
    const markers = ['/resolve/', '/raw/']

    for (const marker of markers) {
      const markerIndex = urlPath.indexOf(marker)
      if (markerIndex === -1) {
        continue
      }

      const afterMarker = urlPath.slice(markerIndex + marker.length)
      const parts = afterMarker.split('/').filter(Boolean)

      if (parts.length > 1) {
        const relativePath = parts.slice(1).join('/')
        return path.posix.normalize(relativePath).replace(/^\/+/, '')
      }
    }

    return path.basename(urlPath)
  }

  /**
   * Delete older versions of a binary based on filename pattern
   * Example: if downloading chatterbox_onnx_1.1.0-linux-x86_64, delete chatterbox_onnx_1.0.0-linux-x86_64
   */
  private async deleteOlderBinaryVersions(
    binsPath: string,
    newExecutable: string
  ): Promise<void> {
    try {
      // Parse the new binary filename to extract name, version, and platform
      // Pattern: {name}_{version}-{platform}[.exe]
      const match = newExecutable.match(
        /^(.+?)_(\d+\.\d+\.\d+)-(.*?)(?:\.exe)?$/
      )

      if (!match) {
        // If filename doesn't match the versioned pattern, skip cleanup
        return
      }

      const [, binaryBaseName, newVersion, platform] = match

      // Get all files in the bins directory
      const files = fs.readdirSync(binsPath)

      for (const file of files) {
        // Check if this file matches the same binary name and platform but different version
        const fileMatch = file.match(/^(.+?)_(\d+\.\d+\.\d+)-(.*?)(?:\.exe)?$/)

        if (!fileMatch) {
          continue
        }

        const [, fileBaseName, fileVersion, filePlatform] = fileMatch

        // Only delete if:
        // 1. Same binary base name
        // 2. Same platform
        // 3. Different version
        if (
          fileBaseName === binaryBaseName &&
          filePlatform === platform &&
          fileVersion !== newVersion
        ) {
          const oldBinaryPath = path.join(binsPath, file)

          await this.report('bridges.tools.deleting_old_version', {
            old_version: file,
            new_version: newExecutable
          })

          fs.unlinkSync(oldBinaryPath)

          await this.report('bridges.tools.old_version_deleted', {
            deleted_file: file
          })
        }
      }
    } catch (error) {
      // Don't fail the entire process if cleanup fails
      await this.report('bridges.tools.cleanup_warning', {
        error: (error as Error).message
      })
    }
  }

  /**
   * Execute command in a new terminal window
   */
  private async executeTerminalCommand(
    binaryPath: string,
    args: string[],
    commandString: string,
    execOptions: ExecuteCommandOptions['options'] = {},
    toolGroupId: string
  ): Promise<string> {
    const cwd = execOptions.cwd || process.cwd()
    const timeout = execOptions.timeout ?? 600_000
    const waitForExit = execOptions.waitForExit ?? true
    const startTime = Date.now()
    const markerFile = path.join(
      os.tmpdir(),
      `${this.toolkit}_${this.toolName}_${Date.now()}.done`
    )

    const runCommand = this.buildTerminalRunCommand(
      binaryPath,
      args,
      cwd,
      markerFile
    )

    this.launchTerminal(runCommand)

    if (!waitForExit) {
      return ''
    }

    const exitCode = await this.waitForMarker(markerFile, timeout)
    const executionTime = `${Date.now() - startTime}ms`

    if (exitCode === null) {
      await this.report(
        'bridges.tools.command_timeout',
        {
          command: commandString,
          timeout: `${timeout}ms`
        },
        toolGroupId
      )
      throw new Error(`Command timed out after ${timeout}ms`)
    }

    if (exitCode !== 0) {
      await this.report(
        'bridges.tools.command_failed',
        {
          command: commandString,
          exit_code: exitCode.toString(),
          execution_time: executionTime
        },
        toolGroupId
      )
      throw new Error(`Command failed with exit code ${exitCode}`)
    }

    await this.report(
      'bridges.tools.command_completed',
      {
        command: commandString,
        execution_time: executionTime
      },
      toolGroupId
    )

    return ''
  }

  private buildTerminalRunCommand(
    binaryPath: string,
    args: string[],
    cwd: string,
    markerFile: string
  ): string {
    if (isWindows()) {
      const cwdArg = this.escapeWindowsArg(cwd)
      const markerArg = this.escapeWindowsArg(markerFile)
      const command = this.buildBinaryCommand(binaryPath, args)
      return `cd /d ${cwdArg} && ${command} & echo %ERRORLEVEL% > ${markerArg}`
    }

    const cwdArg = this.escapeShellArg(cwd)
    const markerArg = this.escapeShellArg(markerFile)
    const command = this.buildBinaryCommand(binaryPath, args)
    return `cd ${cwdArg} && ${command}; echo $? > ${markerArg}`
  }

  private buildBinaryCommand(binaryPath: string, args: string[]): string {
    const binaryArg = this.escapeShellArg(binaryPath)
    const argString = args.map((arg) => this.escapeShellArg(arg)).join(' ')
    return `${binaryArg} ${argString}`.trim()
  }

  private launchTerminal(command: string): void {
    if (isMacOS()) {
      const termProgram = process.env['TERM_PROGRAM'] || ''
      const escaped = this.escapeForAppleScript(command)
      if (termProgram.toLowerCase().includes('iterm')) {
        const script = [
          'tell application "iTerm"',
          '  create window with default profile',
          `  tell current session of current window to write text "${escaped}"`,
          'end tell'
        ].join('\n')
        this.spawnDetached('osascript', ['-e', script])
        return
      }

      const script = `tell application "Terminal" to do script "${escaped}"`
      this.spawnDetached('osascript', ['-e', script])
      return
    }

    if (isWindows()) {
      if (process.env['WT_SESSION'] || this.commandExists('wt')) {
        this.spawnDetached('wt', ['cmd', '/k', command])
        return
      }
      this.spawnDetached('cmd', ['/c', 'start', '', 'cmd', '/k', command])
      return
    }

    const linuxCommand = `${command}; echo Command finished.; exec bash`
    const candidates: Array<{ cmd: string; args: string[] }> = [
      { cmd: 'gnome-terminal', args: ['--', 'bash', '-lc', linuxCommand] },
      { cmd: 'x-terminal-emulator', args: ['-e', 'bash', '-lc', linuxCommand] },
      { cmd: 'konsole', args: ['-e', 'bash', '-lc', linuxCommand] },
      {
        cmd: 'xfce4-terminal',
        args: ['--command', `bash -lc "${linuxCommand}"`]
      },
      { cmd: 'xterm', args: ['-e', 'bash', '-lc', linuxCommand] },
      { cmd: 'kitty', args: ['bash', '-lc', linuxCommand] }
    ]

    for (const candidate of candidates) {
      if (!this.commandExists(candidate.cmd)) continue
      this.spawnDetached(candidate.cmd, candidate.args)
      return
    }

    throw new Error('No supported terminal emulator found to launch command.')
  }

  private async waitForMarker(
    markerFile: string,
    timeoutMs: number
  ): Promise<number | null> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(markerFile)) {
        const content = await fs.promises.readFile(markerFile, 'utf-8')
        const exitCode = Number.parseInt(content.trim(), 10)
        return Number.isFinite(exitCode) ? exitCode : 1
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return null
  }

  private spawnDetached(command: string, args: string[]): void {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.unref()
  }

  private commandExists(command: string): boolean {
    const checker = isWindows() ? 'where' : 'which'
    const result = spawnSync(checker, [command], { stdio: 'ignore' })
    return result.status === 0
  }

  private escapeWindowsArg(value: string): string {
    return `"${value.replace(/"/g, '""')}"`
  }

  private escapeForAppleScript(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }

  /**
   * Download binary on-demand if not found
   */
  private async downloadBinaryOnDemand(
    binaryName: string,
    binaryUrl: string,
    executable: string
  ): Promise<void> {
    try {
      const binsPath = path.join(TOOLKITS_PATH, this.toolkit, 'bins')
      const binaryPath = path.join(binsPath, executable)

      await this.report('bridges.tools.binary_not_found', {
        binary_name: binaryName
      })

      await this.downloadBinary(binaryUrl, binaryPath)

      await this.report('bridges.tools.binary_downloaded', {
        binary_name: binaryName
      })

      // Delete older versions of this binary
      await this.deleteOlderBinaryVersions(binsPath, executable)

      // Make binary executable (Unix systems)
      if (!isWindows()) {
        await this.report('bridges.tools.making_executable', {
          binary_name: binaryName
        })
        fs.chmodSync(binaryPath, 0o755)
      }

      // Remove quarantine attribute on macOS to prevent Gatekeeper blocking
      if (isMacOS()) {
        await this.removeQuarantineAttribute(binaryPath)
      }
    } catch (error) {
      await this.report('bridges.tools.download_failed', {
        binary_name: binaryName,
        error: (error as Error).message
      })
      throw new Error(
        `Failed to download binary '${binaryName}': ${(error as Error).message}`
      )
    }
  }

  /**
   * Check if a file is an archive based on its extension
   */
  private isArchive(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    const basename = path.basename(filePath).toLowerCase()

    return (
      ext === '.zip' ||
      ext === '.tar' ||
      basename.endsWith('.tar.gz') ||
      basename.endsWith('.tar.xz') ||
      basename.endsWith('.tgz')
    )
  }

  /**
   * Download binary from URL using ipull (faster parallel downloader)
   * If the downloaded file is an archive, it will be extracted automatically
   */
  private async downloadBinary(url: string, outputPath: string): Promise<void> {
    try {
      await this.report('bridges.tools.downloading_from_url')

      // Determine if the URL points to an archive
      const urlPath = new URL(url).pathname
      const isArchiveDownload = this.isArchive(urlPath)

      // If it's an archive, download to a temporary path with proper extension
      let downloadPath = outputPath
      if (isArchiveDownload) {
        // Preserve the archive extension for proper extraction
        const urlBasename = path.basename(urlPath)
        const archiveExt = urlBasename.includes('.tar.gz')
          ? '.tar.gz'
          : urlBasename.includes('.tar.xz')
            ? '.tar.xz'
            : urlBasename.includes('.tgz')
              ? '.tgz'
              : path.extname(urlPath)
        downloadPath = outputPath + archiveExt
      }

      // Download the file directly to the download path using ipull
      const engine = await downloadFile({
        url: url,
        savePath: downloadPath,
        cliProgress: false,
        parallelStreams: 3,
        skipExisting: false
      })

      this.listenDownloadProgress(engine, path.basename(downloadPath))

      // Actually start the download
      await engine.download()

      // If it's an archive, extract it
      if (isArchiveDownload) {
        await this.report('bridges.tools.extracting_archive', {
          archive_name: path.basename(downloadPath)
        })

        // Create a temporary extraction directory
        const tempExtractPath = outputPath + '.extracted'

        // Try extracting without strip first to see the structure
        await extractArchive(downloadPath, tempExtractPath)

        // Find the binary in the extracted directory (recursively if needed)
        let binaryFilePath: string | null = null

        const findBinaryFile = (dir: string): string | null => {
          const entries = fs.readdirSync(dir, { withFileTypes: true })

          // First, look for files in the current directory
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)
            if (entry.isFile()) {
              return fullPath
            }
          }

          // If no files found, look in subdirectories (one level deep)
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              const foundFile = findBinaryFile(fullPath)
              if (foundFile) {
                return foundFile
              }
            }
          }

          return null
        }

        binaryFilePath = findBinaryFile(tempExtractPath)

        if (!binaryFilePath) {
          throw new Error('Archive extraction resulted in no files')
        }

        // Move the binary to the final output path
        fs.renameSync(binaryFilePath, outputPath)

        // Report successful extraction
        await this.report('bridges.tools.archive_extracted', {
          binary_path: outputPath
        })

        // Clean up temporary files
        fs.rmSync(downloadPath, { force: true })
        fs.rmSync(tempExtractPath, { recursive: true, force: true })

        await this.report('bridges.tools.archive_extracted', {
          binary_name: path.basename(outputPath)
        })
      }
    } catch (error) {
      await this.report('bridges.tools.download_url_failed', {
        error: (error as Error).message
      })
      throw new Error(`Failed to download binary: ${(error as Error).message}`)
    }
  }

  /**
   * Log debug/progress information to stdout with special prefix to avoid being treated as JSON
   * This allows logging without interfering with the JSON communication on stdout
   */
  protected log(message: string, ...args: unknown[]): void {
    // Use a special prefix that the brain can filter out as non-JSON output
    const logMessage = `[LEON_TOOL_LOG] ${message}${
      args.length > 0 ? ' ' + args.join(' ') : ''
    }`
    process.stdout.write(logMessage + '\n')
  }

  /**
   * Setup progress tracking for a download engine if cliProgress is enabled
   * @param engine The download engine from ipull
   * @param fileName The name of the file being downloaded
   */
  private listenDownloadProgress(
    engine: {
      on: (event: string, callback: (progress: unknown) => void) => void
    },
    fileName: string
  ): void {
    if (this.cliProgress) {
      let lastLoggedPercentage = -1
      let lastLogTime = 0
      const LOG_INTERVAL_MS = 2_000 // Log every 2 seconds at most
      const PERCENTAGE_THRESHOLD = 5 // Log every 5% progress

      engine.on('progress', (progress: unknown) => {
        if (progress && typeof progress === 'object' && progress !== null) {
          const progressObj = progress as {
            percentage?: number
            speed?: string | number
            eta?: string | number
            size?: string | number
            transferred?: string | number
          }

          const percentage = Math.round(progressObj.percentage || 0)
          const currentTime = Date.now()

          // Only log if we've made significant progress or enough time has passed
          const shouldLog =
            percentage >= lastLoggedPercentage + PERCENTAGE_THRESHOLD ||
            currentTime - lastLogTime >= LOG_INTERVAL_MS ||
            percentage === 100

          if (shouldLog) {
            const speed = progressObj.speed
              ? formatSpeed(progressObj.speed)
              : ''
            const eta = progressObj.eta ? formatETA(progressObj.eta) : ''

            // Build progress line
            let progressLine = `Downloading ${fileName}: ${percentage}%`

            if (speed) {
              progressLine += ` at ${speed}`
            }

            if (eta && eta !== '∞') {
              progressLine += ` (ETA: ${eta})`
            }

            if (progressObj.size && progressObj.transferred) {
              const totalSize = formatBytes(
                typeof progressObj.size === 'string'
                  ? parseFloat(progressObj.size)
                  : progressObj.size
              )
              const transferredSize = formatBytes(
                typeof progressObj.transferred === 'string'
                  ? parseFloat(progressObj.transferred)
                  : progressObj.transferred
              )
              progressLine += ` [${transferredSize}/${totalSize}]`
            }

            this.log(progressLine)

            lastLoggedPercentage = percentage
            lastLogTime = currentTime
          }
        }
      })

      // Log completion
      const logCompletion = (): void => {
        this.log(`Download completed: ${fileName}`)
      }

      engine.on('finished', logCompletion)
      engine.on('end', logCompletion)
    }
  }

  /**
   * Remove macOS quarantine attribute to prevent Gatekeeper blocking
   */
  private async removeQuarantineAttribute(filePath: string): Promise<void> {
    return new Promise(async (resolve) => {
      try {
        const command = `xattr -d com.apple.quarantine "${filePath}"`

        await this.report('bridges.tools.removing_quarantine', {
          command
        })
        // Use xattr to remove the com.apple.quarantine extended attribute
        const xattr = spawn('xattr', ['-d', 'com.apple.quarantine', filePath])

        xattr.on('close', async (code) => {
          if (code === 0) {
            await this.report('bridges.tools.quarantine_removed', {
              file_name: path.basename(filePath)
            })
          } else {
            // Don't fail the entire process if quarantine removal fails
            await this.report('bridges.tools.quarantine_warning', {
              file_name: path.basename(filePath),
              exit_code: (code ?? 'unknown').toString()
            })
          }

          resolve()
        })

        xattr.on('error', async (error) => {
          // Don't fail the entire process if quarantine removal fails
          await this.report('bridges.tools.quarantine_error', {
            file_name: path.basename(filePath),
            error: error.message
          })

          resolve()
        })
      } catch (error) {
        // Don't fail the entire process if quarantine removal fails
        await this.report('bridges.tools.quarantine_exception', {
          file_name: path.basename(filePath),
          error: (error as Error).message
        })
        resolve()
      }
    })
  }
}
