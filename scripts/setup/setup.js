import { IS_GITHUB_ACTIONS } from '@/constants'
import { LogHelper } from '@/helpers/log-helper'
import { NetworkHelper } from '@/helpers/network-helper'

import buildApp from '../app/build-app'
import buildServer from '../build-server'
import train from '../train/train'
import generateHTTPAPIKey from '../generate/generate-http-api-key'
import generateJSONSchemas from '../generate/generate-json-schemas'

import setupDotenv from './setup-dotenv'
import setupCore from './setup-core'
import setupNode from './setup-node'
import setupPNPM from './setup-pnpm'
import setupPython from './setup-python'
import setupUV from './setup-uv'
import setupNodejsBridgeEnv from './setup-nodejs-bridge-env'
import setupPythonBridgeEnv from './setup-python-bridge-env'
import setupSkills from './setup-skills/setup-skills'
import setupTCPServerEnv from './setup-tcp-server-env'
import setupCMake from './setup-cmake'
import setupNinja from './setup-ninja'
import setupLlamaCPP from './setup-llama-cpp'
import setupLocalLLM from './setup-local-llm'
import setupQMDLLM from './setup-qmd-llm'
import setupNVIDIALibs from './setup-nvidia-libs.js'
import setupPyTorch from './setup-pytorch.js'
import setupTCPServerModels from './setup-tcp-server-models'
import inspectLocalAICapability from './local-ai-capability'
import { printSetupBanner } from './setup-banner'
import { tellSetupCompletionJoke } from './setup-jokes'
import setupPreferences from './setup-preferences'
import { createSetupStatus } from './setup-status'
import { SetupUI } from './setup-ui'
import createInstanceID from './create-instance-id'
import setFfprobePermissions from './set-ffprobe-permissions'

// Do not load ".env" file because it is not created yet

/**
 * Main entry to set up Leon
 */
;(async () => {
  // Track setup execution state for user-facing error reporting and interruption handling.
  let currentStep = 'bootstrap'
  let shutdownSignal = null
  let preferences = {
    setupLocalAI: false,
    setupVoice: false
  }
  let localAICapability = null
  const getExitCodeFromSignal = (signal) => (signal === 'SIGINT' ? 130 : 143)

  // Clean up process signal listeners when setup exits normally or with an error.
  const cleanupSignalHandlers = () => {
    process.off('SIGINT', handleShutdownSignal)
    process.off('SIGTERM', handleShutdownSignal)
  }

  // Abort active downloads and exit cleanly when setup is interrupted.
  const handleShutdownSignal = (signal) => {
    if (shutdownSignal) {
      process.exit(getExitCodeFromSignal(signal))
    }

    shutdownSignal = signal

    const abortedDownloadCount = NetworkHelper.abortActiveDownloads(
      `Setup interrupted by ${signal}`
    )

    if (abortedDownloadCount === 0) {
      process.exit(getExitCodeFromSignal(signal))
    }
  }

  process.on('SIGINT', handleShutdownSignal)
  process.on('SIGTERM', handleShutdownSignal)

  try {
    // Print the setup banner outside CI so the local install feels branded.
    if (!IS_GITHUB_ACTIONS) {
      printSetupBanner()
    }

    // Prepare the local runtime, bridges, skills, and shared memory models.
    SetupUI.section('Base Setup')

    currentStep = 'setupDotenv'
    await setupDotenv()
    currentStep = 'setupCore'
    await setupCore()
    if (!IS_GITHUB_ACTIONS) {
      currentStep = 'setupNode'
      await setupNode()
      currentStep = 'setupPNPM'
      await setupPNPM()
      currentStep = 'setupPython'
      await setupPython()
      currentStep = 'setupUV'
      await setupUV()
    } else {
      SetupUI.info(
        'Skipping portable Node.js, pnpm, Python and uv setup because it is running in CI'
      )
    }
    currentStep = 'setupNodejsBridgeEnv'
    await setupNodejsBridgeEnv()
    currentStep = 'setupPythonBridgeEnv'
    await setupPythonBridgeEnv()
    currentStep = 'setupTCPServerEnv'
    await setupTCPServerEnv()
    currentStep = 'setupSkills'
    await setupSkills()
    if (!IS_GITHUB_ACTIONS) {
      currentStep = 'setupQMDLLM'
      await setupQMDLLM()
    } else {
      SetupUI.info('Skipping QMD model setup because it is running in CI')
    }

    if (!IS_GITHUB_ACTIONS) {
      // Inspect local AI support, ask the user what to enable, and install local AI components.
      SetupUI.section('Local AI')
      currentStep = 'inspectLocalAICapability'
      SetupUI.info('I\'m checking what this computer can handle...')
      localAICapability = await inspectLocalAICapability()
      currentStep = 'setupPreferences'
      preferences = await setupPreferences(localAICapability)

      if (preferences.setupLocalAI) {
        currentStep = 'setupCMake'
        await setupCMake()
        currentStep = 'setupNinja'
        await setupNinja()
        currentStep = 'setupLlamaCPP'
        await setupLlamaCPP()
        currentStep = 'setupLocalLLM'
        await setupLocalLLM(localAICapability)
      } else {
        SetupUI.info('I will skip local AI for now. You can add it later.')
      }

      if (preferences.setupVoice) {
        currentStep = 'setupNVIDIALibs'
        await setupNVIDIALibs()
        currentStep = 'setupPyTorch'
        await setupPyTorch()
      } else {
        SetupUI.info('I will skip voice setup for now. You can add it later.')
      }
    } else {
      // Skip hardware-specific setup in CI where local AI and voice stacks are not needed.
      SetupUI.info(
        'Skipping CMake, Ninja, llama.cpp, local LLM, QMD models, NVIDIA, and PyTorch setups because it is running in CI'
      )
    }

    // Install voice models only when voice support is enabled.
    if (preferences.setupVoice) {
      currentStep = 'setupTCPServerModels'
      await setupTCPServerModels()
    } else {
      SetupUI.info('I will skip voice model downloads for now.')
    }

    // Finalize generated assets and instance-specific setup metadata.
    SetupUI.section('Finishing Up')

    currentStep = 'generateHTTPAPIKey'
    await generateHTTPAPIKey()
    currentStep = 'generateJSONSchemas'
    await generateJSONSchemas()
    currentStep = 'train'
    await train()
    currentStep = 'setFfprobePermissions'
    await setFfprobePermissions()
    currentStep = 'createInstanceID'
    await createInstanceID()
    currentStep = 'buildApp'
    {
      const status = createSetupStatus('Building app...').start()

      try {
        await buildApp({ quiet: true })
        status.succeed('App: ready')
      } catch (error) {
        status.fail('Failed to build app')
        throw error
      }
    }
    currentStep = 'buildServer'
    {
      const status = createSetupStatus('Building server...').start()

      try {
        await buildServer({ quiet: true })
        status.succeed('Server: ready')
      } catch (error) {
        status.fail('Failed to build server')
        throw error
      }
    }

    if (!IS_GITHUB_ACTIONS) {
      printSetupBanner()
    }

    SetupUI.recap([
      'Setup complete',
      `Local AI: ${preferences.setupLocalAI ? 'enabled' : 'skipped'}`,
      `Voice: ${preferences.setupVoice ? 'enabled' : 'skipped'}`
    ])
    tellSetupCompletionJoke()
    SetupUI.successHighlight('Hooray! I\'m installed and ready to go!')
    SetupUI.bullet(
      `Follow my creator to get regular updates about me: ${SetupUI.underlined(
        'https://x.com/grenlouis'
      )}`
    )
  } catch (e) {
    // Exit with the original signal code when setup was intentionally interrupted.
    if (shutdownSignal) {
      cleanupSignalHandlers()
      process.exit(getExitCodeFromSignal(shutdownSignal))
    }

    // Surface the failing phase clearly when setup stops on an unexpected error.
    LogHelper.error(
      `Setup failed during ${currentStep}: ${
        e instanceof Error ? e.stack || e.message : String(e)
      }`
    )
    cleanupSignalHandlers()
    process.exit(1)
  }
})()
