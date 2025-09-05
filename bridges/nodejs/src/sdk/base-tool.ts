import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import axios from 'axios'

import { TOOLKITS_PATH } from '@bridge/constants'
import { ToolkitConfig } from '@sdk/toolkit-config'
import { PlatformUtils } from '@sdk/platform-utils'

// Progress callback type for reporting tool progress
export type ProgressCallback = (progress: {
  percentage?: number
  status?: string
  eta?: string
  speed?: string
  size?: string
}) => void

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
   * Get binary path and ensure it's downloaded
   */
  async getBinaryPath(binaryName: string): Promise<string> {
    // Get tool name without "Tool" suffix for config lookup
    const toolConfigName = this.toolName.toLowerCase().replace('tool', '')
    const config = ToolkitConfig.load(this.toolkit, toolConfigName)
    const binaryUrl = ToolkitConfig.getBinaryUrl(config)

    if (!binaryUrl) {
      throw new Error(`No download URL found for binary '${binaryName}'`)
    }

    // Extract the actual filename from the URL
    const urlPath = new URL(binaryUrl).pathname
    const actualFilename = path.basename(urlPath)
    const executable =
      PlatformUtils.isWindows() && !actualFilename.endsWith('.exe')
        ? `${actualFilename}.exe`
        : actualFilename

    const binsPath = path.join(TOOLKITS_PATH, this.toolkit, 'bins')

    // Ensure toolkit bins directory exists
    if (!fs.existsSync(binsPath)) {
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
    if (!PlatformUtils.isWindows()) {
      fs.chmodSync(binaryPath, 0o755)
    }

    return binaryPath
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

      console.log(`${binaryName} binary not found. Downloading...`)
      await this.downloadBinary(binaryUrl, binaryPath)
      console.log(`${binaryName} binary downloaded successfully`)

      // Make binary executable (Unix systems)
      if (!PlatformUtils.isWindows()) {
        fs.chmodSync(binaryPath, 0o755)
      }

      // Remove quarantine attribute on macOS to prevent Gatekeeper blocking
      if (PlatformUtils.isMacOS()) {
        await this.removeQuarantineAttribute(binaryPath)
      }
    } catch (error) {
      throw new Error(
        `Failed to download binary '${binaryName}': ${(error as Error).message}`
      )
    }
  }

  /**
   * Download binary from URL using axios (matches Python urllib pattern)
   */
  private async downloadBinary(url: string, outputPath: string): Promise<void> {
    try {
      const response = await axios.get(url, { responseType: 'arraybuffer' })

      fs.writeFileSync(outputPath, response.data)
    } catch (error) {
      throw new Error(`Failed to download binary: ${(error as Error).message}`)
    }
  }

  /**
   * Remove macOS quarantine attribute to prevent Gatekeeper blocking
   */
  private async removeQuarantineAttribute(filePath: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        // Use xattr to remove the com.apple.quarantine extended attribute
        const xattr = spawn('xattr', ['-d', 'com.apple.quarantine', filePath])

        xattr.on('close', (code) => {
          if (code === 0) {
            console.log(
              `Removed quarantine attribute from ${path.basename(filePath)}`
            )
          } else {
            // Don't fail the entire process if quarantine removal fails
            console.log(
              `Warning: Could not remove quarantine attribute from ${path.basename(
                filePath
              )} (exit code: ${code})`
            )
          }
          resolve()
        })

        xattr.on('error', (error) => {
          // Don't fail the entire process if quarantine removal fails
          console.log(
            `Warning: Could not remove quarantine attribute from ${path.basename(
              filePath
            )}: ${error.message}`
          )
          resolve()
        })
      } catch (error) {
        // Don't fail the entire process if quarantine removal fails
        console.log(
          `Warning: Could not remove quarantine attribute from ${path.basename(
            filePath
          )}: ${(error as Error).message}`
        )
        resolve()
      }
    })
  }
}
