import {
  PYTHON_INSTALL_PATH,
  PYTHON_MANIFEST_PATH,
  PYTHON_BIN_PATH,
  PYTHON_VERSION
} from '@/constants'
import { CPUArchitectures } from '@/types'
import { LogHelper } from '@/helpers/log-helper'
import { SystemHelper } from '@/helpers/system-helper'

import { setupRuntimeBinary } from './setup-runtime-binary'

const { cpuArchitecture: CPU_ARCH } = SystemHelper.getInformation()

function getAssetFileName() {
  if (SystemHelper.isLinux()) {
    if (CPU_ARCH === CPUArchitectures.X64) {
      return `cpython-${PYTHON_VERSION}-x86_64-unknown-linux-gnu-install_only.tar.gz`
    }

    if (CPU_ARCH === CPUArchitectures.ARM64) {
      return `cpython-${PYTHON_VERSION}-aarch64-unknown-linux-gnu-install_only.tar.gz`
    }
  }

  if (SystemHelper.isMacOS()) {
    if (CPU_ARCH === CPUArchitectures.X64) {
      return `cpython-${PYTHON_VERSION}-x86_64-apple-darwin-install_only.tar.gz`
    }

    if (CPU_ARCH === CPUArchitectures.ARM64) {
      return `cpython-${PYTHON_VERSION}-aarch64-apple-darwin-install_only.tar.gz`
    }
  }

  if (SystemHelper.isWindows()) {
    return CPU_ARCH === CPUArchitectures.ARM64
      ? `cpython-${PYTHON_VERSION}-aarch64-pc-windows-msvc-install_only.tar.gz`
      : `cpython-${PYTHON_VERSION}-x86_64-pc-windows-msvc-install_only.tar.gz`
  }

  throw new Error(
    `Unsupported platform for Python: ${SystemHelper.getInformation().type} ${CPU_ARCH}`
  )
}

export default async function setupPython() {
  LogHelper.info('Downloading and setting up Python...')

  const assetFileName = getAssetFileName()

  await setupRuntimeBinary({
    name: 'Python',
    version: PYTHON_VERSION,
    basePath: PYTHON_INSTALL_PATH,
    installPath: PYTHON_INSTALL_PATH,
    manifestPath: PYTHON_MANIFEST_PATH,
    binaryPath: PYTHON_BIN_PATH,
    downloadURL: `https://github.com/astral-sh/python-build-standalone/releases/download/20240415/${assetFileName}`,
    archiveFileName: assetFileName
  })
}
