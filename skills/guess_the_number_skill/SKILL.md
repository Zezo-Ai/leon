# Guidance

## Choose This Skill When
- The owner wants to start or continue the guess-the-number game.

## Resolve With Context
- During the game loop, a bare number should usually continue the current guessing action.
- Treat replay as a yes or no decision only after the game has completed.

## Avoid
- Do not restart the game if the owner is obviously continuing an active round.
- Do not treat unrelated numbers as a guess when the game context is inactive.
