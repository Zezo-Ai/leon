import {
  PNPM_INSTALL_PATH,
  PNPM_MANIFEST_PATH,
  PNPM_BIN_PATH,
  PNPM_VERSION
} from '@/constants'
import { CPUArchitectures } from '@/types'
import { LogHelper } from '@/helpers/log-helper'
import { SystemHelper } from '@/helpers/system-helper'

import { setupRuntimeBinary } from './setup-runtime-binary'

const { cpuArchitecture: CPU_ARCH } = SystemHelper.getInformation()

function getAssetFileName() {
  if (SystemHelper.isLinux()) {
    if (CPU_ARCH === CPUArchitectures.X64) {
      return 'pnpm-linux-x64.tar.gz'
    }

    if (CPU_ARCH === CPUArchitectures.ARM64) {
      return 'pnpm-linux-arm64.tar.gz'
    }
  }

  if (SystemHelper.isMacOS()) {
    if (CPU_ARCH === CPUArchitectures.X64) {
      return 'pnpm-macos-x64.tar.gz'
    }

    if (CPU_ARCH === CPUArchitectures.ARM64) {
      return 'pnpm-macos-arm64.tar.gz'
    }
  }

  if (SystemHelper.isWindows()) {
    return CPU_ARCH === CPUArchitectures.ARM64
      ? 'pnpm-win-arm64.exe'
      : 'pnpm-win-x64.exe'
  }

  throw new Error(
    `Unsupported platform for pnpm: ${SystemHelper.getInformation().type} ${CPU_ARCH}`
  )
}

export default async function setupPNPM() {
  LogHelper.info('Downloading and setting up pnpm...')

  const assetFileName = getAssetFileName()

  await setupRuntimeBinary({
    name: 'pnpm',
    version: PNPM_VERSION,
    basePath: PNPM_INSTALL_PATH,
    installPath: PNPM_INSTALL_PATH,
    manifestPath: PNPM_MANIFEST_PATH,
    binaryPath: PNPM_BIN_PATH,
    downloadURL: `https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/${assetFileName}`,
    archiveFileName: assetFileName.endsWith('.tar.gz') ? assetFileName : null
  })
}
