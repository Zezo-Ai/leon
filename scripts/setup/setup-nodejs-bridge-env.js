import fs from 'node:fs'
import path from 'node:path'

import { command } from 'execa'

import {
  NODEJS_BRIDGE_ROOT_PATH,
  PNPM_RUNTIME_BIN_PATH
} from '@/constants'
import { RuntimeHelper } from '@/helpers/runtime-helper'

import { createSetupStatus } from './setup-status'

const STAMP_FILE_PATH = path.join(
  NODEJS_BRIDGE_ROOT_PATH,
  '.last-nodejs-bridge-deps-sync'
)
const PACKAGE_JSON_PATH = path.join(NODEJS_BRIDGE_ROOT_PATH, 'package.json')

/**
 * Re-sync the bridge only when its own dependency manifest changed.
 */
const isSyncCurrent = async () => {
  if (!fs.existsSync(STAMP_FILE_PATH) || !fs.existsSync(PACKAGE_JSON_PATH)) {
    return false
  }

  const [stampStat, packageStat] = await Promise.all([
    fs.promises.stat(STAMP_FILE_PATH),
    fs.promises.stat(PACKAGE_JSON_PATH)
  ])

  return packageStat.mtimeMs <= stampStat.mtimeMs
}

/**
 * The Node bridge still has its own SDK/runtime dependencies, so keep them in
 * sync once at setup time instead of installing them on every skill run.
 */
export default async function setupNodejsBridgeEnv() {
  if (!(fs.existsSync(PACKAGE_JSON_PATH))) {
    return
  }

  const status = createSetupStatus('Setting up Node.js bridge...').start()

  if (await isSyncCurrent()) {
    status.succeed('Node.js bridge: up-to-date')

    return
  }

  await command(
    RuntimeHelper.buildShellCommand(PNPM_RUNTIME_BIN_PATH, [
      'install',
      '--dir',
      NODEJS_BRIDGE_ROOT_PATH,
      '--lockfile=false'
    ]),
    { shell: true }
  )

  await fs.promises.writeFile(STAMP_FILE_PATH, `${Date.now()}`)

  status.succeed('Node.js bridge: ready')
}
