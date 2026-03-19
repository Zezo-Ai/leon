import fs from 'node:fs'
import path from 'node:path'

import { CPUArchitectures } from '@/types'
import {
  NINJA_BIN_PATH,
  NINJA_INSTALL_PATH,
  NINJA_MANIFEST_PATH,
  NINJA_PATH,
  NINJA_VERSION
} from '@/constants'
import { FileHelper } from '@/helpers/file-helper'
import { LogHelper } from '@/helpers/log-helper'
import { SystemHelper } from '@/helpers/system-helper'

/**
 * Download and set up Leon-managed Ninja
 * 1. Resolve the pinned version from versions.json
 * 2. Download the matching Linux archive for the current architecture
 * 3. Extract it into bin/ninja/ninja/
 * 4. Always use this Ninja binary for local source builds
 */

const { cpuArchitecture: CPU_ARCH } = SystemHelper.getInformation()

function readManifest() {
  if (!fs.existsSync(NINJA_MANIFEST_PATH)) {
    return null
  }

  try {
    return JSON.parse(fs.readFileSync(NINJA_MANIFEST_PATH, 'utf8'))
  } catch {
    return null
  }
}

async function cleanInstallDirectory() {
  await fs.promises.mkdir(NINJA_PATH, { recursive: true })

  const entries = await fs.promises.readdir(NINJA_PATH, {
    withFileTypes: true
  })

  await Promise.all(
    entries
      .filter((entry) => entry.name !== 'versions.json')
      .map((entry) =>
        fs.promises.rm(path.join(NINJA_PATH, entry.name), {
          recursive: true,
          force: true
        })
      )
  )
}

function getDownloadURL() {
  if (CPU_ARCH === CPUArchitectures.X64) {
    return `https://github.com/ninja-build/ninja/releases/download/v${NINJA_VERSION}/ninja-linux.zip`
  }

  if (CPU_ARCH === CPUArchitectures.ARM64) {
    return `https://github.com/ninja-build/ninja/releases/download/v${NINJA_VERSION}/ninja-linux-aarch64.zip`
  }

  throw new Error(`Unsupported Linux architecture for Ninja: ${CPU_ARCH}`)
}

export default async function setupNinja() {
  if (!SystemHelper.isLinux()) {
    return
  }

  LogHelper.info('Downloading and setting up Ninja...')

  const manifest = readManifest()

  if (manifest?.version === NINJA_VERSION && fs.existsSync(NINJA_BIN_PATH)) {
    LogHelper.success(`Ninja is already at the latest version (${NINJA_VERSION})`)

    return
  }

  const archivePath = path.join(NINJA_PATH, `ninja-${NINJA_VERSION}.zip`)

  await cleanInstallDirectory()

  try {
    LogHelper.info(`Downloading Ninja ${NINJA_VERSION}...`)

    await FileHelper.downloadFile(getDownloadURL(), archivePath, {
      cliProgress: true,
      parallelStreams: 3,
      skipExisting: false
    })

    LogHelper.success('Ninja downloaded')
    LogHelper.info('Extracting Ninja...')

    await FileHelper.extractArchive(archivePath, NINJA_INSTALL_PATH)
    await fs.promises.chmod(NINJA_BIN_PATH, 0o755)

    if (!fs.existsSync(NINJA_BIN_PATH)) {
      throw new Error(`Cannot find Ninja binary at "${NINJA_BIN_PATH}"`)
    }

    await Promise.all([
      fs.promises.rm(archivePath, { force: true }),
      FileHelper.createManifestFile(NINJA_MANIFEST_PATH, 'ninja', NINJA_VERSION, {
        os: SystemHelper.getInformation().type,
        architecture: SystemHelper.getInformation().cpuArchitecture
      })
    ])

    LogHelper.success(`Ninja ${NINJA_VERSION} ready`)
  } catch (error) {
    await fs.promises.rm(archivePath, { force: true })
    throw new Error(`Failed to set up Ninja: ${error}`)
  }
}
