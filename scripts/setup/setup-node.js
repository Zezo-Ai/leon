import {
  NODE_INSTALL_PATH,
  NODE_MANIFEST_PATH,
  NODE_BIN_PATH,
  NODE_VERSION
} from '@/constants'
import { CPUArchitectures } from '@/types'
import { LogHelper } from '@/helpers/log-helper'
import { SystemHelper } from '@/helpers/system-helper'

import { setupRuntimeBinary } from './setup-runtime-binary'

const { cpuArchitecture: CPU_ARCH } = SystemHelper.getInformation()

function getAssetFileName() {
  if (SystemHelper.isLinux()) {
    if (CPU_ARCH === CPUArchitectures.X64) {
      return `node-v${NODE_VERSION}-linux-x64.tar.xz`
    }

    if (CPU_ARCH === CPUArchitectures.ARM64) {
      return `node-v${NODE_VERSION}-linux-arm64.tar.xz`
    }
  }

  if (SystemHelper.isMacOS()) {
    if (CPU_ARCH === CPUArchitectures.X64) {
      return `node-v${NODE_VERSION}-darwin-x64.tar.xz`
    }

    if (CPU_ARCH === CPUArchitectures.ARM64) {
      return `node-v${NODE_VERSION}-darwin-arm64.tar.xz`
    }
  }

  if (SystemHelper.isWindows()) {
    return CPU_ARCH === CPUArchitectures.ARM64
      ? `node-v${NODE_VERSION}-win-arm64.zip`
      : `node-v${NODE_VERSION}-win-x64.zip`
  }

  throw new Error(
    `Unsupported platform for Node.js: ${SystemHelper.getInformation().type} ${CPU_ARCH}`
  )
}

export default async function setupNode() {
  LogHelper.info('Downloading and setting up Node.js...')

  const assetFileName = getAssetFileName()

  await setupRuntimeBinary({
    name: 'Node.js',
    version: NODE_VERSION,
    basePath: NODE_INSTALL_PATH,
    installPath: NODE_INSTALL_PATH,
    manifestPath: NODE_MANIFEST_PATH,
    binaryPath: NODE_BIN_PATH,
    downloadURL: `https://nodejs.org/dist/v${NODE_VERSION}/${assetFileName}`,
    archiveFileName: assetFileName
  })
}
