import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import axios from 'axios'

import { TOOLKITS_PATH } from '@bridge/constants'
import { ToolkitConfig } from '@sdk/toolkit-config'
import { isWindows, isMacOS } from '@sdk/utils'
import { leon } from '@sdk/leon'

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

    await leon.answer({
      key: 'bridges.tools.checking_binary',
      data: {
        binary_name: binaryName
      }
    })

    if (!binaryUrl) {
      await leon.answer({
        key: 'bridges.tools.no_binary_url',
        data: {
          binary_name: binaryName
        }
      })
      throw new Error(`No download URL found for binary '${binaryName}'`)
    }

    // Extract the actual filename from the URL
    const urlPath = new URL(binaryUrl).pathname
    const actualFilename = path.basename(urlPath)
    const executable =
      isWindows() && !actualFilename.endsWith('.exe')
        ? `${actualFilename}.exe`
        : actualFilename

    const binsPath = path.join(TOOLKITS_PATH, this.toolkit, 'bins')

    // Ensure toolkit bins directory exists
    if (!fs.existsSync(binsPath)) {
      await leon.answer({
        key: 'bridges.tools.creating_bins_directory',
        data: {
          toolkit: this.toolkit
        }
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
      await leon.answer({
        key: 'bridges.tools.applying_permissions',
        data: {
          binary_name: binaryName
        }
      })
      fs.chmodSync(binaryPath, 0o755)
    }

    await leon.answer({
      key: 'bridges.tools.binary_ready',
      data: {
        binary_name: binaryName
      }
    })

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

      await leon.answer({
        key: 'bridges.tools.binary_not_found',
        data: {
          binary_name: binaryName
        }
      })

      await this.downloadBinary(binaryUrl, binaryPath)

      await leon.answer({
        key: 'bridges.tools.binary_downloaded',
        data: {
          binary_name: binaryName
        }
      })

      // Make binary executable (Unix systems)
      if (!isWindows()) {
        await leon.answer({
          key: 'bridges.tools.making_executable',
          data: {
            binary_name: binaryName
          }
        })
        fs.chmodSync(binaryPath, 0o755)
      }

      // Remove quarantine attribute on macOS to prevent Gatekeeper blocking
      if (isMacOS()) {
        await this.removeQuarantineAttribute(binaryPath)
      }
    } catch (error) {
      await leon.answer({
        key: 'bridges.tools.download_failed',
        data: {
          binary_name: binaryName,
          error: (error as Error).message
        }
      })
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
      await leon.answer({
        key: 'bridges.tools.downloading_from_url'
      })

      const response = await axios.get(url, { responseType: 'arraybuffer' })

      fs.writeFileSync(outputPath, response.data)
    } catch (error) {
      await leon.answer({
        key: 'bridges.tools.download_url_failed',
        data: {
          error: (error as Error).message
        }
      })
      throw new Error(`Failed to download binary: ${(error as Error).message}`)
    }
  }

  /**
   * Remove macOS quarantine attribute to prevent Gatekeeper blocking
   */
  private async removeQuarantineAttribute(filePath: string): Promise<void> {
    return new Promise(async (resolve) => {
      try {
        const command = `xattr -d com.apple.quarantine "${filePath}"`

        await leon.answer({
          key: 'bridges.tools.removing_quarantine',
          data: {
            command
          }
        })
        // Use xattr to remove the com.apple.quarantine extended attribute
        const xattr = spawn('xattr', ['-d', 'com.apple.quarantine', filePath])

        xattr.on('close', async (code) => {
          if (code === 0) {
            await leon.answer({
              key: 'bridges.tools.quarantine_removed',
              data: {
                file_name: path.basename(filePath)
              }
            })
          } else {
            // Don't fail the entire process if quarantine removal fails
            await leon.answer({
              key: 'bridges.tools.quarantine_warning',
              data: {
                file_name: path.basename(filePath),
                exit_code: code?.toString() ?? 'unknown'
              }
            })
          }

          resolve()
        })

        xattr.on('error', async (error) => {
          // Don't fail the entire process if quarantine removal fails
          await leon.answer({
            key: 'bridges.tools.quarantine_error',
            data: {
              file_name: path.basename(filePath),
              error: error.message
            }
          })

          resolve()
        })
      } catch (error) {
        // Don't fail the entire process if quarantine removal fails
        leon
          .answer({
            key: 'bridges.tools.quarantine_exception',
            data: {
              file_name: path.basename(filePath),
              error: (error as Error).message
            }
          })
          .then(() => resolve())
      }
    })
  }
}
