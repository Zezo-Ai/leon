# Guidance

## Choose This Skill When
- The owner wants Leon to create, revise, or reason about Leon-native skills.

## Resolve With Context
- Prefer the current Leon-native skill architecture under `skills/native/<name>_skill`.
- Prefer declared action parameters and context_data over legacy entity-driven action code.
- Keep outputs aligned with Leon existing bridges, skill.json, locales, and action folders.

## Avoid
- Do not generate legacy category-based skills.
- Do not reintroduce deprecated custom NER or entity-dependent runtime patterns.
