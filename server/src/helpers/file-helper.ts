import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { execFileSync } from 'node:child_process'

import {
  NetworkHelper,
  type DownloadFileOptions
} from '@/helpers/network-helper'
import { SystemHelper } from '@/helpers/system-helper'

const ZIP_ARCHIVE_EXTENSIONS = new Set(['.zip', '.whl'])

export class FileHelper {
  /**
   * Check whether a path exists on disk.
   * @param filePath The path to inspect
   * @returns Whether the path currently exists
   */
  public static isExistingPath(filePath: string): boolean {
    return fs.existsSync(filePath)
  }

  /**
   * Compatibility wrapper around the network helper so current callers do not
   * need to change while download logic stays centralized.
   * @param fileURL The remote URL or local file path to download from
   * @param destinationPath The destination file path
   * @param options Download behavior options
   */
  public static async downloadFile(
    fileURL: string,
    destinationPath: string,
    options?: DownloadFileOptions
  ): Promise<void> {
    await NetworkHelper.downloadFile(fileURL, destinationPath, options)
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

    await fs.promises.mkdir(targetPath, { recursive: true })

    const ext = path.extname(archivePath).toLowerCase()
    const basename = path.basename(archivePath).toLowerCase()

    try {
      if (ZIP_ARCHIVE_EXTENSIONS.has(ext)) {
        if (SystemHelper.isWindows()) {
          execFileSync('tar', ['-xf', archivePath, '-C', targetPath], {
            stdio: 'inherit'
          })
        } else {
          execFileSync('unzip', ['-o', '-q', archivePath, '-d', targetPath], {
            stdio: 'inherit'
          })
        }
      } else if (
        basename.endsWith('.tar.gz') ||
        basename.endsWith('.tar.xz') ||
        basename.endsWith('.tgz') ||
        ext === '.tar'
      ) {
        const tarArgs = ['-xf', archivePath, '-C', targetPath]

        if (stripComponents > 0) {
          tarArgs.push(`--strip-components=${stripComponents}`)
        }

        execFileSync('tar', tarArgs, {
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

    const importer = new Function(
      'url',
      'options',
      'return import(url, options)'
    )

    return importer(fileURL, options)
  }
}
