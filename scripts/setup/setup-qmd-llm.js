import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

import { FileHelper } from '@/helpers/file-helper'
import { NetworkHelper } from '@/helpers/network-helper'

import { createSetupStatus } from './setup-status'

const MOVE_FALLBACK_ERROR_CODES = new Set(['EXDEV', 'EPERM', 'EBUSY', 'EACCES'])
const QMD_MODELS_DIR_PATH = path.join(homedir(), '.cache', 'qmd', 'models')

const QMD_MODELS = [
  {
    /**
     * We do not use it yet, but better to get it now,
     * so it'd be ready when we enable embeddings
     */
    url: 'https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf?download=true',
    filename: 'hf_ggml-org_embeddinggemma-300M-Q8_0.gguf'
  },
  {
    url: 'https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/resolve/main/qwen3-reranker-0.6b-q8_0.gguf?download=true',
    filename: 'hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf'
  },
  {
    url: 'https://huggingface.co/tobil/qmd-query-expansion-1.7B/resolve/main/qmd-query-expansion-1.7B-Q4_K_M.gguf?download=true',
    filename: 'hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf'
  }
]

function getModelFilenameFromURL(modelURL) {
  const parsedURL = new URL(modelURL)

  return path.basename(parsedURL.pathname)
}

function isMoveFallbackError(error) {
  return (
    error instanceof Error &&
    'code' in error &&
    MOVE_FALLBACK_ERROR_CODES.has(error.code)
  )
}

async function movePath(sourcePath, destinationPath) {
  try {
    await fs.promises.rename(sourcePath, destinationPath)
  } catch (error) {
    if (!isMoveFallbackError(error)) {
      throw error
    }

    await fs.promises.copyFile(sourcePath, destinationPath)
    await fs.promises.rm(sourcePath, { force: true })
  }
}

async function downloadModel(model) {
  const destinationPath = path.join(QMD_MODELS_DIR_PATH, model.filename)
  const legacyFilename = getModelFilenameFromURL(model.url)
  const legacyPath = path.join(QMD_MODELS_DIR_PATH, legacyFilename)

  if (fs.existsSync(destinationPath)) {
    return 'existing'
  }

  if (legacyFilename !== model.filename && fs.existsSync(legacyPath)) {
    await movePath(legacyPath, destinationPath)

    return 'renamed'
  }

  const resolvedURL = await NetworkHelper.setHuggingFaceURL(model.url)

  await FileHelper.downloadFile(resolvedURL, destinationPath)

  return 'downloaded'
}

export default async () => {
  const status = createSetupStatus('Checking QMD models...').start()

  try {
    await fs.promises.mkdir(QMD_MODELS_DIR_PATH, {
      recursive: true
    })

    status.pause()
    let downloadedModelCount = 0

    for (const model of QMD_MODELS) {
      const modelState = await downloadModel(model)

      if (modelState === 'downloaded') {
        downloadedModelCount += 1
      }
    }

    status.text = 'Finalizing QMD models...'
    status.start()

    status.succeed(
      downloadedModelCount > 0
        ? `QMD models: ready - ${downloadedModelCount} downloaded`
        : 'QMD models: ready'
    )
  } catch (e) {
    if (status.isSpinning) {
      status.fail('Failed to set up QMD models')
    }
    throw e
  }
}
