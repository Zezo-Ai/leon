import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { execSync } from 'node:child_process'

import { downloadFile as ipullDownloadFile } from 'ipull'

interface DownloadFileOptions {
  cliProgress?: boolean
  parallelStreams?: number
  skipExisting?: boolean
}

export class FileHelper {
  /**
   * Check whether a path exists on disk.
   */
  public static isExistingPath(filePath: string): boolean {
    return fs.existsSync(filePath)
  }

  /**
   * Download file
   * @param fileURL The file URL to download
   * @param destinationPath The destination path to save the file
   * @param options The download options
   * @example downloadFile('https://example.com/file.zip', 'output/dir/file.zip', { cliProgress: true, parallelStreams: 3 })
   */
  public static async downloadFile(
    fileURL: string,
    destinationPath: string,
    options?: DownloadFileOptions
  ): Promise<void> {
    options = {
      cliProgress: true,
      parallelStreams: 3,
      skipExisting: false,
      ...options
    }

    const directory = path.dirname(destinationPath)
    const fileName = path.basename(destinationPath)
    const downloader = await ipullDownloadFile({
      url: fileURL,
      directory,
      fileName,
      ...options
    })

    try {
      await downloader.download()
    } finally {
      await downloader.close()
    }
  }

  /**
   * Create a manifest file
   * @param manifestPath The manifest file path
   * @param manifestName The manifest name
   * @param manifestVersion The manifest version
   * @param extraData Extra data to add to the manifest
   */
  public static async createManifestFile(
    manifestPath: string,
    manifestName: string,
    manifestVersion: string,
    extraData?: Record<string, unknown>
  ): Promise<void> {
    const manifest = {
      name: manifestName,
      version: manifestVersion,
      setupDate: Date.now(),
      ...extraData
    }

    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  }

  /**
   * Extract archive file using native system commands
   * Supports .zip, .tar, .tar.gz, .tar.xz, .tgz formats across all platforms
   * @param archivePath The path to the archive file
   * @param targetPath The path to extract to
   * @param options Extraction options
   * @example extractArchive('archive.zip', 'output/dir')
   * @example extractArchive('archive.tar.xz', 'output/dir', { stripComponents: 1 })
   */
  public static async extractArchive(
    archivePath: string,
    targetPath: string,
    options?: {
      stripComponents?: number
    }
  ): Promise<void> {
    const stripComponents = options?.stripComponents ?? 0

    // Ensure target directory exists
    await fs.promises.mkdir(targetPath, { recursive: true })

    const ext = path.extname(archivePath).toLowerCase()
    const basename = path.basename(archivePath).toLowerCase()

    try {
      if (ext === '.zip' || ext === '.whl') {
        // Use unzip for .zip files (available on all platforms)
        execSync(`unzip -o -q "${archivePath}" -d "${targetPath}"`, {
          stdio: 'inherit'
        })
      } else if (
        basename.endsWith('.tar.gz') ||
        basename.endsWith('.tar.xz') ||
        basename.endsWith('.tgz') ||
        ext === '.tar'
      ) {
        // Use tar for .tar.* files (available on all platforms)
        const stripFlag =
          stripComponents > 0 ? `--strip-components=${stripComponents}` : ''
        execSync(`tar -xf "${archivePath}" -C "${targetPath}" ${stripFlag}`, {
          stdio: 'inherit'
        })
      } else {
        throw new Error(`Unsupported archive format: ${archivePath}`)
      }
    } catch (error) {
      throw new Error(
        `Failed to extract archive "${archivePath}": ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  /**
   * Dynamically imports a module or JSON file using a file path,
   * ensuring cross-platform compatibility for native ESM imports
   * @param filePath
   * @param options
   * @example dynamicImportFromFile('path/to/module.js')
   */
  public static async dynamicImportFromFile(
    filePath: string,
    options?: ImportCallOptions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const absolutePath = path.resolve(filePath)
    const fileURL = url.pathToFileURL(absolutePath).href

    /**
     * This creates a function at runtime that performs the import.
     * Esbuild won't try to analyze it, resolving the warning when building the Node.js bridge
     */
    const importer = new Function(
      'url',
      'options',
      'return import(url, options)'
    )

    return importer(fileURL, options)
  }
}
