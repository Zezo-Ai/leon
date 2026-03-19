import fs from 'node:fs'
import path from 'node:path'

import { CPUArchitectures } from '@/types'
import {
  LLM_DIR_PATH,
  LLM_MANIFEST_PATH,
  LLM_HIGH_TIER_MINIMUM_TOTAL_VRAM,
  LLM_MINIMUM_TOTAL_VRAM,
  LLAMACPP_RELEASE_VERSION
} from '@/constants'
import { SystemHelper } from '@/helpers/system-helper'
import { LogHelper } from '@/helpers/log-helper'
import { FileHelper } from '@/helpers/file-helper'
import { NetworkHelper } from '@/helpers/network-helper'

/**
 * Download and set up the default local LLM
 * 1. Check minimum hardware requirements
 * 2. Select the default model according to total VRAM
 * 3. Download the model from Hugging Face or mirror
 * 4. Create manifest file with the default installed model path
 */

const DEFAULT_LLM_OPTIONS = [
  {
    minimumTotalVRAM: LLM_HIGH_TIER_MINIMUM_TOTAL_VRAM,
    name: 'Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive',
    version: 'Q4_K_M',
    fileName: 'Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf',
    downloadURL:
      'https://huggingface.co/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive/resolve/main/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf?download=true'
  },
  {
    minimumTotalVRAM: LLM_MINIMUM_TOTAL_VRAM,
    name: 'Qwen3.5-9B-Uncensored-HauhauCS-Aggressive',
    version: 'Q4_K_M',
    fileName: 'Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf',
    downloadURL:
      'https://huggingface.co/HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive/resolve/main/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf?download=true'
  }
]

function readManifest() {
  if (!fs.existsSync(LLM_MANIFEST_PATH)) {
    return null
  }

  try {
    return JSON.parse(fs.readFileSync(LLM_MANIFEST_PATH, 'utf8'))
  } catch {
    return null
  }
}

function toRelativeModelPath(modelPath) {
  return path.relative(process.cwd(), modelPath).split(path.sep).join('/')
}

async function removePreviousDefaultModel(previousModelPath, nextModelPath) {
  if (!previousModelPath || previousModelPath === nextModelPath) {
    return
  }

  const resolvedPreviousModelPath = path.resolve(process.cwd(), previousModelPath)

  // Only delete the previous default model we installed under core/data/models/llm/.
  if (!resolvedPreviousModelPath.startsWith(`${LLM_DIR_PATH}${path.sep}`)) {
    return
  }

  await fs.promises.rm(resolvedPreviousModelPath, { force: true })
}

function getSelectedModel(totalVRAM) {
  return (
    DEFAULT_LLM_OPTIONS.find(
      ({ minimumTotalVRAM }) => totalVRAM >= minimumTotalVRAM
    ) || null
  )
}

async function inspectHardware() {
  const { getLlama, LlamaLogLevel } = await Function(
    'return import("node-llama-cpp")'
  )()
  const llama = await getLlama({
    logLevel: LlamaLogLevel.disabled
  })

  const [hasGPU, gpuDeviceNames, graphicsComputeAPI, totalVRAM] =
    await Promise.all([
      SystemHelper.hasGPU(llama),
      SystemHelper.getGPUDeviceNames(llama),
      SystemHelper.getGraphicsComputeAPI(llama),
      SystemHelper.getTotalVRAM(llama)
    ])

  return {
    llama,
    hasGPU,
    gpuDeviceNames,
    graphicsComputeAPI,
    totalVRAM
  }
}

async function canInstallDefaultLLM(hardware) {
  if (!hardware.hasGPU) {
    return false
  }

  const isLinuxARM64 =
    SystemHelper.isLinux() &&
    SystemHelper.getInformation().cpuArchitecture === CPUArchitectures.ARM64

  // Linux ARM64 is only supported when llama.cpp can be built with CUDA.
  if (isLinuxARM64 && hardware.graphicsComputeAPI !== 'cuda') {
    return false
  }

  return SystemHelper.canSupportLocalLLM(hardware.llama)
}

async function downloadLLM(selectedModel) {
  const manifest = readManifest()
  const targetPath = path.join(LLM_DIR_PATH, selectedModel.fileName)
  const defaultInstalledLLMPath = toRelativeModelPath(targetPath)
  const isCurrentModelInstalled =
    manifest?.name === selectedModel.name &&
    manifest?.version === selectedModel.version &&
    manifest?.defaultInstalledLLMPath === defaultInstalledLLMPath &&
    fs.existsSync(targetPath)

  if (isCurrentModelInstalled) {
    LogHelper.success(
      `${selectedModel.name} (${selectedModel.version}) is already set up and uses the latest version`
    )

    return
  }

  await fs.promises.mkdir(LLM_DIR_PATH, { recursive: true })
  await removePreviousDefaultModel(manifest?.defaultInstalledLLMPath, defaultInstalledLLMPath)
  await fs.promises.rm(targetPath, { force: true })

  const llmDownloadURL = await NetworkHelper.setHuggingFaceURL(
    selectedModel.downloadURL
  )

  LogHelper.info(
    `Downloading ${selectedModel.name} (${selectedModel.version}) from ${llmDownloadURL}...`
  )

  await FileHelper.downloadFile(llmDownloadURL, targetPath)

  await FileHelper.createManifestFile(
    LLM_MANIFEST_PATH,
    selectedModel.name,
    selectedModel.version,
    {
      llamaCPPVersion: LLAMACPP_RELEASE_VERSION,
      defaultInstalledLLMPath
    }
  )

  LogHelper.success('LLM manifest file updated')
  LogHelper.success(`${selectedModel.name} (${selectedModel.version}) ready`)
}

export default async function setupLocalLLM() {
  LogHelper.info(
    'Checking local LLM hardware requirements can take a few minutes...'
  )

  const hardware = await inspectHardware()

  if (hardware.hasGPU) {
    LogHelper.info(`GPU detected: ${hardware.gpuDeviceNames[0]}`)
    LogHelper.info(`Graphics compute API: ${hardware.graphicsComputeAPI}`)
  }
  LogHelper.info(`Total VRAM: ${hardware.totalVRAM} GB`)

  const canInstall = await canInstallDefaultLLM(hardware)

  if (!canInstall) {
    LogHelper.warning(
      `Local LLM support requires at least ${LLM_MINIMUM_TOTAL_VRAM} GB of total VRAM and a supported GPU setup. Current total VRAM is ${hardware.totalVRAM} GB. Leon will continue without installing a default local LLM.`
    )

    return
  }

  const selectedModel = getSelectedModel(hardware.totalVRAM)

  if (!selectedModel) {
    LogHelper.warning(
      `No default local LLM matches the current total VRAM (${hardware.totalVRAM} GB).`
    )

    return
  }

  await downloadLLM(selectedModel)
}
