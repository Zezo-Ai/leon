import fs from 'node:fs'
import path from 'node:path'

import {
  NVIDIA_LIBS_PATH,
  PYTORCH_PATH,
  PYTORCH_TORCH_PATH,
  PYTORCH_NVIDIA_PATH,
  PYTORCH_VERSION,
  PYTORCH_MANIFEST_PATH
} from '@/constants'
import { FileHelper } from '@/helpers/file-helper'
import { SystemHelper } from '@/helpers/system-helper'
import { LogHelper } from '@/helpers/log-helper'

const { type: OS_TYPE, cpuArchitecture: CPU_ARCH } =
  SystemHelper.getInformation()

async function ensureDirectoryLink(linkPath, targetPath) {
  if (!fs.existsSync(targetPath)) {
    return
  }

  await fs.promises.rm(linkPath, { recursive: true, force: true })
  await fs.promises.mkdir(path.dirname(linkPath), { recursive: true })

  const relativeTarget = path.relative(path.dirname(linkPath), targetPath)
  const linkType = SystemHelper.isWindows() ? 'junction' : 'dir'

  await fs.promises.symlink(relativeTarget, linkPath, linkType)
}

/**
 * Map OS and architecture to PyTorch wheel platform identifiers
 */
function getPyTorchPlatform() {
  const isMacOS = SystemHelper.isMacOS()
  const isWindows = SystemHelper.isWindows()
  const isLinux = SystemHelper.isLinux()

  if (isLinux) {
    if (CPU_ARCH === 'x64' || CPU_ARCH === 'x86_64') {
      return 'linux-x86_64'
    } else if (CPU_ARCH === 'arm64' || CPU_ARCH === 'aarch64') {
      return 'linux-aarch64'
    }
  } else if (isWindows) {
    return 'windows-x86_64'
  } else if (isMacOS) {
    if (CPU_ARCH === 'arm64') {
      return 'macos-arm64'
    } else {
      return 'macos-x86_64'
    }
  }

  throw new Error(`Unsupported platform: ${OS_TYPE} ${CPU_ARCH}`)
}

/**
 * Get PyTorch wheel download URL based on platform
 */
function getPyTorchDownloadURL(version) {
  const platform = getPyTorchPlatform()

  const urls = {
    'linux-x86_64': `https://download.pytorch.org/whl/cu129/torch-${version}%2Bcu129-cp311-cp311-manylinux_2_28_x86_64.whl`,
    'linux-aarch64': `https://download.pytorch.org/whl/cu129/torch-${version}%2Bcu129-cp311-cp311-manylinux_2_28_aarch64.whl`,
    'windows-x86_64': `https://download.pytorch.org/whl/cu129/torch-${version}%2Bcu129-cp311-cp311-win_amd64.whl`,
    'macos-arm64': `https://download.pytorch.org/whl/cpu/torch-${version}-cp311-none-macosx_11_0_arm64.whl`,
    // Use 2.2.0 as it is the latest available pre-built package for Python 3.11
    'macos-x86_64': 'https://download.pytorch.org/whl/cpu/torch-2.2.0-cp311-none-macosx_10_9_x86_64.whl'
  }

  const url = urls[platform]
  if (!url) {
    throw new Error(`No PyTorch wheel available for platform: ${platform}`)
  }

  return url
}

/**
 * Read manifest file to get installed version
 */
function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return null
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf-8')

    return JSON.parse(content)
  } catch {
    return null
  }
}

/**
 * Install PyTorch wheel if needed
 */
async function installPyTorch(requiredVersion, targetPath, manifestPath) {
  const manifest = readManifest(manifestPath)
  const installedVersion = manifest?.version

  if (installedVersion) {
    LogHelper.info(`Found PyTorch ${installedVersion}`)
    LogHelper.info(`Latest version is ${requiredVersion}`)
  }

  if (!manifest || manifest.version !== requiredVersion) {
    const wheelPath = path.join(PYTORCH_PATH, `torch-${requiredVersion}.whl`)

    // Clean up old version
    await fs.promises.rm(targetPath, { recursive: true, force: true })
    await fs.promises.rm(wheelPath, { force: true })

    // Create target directory
    await fs.promises.mkdir(targetPath, { recursive: true })

    try {
      const downloadURL = getPyTorchDownloadURL(requiredVersion)

      LogHelper.info(`Downloading PyTorch ${requiredVersion}...`)

      await FileHelper.downloadFile(downloadURL, wheelPath, {
        cliProgress: true,
        parallelStreams: 3,
        skipExisting: false
      })

      LogHelper.success('PyTorch downloaded')
      LogHelper.info('Extracting PyTorch wheel...')

      // Extract wheel (wheels are just ZIP files)
      await FileHelper.extractArchive(wheelPath, targetPath, {
        stripComponents: 0
      })

      LogHelper.success('PyTorch extracted')

      // Clean up and create manifest
      await Promise.all([
        fs.promises.rm(wheelPath, { force: true }),
        FileHelper.createManifestFile(manifestPath, 'torch', requiredVersion, {
          os: SystemHelper.getInformation().type,
          architecture: SystemHelper.getInformation().cpuArchitecture
        })
      ])

      LogHelper.success('PyTorch manifest file created')

      if (!SystemHelper.isMacOS()) {
        await ensureDirectoryLink(PYTORCH_NVIDIA_PATH, NVIDIA_LIBS_PATH)
      }

      LogHelper.success(`PyTorch ${requiredVersion} ready`)
    } catch (error) {
      LogHelper.error(`Failed to install PyTorch: ${error}`)
      LogHelper.warning(
        'PyTorch may require manual download from PyTorch website'
      )
      LogHelper.warning(
        'Please visit: https://pytorch.org/get-started/locally/'
      )

      throw error
    }
  } else {
    LogHelper.success(
      `PyTorch is already at the latest version (${requiredVersion})`
    )
  }
}

/**
 * Main setup function
 */
async function setupPyTorch() {
  LogHelper.info('Downloading and setting up PyTorch...')

  try {
    await installPyTorch(
      PYTORCH_VERSION,
      PYTORCH_TORCH_PATH,
      PYTORCH_MANIFEST_PATH
    )

    if (!SystemHelper.isMacOS()) {
      await ensureDirectoryLink(PYTORCH_NVIDIA_PATH, NVIDIA_LIBS_PATH)
    }

    LogHelper.success(`PyTorch setup complete in: ${PYTORCH_TORCH_PATH}`)
  } catch (error) {
    LogHelper.error(`PyTorch setup failed: ${error}`)
    process.exit(1)
  }
}

export default setupPyTorch
