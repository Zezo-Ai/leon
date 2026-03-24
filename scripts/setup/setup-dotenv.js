import fs from 'node:fs'
import path from 'node:path'

import { createSetupStatus } from './setup-status'

function getEnvVariableName(line) {
  const trimmedLine = line.trim()

  if (
    trimmedLine === '' ||
    trimmedLine.startsWith('#') ||
    !trimmedLine.includes('=')
  ) {
    return null
  }

  const variableName = trimmedLine.slice(0, trimmedLine.indexOf('=')).trim()

  return /^[A-Z0-9_]+$/.test(variableName) ? variableName : null
}

async function mergeMissingEnvVariables() {
  const samplePath = path.join(process.cwd(), '.env.sample')
  const dotEnvPath = path.join(process.cwd(), '.env')
  const sampleContent = await fs.promises.readFile(samplePath, 'utf8')
  const dotEnvContent = await fs.promises.readFile(dotEnvPath, 'utf8')
  const dotEnvLines = dotEnvContent.split('\n')
  const existingVariableNames = new Set(
    dotEnvLines
      .map((line) => getEnvVariableName(line))
      .filter((variableName) => variableName !== null)
  )
  const missingSampleLines = sampleContent
    .split('\n')
    .filter((line) => {
      const variableName = getEnvVariableName(line)

      return variableName !== null && !existingVariableNames.has(variableName)
    })

  if (missingSampleLines.length === 0) {
    return '.env: up-to-date'
  }

  const normalizedDotEnvContent = dotEnvContent.endsWith('\n')
    ? dotEnvContent
    : `${dotEnvContent}\n`
  const separator = normalizedDotEnvContent.trim() === '' ? '' : '\n'
  const mergedContent = `${normalizedDotEnvContent}${separator}${missingSampleLines.join('\n')}\n`

  await fs.promises.writeFile(dotEnvPath, mergedContent)

  return `.env: +${missingSampleLines.length} variable${
    missingSampleLines.length > 1 ? 's' : ''
  }`
}

/**
 * Duplicate the .env.sample to .env file
 */
export default () =>
  new Promise(async (resolve) => {
    const status = createSetupStatus('Preparing .env...').start()

    const createDotenv = () => {
      fs.createReadStream('.env.sample').pipe(fs.createWriteStream('.env'))
    }

    if (!fs.existsSync('.env')) {
      createDotenv()
      status.succeed('.env: created')

      resolve()
    } else {
      status.succeed(await mergeMissingEnvVariables())

      resolve()
    }
  })
