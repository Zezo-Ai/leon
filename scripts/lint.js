import { command } from 'execa'

import { LogHelper } from '@/helpers/log-helper'
import { LoaderHelper } from '@/helpers/loader-helper'

const globs = [
  '"app/src/js/*.{ts,js}"',
  // TODO: deal with it once handling new hotword
  // '"hotword/index.{ts,js}"',
  // TODO: put it back once tests have been reintroduced into skills
  // '"skills/**/*.js"',
  '"scripts/**/*.{ts,js}"',
  '"server/src/**/*.{ts,js}"'
  // TODO: put it back once tests need to be written
  /*'"test/!*.js"',
  '"test/e2e/!**!/!*.js"',
  '"test/json/!**!/!*.js"',
  '"test/unit/!**!/!*.js"'*/
]
const src = globs.join(' ')

/**
 * This script ensures the correct coding syntax of the whole project
 */
;(async () => {
  LoaderHelper.start()
  LogHelper.info('Linting...')

  try {
    await Promise.all([
      command(`eslint ${src} --fix --ignore-pattern .gitignore`, {
        shell: true,
        stdio: 'inherit'
      })
    ])

    LogHelper.success('Looks great')
    LoaderHelper.stop()
  } catch (e) {
    LogHelper.error(`Does not look great: ${e.message}`)
    LoaderHelper.stop()
    process.exit(1)
  }
})()
