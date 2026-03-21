# Guidance

## Choose This Skill When
- The owner wants to translate a video speech track into another language through the full Leon workflow.

## Resolve With Context
- Preserve workflow artifacts across steps: downloaded video, extracted audio, transcription, speaker references, and dubbed output.
- Reuse the active target language from the current skill context unless the owner explicitly changes it.
- Prefer continuing the current workflow over restarting it.

## Avoid
- Do not silently skip missing intermediate files.
- Do not fall back to entity history for language resolution; use declared params and stored workflow context.
