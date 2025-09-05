import os from 'node:os'

/**
 * Platform utilities for consistent platform and architecture detection
 * Matches the naming convention from system-helper.ts BinaryFolderNames enum
 */
export class PlatformUtils {
  /**
   * Get platform name with architecture granularity (matches system-helper.ts)
   * Returns same format as BinaryFolderNames enum from system-helper.ts
   */
  static getPlatformName(): string {
    const platform = os.platform()
    const cpuArchitecture = os.arch()

    if (platform === 'linux') {
      if (cpuArchitecture === 'x64') {
        return 'linux-x86_64'
      }

      return 'linux-aarch64'
    }

    if (platform === 'darwin') {
      const cpuCores = os.cpus()
      const isM1 = cpuCores[0]?.model.includes('Apple')

      if (isM1 || cpuArchitecture === 'arm64') {
        return 'macosx-arm64'
      }

      return 'macosx-x86_64'
    }

    if (platform === 'win32') {
      return 'win-amd64'
    }

    return 'unknown'
  }

  /**
   * Check if current platform is Windows
   */
  static isWindows(): boolean {
    return this.getPlatformName().startsWith('win')
  }

  /**
   * Check if current platform is macOS
   */
  static isMacOS(): boolean {
    return this.getPlatformName().startsWith('macosx')
  }

  /**
   * Check if current platform is Linux
   */
  static isLinux(): boolean {
    return this.getPlatformName().startsWith('linux')
  }
}
