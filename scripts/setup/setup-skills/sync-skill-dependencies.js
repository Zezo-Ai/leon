import fs from 'node:fs'
import path from 'node:path'

import execa from 'execa'

import {
  PNPM_RUNTIME_BIN_PATH,
  PYTHON_RUNTIME_BIN_PATH,
  UV_RUNTIME_BIN_PATH
} from '@/constants'
import { RuntimeHelper } from '@/helpers/runtime-helper'

import { getPyprojectDependencies } from '../setup-python-project-env'

const SYNC_STAMP_FILE_NAME = '.last-skill-deps-sync'

/**
 * Stamp files let setup stay cheap on repeated boots while still re-syncing as
 * soon as a skill dependency manifest changes.
 */
const getSyncStampPath = (skillPath) => {
  return path.join(
    RuntimeHelper.getSkillRuntimePath(skillPath),
    SYNC_STAMP_FILE_NAME
  )
}

const isFileEmpty = async (filePath) => {
  const content = await fs.promises.readFile(filePath, 'utf8')
  return content.trim() === ''
}

const isSyncCurrent = async (skillPath, manifestPath) => {
  const stampPath = getSyncStampPath(skillPath)

  if (!fs.existsSync(stampPath) || !fs.existsSync(manifestPath)) {
    return false
  }

  const [stampStat, manifestStat] = await Promise.all([
    fs.promises.stat(stampPath),
    fs.promises.stat(manifestPath)
  ])

  return manifestStat.mtimeMs <= stampStat.mtimeMs
}

/**
 * Mark the skill as synced after a successful dependency install/update.
 */
const markSkillDependenciesAsSynced = async (skillPath) => {
  await fs.promises.mkdir(RuntimeHelper.getSkillRuntimePath(skillPath), {
    recursive: true
  })
  await fs.promises.writeFile(getSyncStampPath(skillPath), `${Date.now()}`)
}

/**
 * Node skill dependencies stay inside the skill runtime directory so they do
 * not leak into Leon core dependencies or other skills.
 */
const syncNodejsSkillDependencies = async (skillFriendlyName, skillPath) => {
  const skillSRCPath = path.join(skillPath, 'src')
  const packageJSONPath = path.join(skillSRCPath, 'package.json')
  const runtimePath = RuntimeHelper.getSkillRuntimePath(skillPath)
  const nodeModulesPath =
    RuntimeHelper.getNodejsSkillRuntimeNodeModulesPath(skillPath)
  const runtimePackageJSONPath = path.join(runtimePath, 'package.json')

  if (!fs.existsSync(packageJSONPath) || (await isFileEmpty(packageJSONPath))) {
    return
  }

  if (await isSyncCurrent(skillPath, packageJSONPath)) {
    return
  }

  await fs.promises.mkdir(runtimePath, { recursive: true })
  await fs.promises.rm(nodeModulesPath, { recursive: true, force: true })
  await fs.promises.copyFile(packageJSONPath, runtimePackageJSONPath)

  // Install from the runtime directory itself so pnpm does not create importer
  // metadata under the skill source tree.
  await execa(PNPM_RUNTIME_BIN_PATH, [
      'install',
      '--ignore-workspace',
      '--lockfile=false'
    ], { cwd: runtimePath })

  await markSkillDependenciesAsSynced(skillPath)
}

/**
 * Vendor Python dependencies into the skill itself so each skill remains
 * portable and isolated from the bridge-wide Python environment.
 */
const installPythonDependencies = async (dependencies, vendorPath) => {
  await execa(UV_RUNTIME_BIN_PATH, [
      'pip',
      'install',
      '--python',
      PYTHON_RUNTIME_BIN_PATH,
      '--target',
      vendorPath,
      ...dependencies
    ])
}

/**
 * Python skill dependencies are always re-installed into a fresh vendor
 * directory so stale packages do not survive a version update.
 */
const syncPythonSkillDependencies = async (skillFriendlyName, skillPath) => {
  const skillSRCPath = path.join(skillPath, 'src')
  const manifestPath = path.join(skillSRCPath, 'pyproject.toml')

  if (!fs.existsSync(manifestPath)) {
    return
  }

  if (await isSyncCurrent(skillPath, manifestPath)) {
    return
  }

  const runtimePath = RuntimeHelper.getSkillRuntimePath(skillPath)
  const vendorPath = RuntimeHelper.getPythonSkillRuntimeVendorPath(skillPath)
  const dependencies = await getPyprojectDependencies(skillSRCPath)

  await fs.promises.mkdir(runtimePath, { recursive: true })
  await fs.promises.rm(vendorPath, { recursive: true, force: true })
  await fs.promises.mkdir(vendorPath, { recursive: true })

  if (dependencies.length > 0) {
    await installPythonDependencies(dependencies, vendorPath)
  }

  await markSkillDependenciesAsSynced(skillPath)
}

/**
 * Sync skill dependencies only when a skill is installed, updated, or its
 * dependency manifest changes.
 */
export default async function syncSkillDependencies(
  skillFriendlyName,
  currentSkill
) {
  if (currentSkill.bridge === 'nodejs') {
    await syncNodejsSkillDependencies(skillFriendlyName, currentSkill.path)

    return
  }

  if (currentSkill.bridge === 'python') {
    await syncPythonSkillDependencies(skillFriendlyName, currentSkill.path)
  }
}
