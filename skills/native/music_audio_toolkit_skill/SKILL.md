# Guidance

## Choose This Skill When
- A workflow needs audio transcription, dubbing, or vocal and instrumental separation.
- The owner explicitly requests one of those audio-processing operations.

## Resolve With Context
- Reuse audio paths and prior workflow artifacts from the current skill context when available.
- For dubbing, require a target language that can be mapped to Leon canonical language list.

## Avoid
- Do not use this skill for general music discussion.
- Do not silently continue when the file path or target language is missing.
