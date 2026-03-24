import fs from 'node:fs'
import path from 'node:path'

import {
  NVIDIA_CUBLAS_MANIFEST_PATH,
  NVIDIA_CUBLAS_VERSION,
  NVIDIA_CUDNN_MANIFEST_PATH,
  NVIDIA_CUDNN_VERSION,
  NVIDIA_CUDA_CUDART_MANIFEST_PATH,
  NVIDIA_CUDA_CUDART_VERSION,
  NVIDIA_CUDA_CUPTI_MANIFEST_PATH,
  NVIDIA_CUDA_CUPTI_VERSION,
  NVIDIA_CUSPARSE_MANIFEST_PATH,
  NVIDIA_CUSPARSE_VERSION,
  NVIDIA_CUSPARSE_FULL_MANIFEST_PATH,
  NVIDIA_CUSPARSE_FULL_VERSION,
  NVIDIA_NCCL_MANIFEST_PATH,
  NVIDIA_NCCL_VERSION,
  NVIDIA_NVSHMEM_MANIFEST_PATH,
  NVIDIA_NVSHMEM_VERSION,
  NVIDIA_NVJITLINK_MANIFEST_PATH,
  NVIDIA_NVJITLINK_VERSION,
  PYTORCH_MANIFEST_PATH,
  PYTORCH_VERSION,
  PYTHON_TCP_SERVER_ASR_MODEL_DIR_PATH,
  PYTHON_TCP_SERVER_TTS_BERT_BASE_DIR_PATH,
  PYTHON_TCP_SERVER_TTS_MODEL_PATH
} from '@/constants'
import { SystemHelper } from '@/helpers/system-helper'

const ASR_MODEL_FILES = [
  'model.bin',
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'vocabulary.json'
]
const TTS_BERT_BASE_MODEL_FILES = [
  'pytorch_model.bin',
  'config.json',
  'vocab.txt',
  'tokenizer_config.json',
  'tokenizer.json'
]
const X86_64_ARCHITECTURES = new Set(['x64', 'x86_64'])

function readManifestVersion(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return null
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf-8')

    return JSON.parse(content).version || null
  } catch {
    return null
  }
}

function hasExpectedManifestVersion(manifestPath, version) {
  return readManifestVersion(manifestPath) === version
}

function hasAllFiles(directoryPath, fileNames) {
  return fileNames.every((fileName) =>
    fs.existsSync(path.join(directoryPath, fileName))
  )
}

/**
 * Inspect whether all optional voice setup assets are already available.
 */
export default function inspectVoiceSetupState() {
  const hasVoiceModels =
    hasAllFiles(
      PYTHON_TCP_SERVER_TTS_BERT_BASE_DIR_PATH,
      TTS_BERT_BASE_MODEL_FILES
    ) &&
    fs.existsSync(PYTHON_TCP_SERVER_TTS_MODEL_PATH) &&
    hasAllFiles(PYTHON_TCP_SERVER_ASR_MODEL_DIR_PATH, ASR_MODEL_FILES)

  const hasPyTorch = hasExpectedManifestVersion(
    PYTORCH_MANIFEST_PATH,
    PYTORCH_VERSION
  )

  if (SystemHelper.isMacOS()) {
    return {
      isReady: hasPyTorch && hasVoiceModels
    }
  }

  const hasNVIDIALibs =
    hasExpectedManifestVersion(NVIDIA_CUBLAS_MANIFEST_PATH, NVIDIA_CUBLAS_VERSION) &&
    hasExpectedManifestVersion(NVIDIA_CUDNN_MANIFEST_PATH, NVIDIA_CUDNN_VERSION) &&
    hasExpectedManifestVersion(
      NVIDIA_CUDA_CUDART_MANIFEST_PATH,
      NVIDIA_CUDA_CUDART_VERSION
    ) &&
    hasExpectedManifestVersion(
      NVIDIA_CUDA_CUPTI_MANIFEST_PATH,
      NVIDIA_CUDA_CUPTI_VERSION
    ) &&
    (!SystemHelper.isLinux() ||
      (hasExpectedManifestVersion(
        NVIDIA_CUSPARSE_MANIFEST_PATH,
        NVIDIA_CUSPARSE_VERSION
      ) &&
        hasExpectedManifestVersion(
          NVIDIA_CUSPARSE_FULL_MANIFEST_PATH,
          NVIDIA_CUSPARSE_FULL_VERSION
        ) &&
        hasExpectedManifestVersion(
          NVIDIA_NVJITLINK_MANIFEST_PATH,
          NVIDIA_NVJITLINK_VERSION
        ))) &&
    (!SystemHelper.isLinux() ||
      !X86_64_ARCHITECTURES.has(SystemHelper.getInformation().cpuArchitecture) ||
      (hasExpectedManifestVersion(
        NVIDIA_NCCL_MANIFEST_PATH,
        NVIDIA_NCCL_VERSION
      ) &&
        hasExpectedManifestVersion(
          NVIDIA_NVSHMEM_MANIFEST_PATH,
          NVIDIA_NVSHMEM_VERSION
        )))

  return {
    isReady: hasNVIDIALibs && hasPyTorch && hasVoiceModels
  }
}
