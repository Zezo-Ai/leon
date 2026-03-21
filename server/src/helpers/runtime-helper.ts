import fs from 'node:fs'
import path from 'node:path'

import { SystemHelper } from '@/helpers/system-helper'

const BIN_PATH = path.join(process.cwd(), 'bin')
const IS_WINDOWS = SystemHelper.isWindows()

/**
 * Pick the first runtime candidate that already exists on disk.
 */
const firstExistingPath = (candidates: string[]): string | null => {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

/**
 * Resolve a runtime executable from an explicit env override, Leon-managed
 * portable binaries, then a system fallback.
 */
const resolveExecutable = (
  envVarName: string,
  candidates: string[],
  fallback: string
): string => {
  const envValue = process.env[envVarName]?.trim()

  if (envValue) {
    return envValue
  }

  return firstExistingPath(candidates) || fallback
}

/**
 * Quote shell arguments because several runtime paths can contain spaces,
 * especially in desktop install locations.
 */
const escapeShellArgument = (value: string): string => {
  return `"${value.replaceAll('"', '\\"')}"`
}

export const NODE_BIN_PATH = resolveExecutable(
  'LEON_NODE_PATH',
  [
    path.join(
      BIN_PATH,
      'node',
      IS_WINDOWS ? 'node.exe' : 'node'
    ),
    path.join(
      BIN_PATH,
      'node',
      'bin',
      IS_WINDOWS ? 'node.exe' : 'node'
    )
  ],
  process.execPath
)

export const PNPM_BIN_PATH = resolveExecutable(
  'LEON_PNPM_PATH',
  [
    path.join(BIN_PATH, 'pnpm', IS_WINDOWS ? 'pnpm.exe' : 'pnpm'),
    path.join(
      BIN_PATH,
      'pnpm',
      IS_WINDOWS ? 'pnpm.cmd' : 'pnpm'
    ),
    path.join(
      BIN_PATH,
      'pnpm',
      'bin',
      IS_WINDOWS ? 'pnpm.cmd' : 'pnpm'
    )
  ],
  'pnpm'
)

export const PYTHON_BIN_PATH = resolveExecutable(
  'LEON_PYTHON_PATH',
  [
    path.join(
      BIN_PATH,
      'python',
      IS_WINDOWS ? 'python.exe' : 'python'
    ),
    path.join(BIN_PATH, 'python', 'bin', 'python3'),
    path.join(BIN_PATH, 'python', 'bin', 'python')
  ],
  IS_WINDOWS ? 'python' : 'python3'
)

export const UV_BIN_PATH = resolveExecutable(
  'LEON_UV_PATH',
  [
    path.join(
      BIN_PATH,
      'uv',
      IS_WINDOWS ? 'uv.exe' : 'uv'
    ),
    path.join(
      BIN_PATH,
      'uv',
      'bin',
      IS_WINDOWS ? 'uv.exe' : 'uv'
    )
  ],
  'uv'
)

/**
 * Prefer a project-local virtual environment when available so bridge and TCP
 * server commands keep using the Python environment they were installed into.
 */
export const resolveProjectPythonBinPath = (projectRootPath: string): string => {
  const venvBinPath = path.join(projectRootPath, '.venv')
  const venvCandidates = [
    path.join(
      venvBinPath,
      IS_WINDOWS ? 'Scripts' : 'bin',
      IS_WINDOWS ? 'python.exe' : 'python'
    ),
    path.join(
      venvBinPath,
      IS_WINDOWS ? 'Scripts' : 'bin',
      'python3'
    )
  ]

  return firstExistingPath(venvCandidates) || PYTHON_BIN_PATH
}

/**
 * Keep skill-owned runtime artifacts out of `src` so install/update can clean
 * them up independently from skill source files.
 */
export const getSkillRuntimePath = (skillPath: string): string => {
  return path.join(skillPath, '.runtime')
}

export const getNodejsSkillRuntimeNodeModulesPath = (
  skillPath: string
): string => {
  return path.join(getSkillRuntimePath(skillPath), 'node_modules')
}

export const getPythonSkillRuntimeVendorPath = (skillPath: string): string => {
  return path.join(getSkillRuntimePath(skillPath), 'vendor')
}

/**
 * Build a shell-safe command string for execa/spawn call sites that currently
 * rely on `shell: true`.
 */
export const buildShellCommand = (
  executablePath: string,
  args: string[] = []
): string => {
  return [executablePath, ...args].map(escapeShellArgument).join(' ')
}
