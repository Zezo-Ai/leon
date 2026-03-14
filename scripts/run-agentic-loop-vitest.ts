import path from 'node:path'
import { spawn } from 'node:child_process'

type AgenticLoopSuite = 'unit' | 'e2e'

function extractTestNamePattern(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (!arg) {
      continue
    }

    if (arg === '-t' || arg === '--testNamePattern' || arg === '--test-name-pattern') {
      return args[index + 1] || null
    }

    if (arg.startsWith('-t=')) {
      return arg.slice(3) || null
    }

    if (arg.startsWith('--testNamePattern=')) {
      return arg.slice('--testNamePattern='.length) || null
    }

    if (arg.startsWith('--test-name-pattern=')) {
      return arg.slice('--test-name-pattern='.length) || null
    }
  }

  return null
}

function resolveSuitePath(suite: AgenticLoopSuite): string {
  return suite === 'e2e' ? 'test/agentic-loop/e2e' : 'test/agentic-loop/unit'
}

const suiteArg = process.argv[2]
if (suiteArg !== 'unit' && suiteArg !== 'e2e') {
  console.error(
    'Expected suite argument "unit" or "e2e" for run-agentic-loop-vitest.ts'
  )
  process.exit(1)
}

const suite = suiteArg as AgenticLoopSuite
const forwardedArgs = process.argv.slice(3)
const testNamePattern = extractTestNamePattern(forwardedArgs)
const vitestEntrypoint = path.join(
  process.cwd(),
  'node_modules',
  'vitest',
  'vitest.mjs'
)

const childProcess = spawn(
  process.execPath,
  [
    vitestEntrypoint,
    'run',
    '--config',
    'vitest.agentic-loop.config.ts',
    resolveSuitePath(suite),
    ...forwardedArgs
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      LEON_NODE_ENV: process.env['LEON_NODE_ENV'] || 'testing',
      ...(suite === 'e2e' && testNamePattern
        ? {
            LEON_AGENTIC_LOOP_PROVIDER_PATTERN: testNamePattern
          }
        : {})
    }
  }
)

childProcess.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})
