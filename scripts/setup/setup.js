import { IS_GITHUB_ACTIONS } from '@/constants'
import { LoaderHelper } from '@/helpers/loader-helper'
import { LogHelper } from '@/helpers/log-helper'

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
import createInstanceID from './create-instance-id'
import setFfprobePermissions from './set-ffprobe-permissions'

// Do not load ".env" file because it is not created yet

/**
 * Main entry to set up Leon
 */
;(async () => {
  let currentStep = 'bootstrap'

  try {
    currentStep = 'setupDotenv'
    await setupDotenv()
    LoaderHelper.start()
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
      LogHelper.info(
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
    LoaderHelper.stop()
    if (!IS_GITHUB_ACTIONS) {
      currentStep = 'setupCMake'
      await setupCMake()
      currentStep = 'setupNinja'
      await setupNinja()
      currentStep = 'setupLlamaCPP'
      await setupLlamaCPP()
      currentStep = 'setupLocalLLM'
      await setupLocalLLM()
      currentStep = 'setupQMDLLM'
      await setupQMDLLM()
      currentStep = 'setupNVIDIALibs'
      await setupNVIDIALibs()
      currentStep = 'setupPyTorch'
      await setupPyTorch()
    } else {
      LogHelper.info(
        'Skipping CMake, Ninja, llama.cpp, local LLM, QMD models, NVIDIA, and PyTorch setups because it is running in CI'
      )
    }
    currentStep = 'setupTCPServerModels'
    await setupTCPServerModels()
    currentStep = 'generateHTTPAPIKey'
    await generateHTTPAPIKey()
    currentStep = 'generateJSONSchemas'
    await generateJSONSchemas()
    LoaderHelper.start()
    currentStep = 'train'
    await train()
    currentStep = 'setFfprobePermissions'
    await setFfprobePermissions()
    currentStep = 'createInstanceID'
    await createInstanceID()

    LogHelper.default('')
    LogHelper.success('Hooray! Leon is installed and ready to go!')
    LoaderHelper.stop()
  } catch (e) {
    LoaderHelper.stop()
    LogHelper.error(
      `Setup failed during ${currentStep}: ${
        e instanceof Error ? e.stack || e.message : String(e)
      }`
    )
    process.exit(1)
  }
})()
