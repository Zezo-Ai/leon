import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { command } from 'execa'

import {
  PNPM_RUNTIME_BIN_PATH,
  PYTHON_RUNTIME_BIN_PATH,
  UV_RUNTIME_BIN_PATH
} from '@/constants'
import {
  buildShellCommand,
  getNodejsSkillRuntimeNodeModulesPath,
  getPythonSkillRuntimeVendorPath,
  getSkillRuntimePath
} from '@/helpers/runtime-helper'
import { LogHelper } from '@/helpers/log-helper'

const SYNC_STAMP_FILE_NAME = '.last-skill-deps-sync'
const PYTHON_DEPENDENCY_MANIFESTS = [
  'requirements.txt',
  'Pipfile',
  'pyproject.toml'
]

/**
 * Stamp files let setup stay cheap on repeated boots while still re-syncing as
 * soon as a skill dependency manifest changes.
 */
const getSyncStampPath = (skillPath) => {
  return path.join(getSkillRuntimePath(skillPath), SYNC_STAMP_FILE_NAME)
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
  await fs.promises.mkdir(getSkillRuntimePath(skillPath), { recursive: true })
  await fs.promises.writeFile(getSyncStampPath(skillPath), `${Date.now()}`)
}

/**
 * Python skills can declare dependencies through a few common manifest styles.
 * Setup only needs the first one present in the skill source tree.
 */
const getPythonManifestPath = (skillSRCPath) => {
  for (const manifestName of PYTHON_DEPENDENCY_MANIFESTS) {
    const manifestPath = path.join(skillSRCPath, manifestName)

    if (fs.existsSync(manifestPath)) {
      return manifestPath
    }
  }

  return null
}

/**
 * Node skill dependencies stay inside the skill runtime directory so they do
 * not leak into Leon core dependencies or other skills.
 */
const syncNodejsSkillDependencies = async (skillFriendlyName, skillPath) => {
  const skillSRCPath = path.join(skillPath, 'src')
  const packageJSONPath = path.join(skillSRCPath, 'package.json')
  const runtimePath = getSkillRuntimePath(skillPath)
  const nodeModulesPath = getNodejsSkillRuntimeNodeModulesPath(skillPath)

  if (!fs.existsSync(packageJSONPath) || (await isFileEmpty(packageJSONPath))) {
    return
  }

  if (await isSyncCurrent(skillPath, packageJSONPath)) {
    LogHelper.success(
      `"${skillFriendlyName}" skill dependencies are up-to-date`
    )

    return
  }

  LogHelper.info(
    `Syncing dependencies for the "${skillFriendlyName}" skill...`
  )

  await fs.promises.mkdir(runtimePath, { recursive: true })
  await fs.promises.rm(nodeModulesPath, { recursive: true, force: true })

  await command(
    buildShellCommand(PNPM_RUNTIME_BIN_PATH, [
      'install',
      '--dir',
      skillSRCPath,
      '--modules-dir',
      nodeModulesPath,
      '--lockfile=false'
    ]),
    { shell: true }
  )

  await markSkillDependenciesAsSynced(skillPath)

  LogHelper.success(`"${skillFriendlyName}" skill dependencies synced`)
}

/**
 * Vendor Python requirements into the skill itself so each skill remains
 * portable and isolated from the bridge-wide Python environment.
 */
const installPythonRequirements = async (manifestPath, vendorPath) => {
  await command(
    buildShellCommand(UV_RUNTIME_BIN_PATH, [
      'pip',
      'install',
      '--python',
      PYTHON_RUNTIME_BIN_PATH,
      '--target',
      vendorPath,
      '-r',
      manifestPath
    ]),
    { shell: true }
  )
}

/**
 * `pyproject.toml` skills are installed as local Python projects into the same
 * vendored target directory used by requirements-based skills.
 */
const installPythonProject = async (skillSRCPath, vendorPath) => {
  await command(
    buildShellCommand(UV_RUNTIME_BIN_PATH, [
      'pip',
      'install',
      '--python',
      PYTHON_RUNTIME_BIN_PATH,
      '--target',
      vendorPath,
      skillSRCPath
    ]),
    { shell: true }
  )
}

/**
 * Python skill dependencies are always re-installed into a fresh vendor
 * directory so stale packages do not survive a version update.
 */
const syncPythonSkillDependencies = async (skillFriendlyName, skillPath) => {
  const skillSRCPath = path.join(skillPath, 'src')
  const manifestPath = getPythonManifestPath(skillSRCPath)

  if (!manifestPath) {
    return
  }

  if (await isSyncCurrent(skillPath, manifestPath)) {
    LogHelper.success(
      `"${skillFriendlyName}" skill dependencies are up-to-date`
    )

    return
  }

  LogHelper.info(
    `Syncing dependencies for the "${skillFriendlyName}" skill...`
  )

  const runtimePath = getSkillRuntimePath(skillPath)
  const vendorPath = getPythonSkillRuntimeVendorPath(skillPath)
  const manifestName = path.basename(manifestPath)

  await fs.promises.mkdir(runtimePath, { recursive: true })
  await fs.promises.rm(vendorPath, { recursive: true, force: true })
  await fs.promises.mkdir(vendorPath, { recursive: true })

  if (manifestName === 'requirements.txt') {
    await installPythonRequirements(manifestPath, vendorPath)
  } else if (manifestName === 'Pipfile') {
    // Convert Pipfile definitions into a temporary requirements file so the
    // actual install path still goes through the same uv vendor flow.
    const requirementsOutput = await command('pipenv requirements', {
      shell: true,
      cwd: skillSRCPath,
      env: {
        ...process.env,
        PIPENV_PIPFILE: manifestPath
      }
    })
    const tempRequirementsPath = path.join(
      os.tmpdir(),
      `${path.basename(skillPath)}-${Date.now()}.requirements.txt`
    )

    try {
      await fs.promises.writeFile(tempRequirementsPath, requirementsOutput.stdout)
      await installPythonRequirements(tempRequirementsPath, vendorPath)
    } finally {
      await fs.promises.rm(tempRequirementsPath, { force: true })
    }
  } else {
    await installPythonProject(skillSRCPath, vendorPath)
  }

  await markSkillDependenciesAsSynced(skillPath)

  LogHelper.success(`"${skillFriendlyName}" skill dependencies synced`)
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
