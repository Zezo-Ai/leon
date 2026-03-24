import fs from 'node:fs'
import path from 'node:path'

import { command } from 'execa'

import {
  PYTHON_RUNTIME_BIN_PATH,
  UV_RUNTIME_BIN_PATH
} from '@/constants'
import { RuntimeHelper } from '@/helpers/runtime-helper'
import { SystemHelper } from '@/helpers/system-helper'

import { createSetupStatus } from './setup-status'

const PYPROJECT_FILE_NAME = 'pyproject.toml'

/**
 * Read the dependency list from a Python project's `pyproject.toml` using the
 * managed Python runtime and the standard-library `tomllib` parser.
 */
export async function getPyprojectDependencies(projectPath) {
  const pyprojectPath = path.join(projectPath, PYPROJECT_FILE_NAME)

  if (!fs.existsSync(pyprojectPath)) {
    return []
  }

  const readerScript = [
    'import json',
    'import sys',
    'import tomllib',
    'from pathlib import Path',
    'data = tomllib.loads(Path(sys.argv[1]).read_text())',
    'deps = data.get("project", {}).get("dependencies", [])',
    'print(json.dumps(deps))'
  ].join('; ')

  const result = await command(
    RuntimeHelper.buildShellCommand(PYTHON_RUNTIME_BIN_PATH, [
      '-c',
      readerScript,
      pyprojectPath
    ]),
    { shell: true }
  )

  return JSON.parse(result.stdout)
}

/**
 * Resolve the Python executable path inside a project-local `.venv`.
 */
function getProjectVenvPythonPath(projectPath) {
  return path.join(
    projectPath,
    '.venv',
    SystemHelper.isWindows() ? 'Scripts' : 'bin',
    SystemHelper.isWindows() ? 'python.exe' : 'python'
  )
}

/**
 * Check whether a project dependency sync stamp is newer than its manifest.
 */
async function isSyncCurrent(projectPath, stampFileName) {
  const pyprojectPath = path.join(projectPath, PYPROJECT_FILE_NAME)
  const stampPath = path.join(projectPath, stampFileName)

  if (!fs.existsSync(pyprojectPath) || !fs.existsSync(stampPath)) {
    return false
  }

  const [manifestStat, stampStat] = await Promise.all([
    fs.promises.stat(pyprojectPath),
    fs.promises.stat(stampPath)
  ])

  return manifestStat.mtimeMs <= stampStat.mtimeMs
}

/**
 * Create or refresh a project-local `.venv` and install dependencies declared
 * in `pyproject.toml` through Leon's managed `uv` and Python runtimes.
 */
export async function setupPythonProjectEnv({
  name,
  projectPath,
  stampFileName
}) {
  const status = createSetupStatus(`Setting up ${name} dependencies...`).start()
  const pyprojectPath = path.join(projectPath, PYPROJECT_FILE_NAME)
  const stampPath = path.join(projectPath, stampFileName)
  const venvPath = path.join(projectPath, '.venv')

  if (!fs.existsSync(pyprojectPath)) {
    status.pause()
    return
  }

  if (await isSyncCurrent(projectPath, stampFileName)) {
    status.succeed(`${name}: up-to-date`)

    return
  }

  const dependencies = await getPyprojectDependencies(projectPath)

  await fs.promises.rm(venvPath, { recursive: true, force: true })

  await command(
    RuntimeHelper.buildShellCommand(UV_RUNTIME_BIN_PATH, [
      'venv',
      '--python',
      PYTHON_RUNTIME_BIN_PATH,
      venvPath
    ]),
    {
      shell: true,
      cwd: projectPath
    }
  )

  if (dependencies.length > 0) {
    await command(
      RuntimeHelper.buildShellCommand(UV_RUNTIME_BIN_PATH, [
        'pip',
        'install',
        '--python',
        getProjectVenvPythonPath(projectPath),
        ...dependencies
      ]),
      {
        shell: true,
        cwd: projectPath
      }
    )
  }

  await fs.promises.writeFile(stampPath, `${Date.now()}`)

  status.succeed(`${name}: ready`)
}
