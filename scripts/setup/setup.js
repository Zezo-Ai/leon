import { IS_GITHUB_ACTIONS } from '@/constants'
import { LoaderHelper } from '@/helpers/loader-helper'
import { LogHelper } from '@/helpers/log-helper'

import train from '../train/train'
import generateHTTPAPIKey from '../generate/generate-http-api-key'
import generateJSONSchemas from '../generate/generate-json-schemas'

import setupDotenv from './setup-dotenv'
import setupCore from './setup-core'
import setupSkills from './setup-skills/setup-skills'
import setupCMake from './setup-cmake'
import setupNinja from './setup-ninja'
import setupLlamaCPP from './setup-llama-cpp'
import setupLocalLLM from './setup-local-llm'
import setupQMDLLM from './setup-qmd-llm'
import setupNVIDIALibs from './setup-nvidia-libs.js'
import setupPyTorch from './setup-pytorch.js'
import setupBinaries from './setup-binaries'
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

    await setupBinaries()
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
