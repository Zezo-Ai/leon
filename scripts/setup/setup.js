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
  try {
    await setupDotenv()
    LoaderHelper.start()
    await setupCore()
    if (!IS_GITHUB_ACTIONS) {
      await setupNode()
      await setupPNPM()
      await setupPython()
      await setupUV()
    } else {
      LogHelper.info(
        'Skipping portable Node.js, pnpm, Python and uv setup because it is running in CI'
      )
    }
    await setupNodejsBridgeEnv()
    await setupPythonBridgeEnv()
    await setupTCPServerEnv()
    await setupSkills()
    LoaderHelper.stop()
    if (!IS_GITHUB_ACTIONS) {
      await setupCMake()
      await setupNinja()
      await setupLlamaCPP()
      await setupLocalLLM()
      await setupQMDLLM()
      await setupNVIDIALibs()
      await setupPyTorch()
    } else {
      LogHelper.info(
        'Skipping CMake, Ninja, llama.cpp, local LLM, QMD models, NVIDIA, and PyTorch setups because it is running in CI'
      )
    }
    await setupTCPServerModels()
    await generateHTTPAPIKey()
    await generateJSONSchemas()
    LoaderHelper.start()
    await train()
    await setFfprobePermissions()
    await createInstanceID()

    LogHelper.default('')
    LogHelper.success('Hooray! Leon is installed and ready to go!')
    LoaderHelper.stop()
  } catch (e) {
    LogHelper.error(e)
    LoaderHelper.stop()
  }
})()
