import { CHARS_PER_TOKEN } from '@/core/llm-manager/llm-duties/react-llm-duty/constants'

export interface TextChunk {
  index: number
  content: string
  tokenEstimate: number
}

const DEFAULT_MAX_CHARS = 1_200
const MIN_CHUNK_CHARS = 240

export function chunkText(
  text: string,
  maxChars = DEFAULT_MAX_CHARS
): TextChunk[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    return []
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)

  const chunks: TextChunk[] = []
  let buffer = ''
  let chunkIndex = 0

  const flush = (): void => {
    const content = buffer.trim()
    if (!content) {
      return
    }

    chunks.push({
      index: chunkIndex,
      content,
      tokenEstimate: Math.max(1, Math.ceil(content.length / CHARS_PER_TOKEN))
    })
    chunkIndex += 1
    buffer = ''
  }

  for (const paragraph of paragraphs) {
    if (!buffer) {
      buffer = paragraph
      continue
    }

    const candidate = `${buffer}\n\n${paragraph}`
    if (candidate.length <= maxChars) {
      buffer = candidate
      continue
    }

    if (buffer.length >= MIN_CHUNK_CHARS) {
      flush()
      buffer = paragraph
      continue
    }

    const splitPoint = Math.max(
      MIN_CHUNK_CHARS,
      Math.min(maxChars, Math.floor(paragraph.length / 2))
    )
    buffer = `${buffer}\n\n${paragraph.slice(0, splitPoint).trim()}`
    flush()
    buffer = paragraph.slice(splitPoint).trim()
  }

  flush()

  return chunks
}
