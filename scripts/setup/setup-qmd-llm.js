import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

import { LogHelper } from '@/helpers/log-helper'
import { FileHelper } from '@/helpers/file-helper'
import { NetworkHelper } from '@/helpers/network-helper'

const QMD_MODELS_DIR_PATH = path.join(homedir(), '.cache', 'qmd', 'models')

const QMD_MODELS = [
  {
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

async function downloadModel(model) {
  const destinationPath = path.join(QMD_MODELS_DIR_PATH, model.filename)
  const legacyFilename = getModelFilenameFromURL(model.url)
  const legacyPath = path.join(QMD_MODELS_DIR_PATH, legacyFilename)

  if (fs.existsSync(destinationPath)) {
    LogHelper.success(`${model.filename} is already downloaded`)
    return
  }

  if (legacyFilename !== model.filename && fs.existsSync(legacyPath)) {
    await fs.promises.rename(legacyPath, destinationPath)
    LogHelper.success(
      `Renamed ${legacyFilename} to ${model.filename}`
    )
    return
  }

  const resolvedURL = await NetworkHelper.setHuggingFaceURL(model.url)

  LogHelper.info(`Downloading ${model.filename}...`)
  await FileHelper.downloadFile(resolvedURL, destinationPath)
  LogHelper.success(`${model.filename} downloaded at ${destinationPath}`)
}

export default async () => {
  try {
    LogHelper.info('Checking QMD models...')

    await fs.promises.mkdir(QMD_MODELS_DIR_PATH, {
      recursive: true
    })

    for (const model of QMD_MODELS) {
      await downloadModel(model)
    }

    LogHelper.success('QMD models are ready')
  } catch (e) {
    LogHelper.error(`Failed to set up QMD models: ${e}`)
    process.exit(1)
  }
}
