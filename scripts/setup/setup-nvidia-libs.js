import fs from 'node:fs'
import path from 'node:path'

import {
  NVIDIA_LIBS_PATH,
  NVIDIA_CUBLAS_PATH,
  NVIDIA_CUDNN_PATH,
  NVIDIA_CUSPARSE_PATH,
  NVIDIA_CUSPARSE_FULL_PATH,
  NVIDIA_NCCL_PATH,
  NVIDIA_NVSHMEM_PATH,
  NVIDIA_NVJITLINK_PATH,
  NVIDIA_CUBLAS_MANIFEST_PATH,
  NVIDIA_CUDNN_MANIFEST_PATH,
  NVIDIA_CUSPARSE_MANIFEST_PATH,
  NVIDIA_CUSPARSE_FULL_MANIFEST_PATH,
  NVIDIA_NCCL_MANIFEST_PATH,
  NVIDIA_NVSHMEM_MANIFEST_PATH,
  NVIDIA_NVJITLINK_MANIFEST_PATH,
  NVIDIA_CUDA_VERSION,
  NVIDIA_CUBLAS_VERSION,
  NVIDIA_CUDNN_VERSION,
  NVIDIA_CUSPARSE_VERSION,
  NVIDIA_CUSPARSE_FULL_VERSION,
  NVIDIA_NCCL_VERSION,
  NVIDIA_NVSHMEM_VERSION,
  NVIDIA_NVJITLINK_VERSION
} from '@/constants'
import { FileHelper } from '@/helpers/file-helper'
import { SystemHelper } from '@/helpers/system-helper'
import { LogHelper } from '@/helpers/log-helper'

const { type: OS_TYPE, cpuArchitecture: CPU_ARCH } =
  SystemHelper.getInformation()

/**
 * Map CPU architecture to NVIDIA's architecture naming convention
 */
function mapToNvidiaArch(cpuArch) {
  // Map Node.js process.arch values to NVIDIA naming
  if (cpuArch === 'arm64' || cpuArch === 'aarch64') {
    return 'aarch64'
  }
  if (cpuArch === 'x64' || cpuArch === 'x86_64') {
    return 'x86_64'
  }

  return 'x86_64'
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
 * Get download URL for NVIDIA libraries
 */
function getNVIDIADownloadURL(library, version) {
  const ext = SystemHelper.isWindows() ? 'zip' : 'tar.xz'
  const arch = mapToNvidiaArch(CPU_ARCH)

  // NVIDIA CDN URLs for CUDA libraries and more
  if (library === 'cublas') {
    return `https://developer.download.nvidia.com/compute/cuda/redist/libcublas/${OS_TYPE}-${arch}/libcublas-${OS_TYPE}-${arch}-${version}-archive.${ext}`
  } else if (library === 'cudnn') {
    return `https://developer.download.nvidia.com/compute/cudnn/redist/cudnn/${OS_TYPE}-${arch}/cudnn-${OS_TYPE}-${arch}-${version}_cuda${NVIDIA_CUDA_VERSION}-archive.${ext}`
  } else if (library === 'cusparse') {
    return `https://developer.download.nvidia.com/compute/cusparselt/redist/libcusparse_lt/${OS_TYPE}-${arch}/libcusparse_lt-${OS_TYPE}-${arch}-${version}_cuda${NVIDIA_CUDA_VERSION}-archive.${ext}`
  } else if (library === 'cusparse_full') {
    return `https://developer.download.nvidia.com/compute/cuda/redist/libcusparse/${OS_TYPE}-${arch}/libcusparse-${OS_TYPE}-${arch}-${version}-archive.${ext}`
  } else if (library === 'nccl') {
    // NCCL is only available on Linux x86_64
    if (!SystemHelper.isLinux() || arch !== 'x86_64') {
      throw new Error('NCCL is only available on Linux x86_64')
    }

    return `https://developer.download.nvidia.com/compute/nccl/redist/nccl/${OS_TYPE}-${arch}/nccl-${OS_TYPE}-${arch}-${version}-archive.${ext}`
  } else if (library === 'nvshmem') {
    // NVSHMEM is only available on Linux x86_64
    if (!SystemHelper.isLinux() || arch !== 'x86_64') {
      throw new Error('NVSHMEM is only available on Linux x86_64')
    }

    return `https://developer.download.nvidia.com/compute/nvshmem/redist/libnvshmem/${OS_TYPE}-${arch}/libnvshmem-${OS_TYPE}-${arch}-${version}_cuda${NVIDIA_CUDA_VERSION}-archive.${ext}`
  } else if (library === 'nvjitlink') {
    return `https://developer.download.nvidia.com/compute/cuda/redist/libnvjitlink/${OS_TYPE}-${arch}/libnvjitlink-${OS_TYPE}-${arch}-${version}-archive.${ext}`
  }
}

/**
 * Install NVIDIA libraries if needed
 */
async function installNVIDIALibrary(
  library,
  requiredVersion,
  targetPath,
  manifestPath
) {
  const manifest = readManifest(manifestPath)
  const installedVersion = manifest?.version

  if (installedVersion) {
    LogHelper.info(`Found ${library} ${installedVersion}`)
    LogHelper.info(`Latest version is ${requiredVersion}`)
  }

  if (!manifest || manifest.version !== requiredVersion) {
    const ext = SystemHelper.isWindows() ? 'zip' : 'tar.xz'
    const archivePath = path.join(
      NVIDIA_LIBS_PATH,
      `${library}-${requiredVersion}.${ext}`
    )

    // Clean up old version
    await fs.promises.rm(targetPath, { recursive: true, force: true })
    await fs.promises.rm(archivePath, { force: true })

    // Create target directory
    await fs.promises.mkdir(targetPath, { recursive: true })

    try {
      const downloadURL = getNVIDIADownloadURL(library, requiredVersion)

      LogHelper.info(`Downloading ${library}...`)

      await FileHelper.downloadFile(downloadURL, archivePath, {
        cliProgress: true,
        parallelStreams: 3,
        skipExisting: false
      })

      LogHelper.success(`${library} downloaded`)
      LogHelper.info(`Extracting ${library}...`)

      // Extract archive using unified method
      await FileHelper.extractArchive(archivePath, targetPath, {
        stripComponents: 1
      })

      LogHelper.success(`${library} extracted`)

      // Clean up and create manifest
      await Promise.all([
        fs.promises.rm(archivePath, { force: true }),
        FileHelper.createManifestFile(manifestPath, library, requiredVersion, {
          os: SystemHelper.getInformation().type,
          architecture: SystemHelper.getInformation().cpuArchitecture
        })
      ])

      LogHelper.success(`${library} manifest file created`)
      LogHelper.success(`${library} ${requiredVersion} ready`)
    } catch (error) {
      LogHelper.error(`Failed to install ${library}: ${error}`)
      LogHelper.warning(
        'CUDA libraries may require manual download from NVIDIA website'
      )
      LogHelper.warning(
        'Please visit: https://developer.nvidia.com/cuda-downloads'
      )

      throw error
    }
  } else {
    LogHelper.success(
      `${library} is already at the latest version (${requiredVersion})`
    )
  }
}

/**
 * Main setup function
 */
async function setupNVIDIALibs() {
  // Skip on macOS since there is no CUDA involved
  if (SystemHelper.isMacOS()) {
    return
  }

  LogHelper.info('Downloading and setting up CUDA runtime...')

  try {
    const { getLlama, LlamaLogLevel } = await Function(
      'return import("node-llama-cpp")'
    )()
    const llama = await getLlama({
      logLevel: LlamaLogLevel.disabled
    })

    const hasGPU = await SystemHelper.hasGPU(llama)

    if (!hasGPU) {
      LogHelper.info('No GPU detected. Skipping CUDA runtime setup')
      return
    }

    // Install/update cuBLAS
    await installNVIDIALibrary(
      'cublas',
      NVIDIA_CUBLAS_VERSION,
      NVIDIA_CUBLAS_PATH,
      NVIDIA_CUBLAS_MANIFEST_PATH
    )

    // Install/update cuDNN
    await installNVIDIALibrary(
      'cudnn',
      NVIDIA_CUDNN_VERSION,
      NVIDIA_CUDNN_PATH,
      NVIDIA_CUDNN_MANIFEST_PATH
    )

    // Install/update cuSPARSE-Lt (Linux only, both x86_64 and aarch64)
    if (SystemHelper.isLinux()) {
      try {
        await installNVIDIALibrary(
          'cusparse',
          NVIDIA_CUSPARSE_VERSION,
          NVIDIA_CUSPARSE_PATH,
          NVIDIA_CUSPARSE_MANIFEST_PATH
        )
      } catch (error) {
        LogHelper.warning(`cuSPARSE-Lt installation skipped: ${error.message}`)
      }
    }

    // Install/update cuSPARSE (Linux only, both x86_64 and aarch64)
    if (SystemHelper.isLinux()) {
      try {
        await installNVIDIALibrary(
          'cusparse_full',
          NVIDIA_CUSPARSE_FULL_VERSION,
          NVIDIA_CUSPARSE_FULL_PATH,
          NVIDIA_CUSPARSE_FULL_MANIFEST_PATH
        )
      } catch (error) {
        LogHelper.warning(`cuSPARSE installation skipped: ${error.message}`)
      }
    }

    // Install/update nvJitLink (Linux only)
    if (SystemHelper.isLinux()) {
      try {
        await installNVIDIALibrary(
          'nvjitlink',
          NVIDIA_NVJITLINK_VERSION,
          NVIDIA_NVJITLINK_PATH,
          NVIDIA_NVJITLINK_MANIFEST_PATH
        )
      } catch (error) {
        LogHelper.warning(`nvJitLink installation skipped: ${error.message}`)
      }
    }

    // Install/update NCCL (Linux x86_64 only)
    if (SystemHelper.isLinux() && mapToNvidiaArch(CPU_ARCH) === 'x86_64') {
      try {
        await installNVIDIALibrary(
          'nccl',
          NVIDIA_NCCL_VERSION,
          NVIDIA_NCCL_PATH,
          NVIDIA_NCCL_MANIFEST_PATH
        )
      } catch (error) {
        LogHelper.warning(`NCCL installation skipped: ${error.message}`)
      }
    }

    // Install/update NVSHMEM (Linux x86_64 only)
    if (SystemHelper.isLinux() && mapToNvidiaArch(CPU_ARCH) === 'x86_64') {
      try {
        await installNVIDIALibrary(
          'nvshmem',
          NVIDIA_NVSHMEM_VERSION,
          NVIDIA_NVSHMEM_PATH,
          NVIDIA_NVSHMEM_MANIFEST_PATH
        )
      } catch (error) {
        LogHelper.warning(`NVSHMEM installation skipped: ${error.message}`)
      }
    }

    LogHelper.success(`NVIDIA libraries setup complete in: ${NVIDIA_LIBS_PATH}`)
  } catch (error) {
    LogHelper.error(`NVIDIA libraries setup failed: ${error}`)
    process.exit(1)
  }
}

export default setupNVIDIALibs
