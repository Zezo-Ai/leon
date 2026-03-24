import { SetupUI, setupConsola } from './setup-ui'

/**
 * Ask lightweight setup questions so users can skip optional downloads.
 */
export default async function setupPreferences(localAICapability) {
  const defaultPreferences = {
    setupLocalAI: localAICapability.canInstallLocalAI,
    setupVoice: false
  }

  if (
    process.env.IS_DOCKER === 'true' ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  ) {
    if (localAICapability.canInstallLocalAI) {
      SetupUI.info(
        'I can run AI directly on this computer, so I will set up local AI automatically.'
      )
    } else {
      SetupUI.info(
        'This computer is not a good fit for local AI or voice features, so I will set up the essentials.'
      )
    }

    return defaultPreferences
  }

  if (localAICapability.canInstallLocalAI) {
    SetupUI.info(
      'I can run AI directly on this computer. That means better privacy and less to configure online.'
    )
    SetupUI.questionIntro(2)
  } else {
    SetupUI.info(
      'This computer is not a good fit for local AI or voice features, so I will set up the essentials.'
    )

    return defaultPreferences
  }

  const setupLocalAI = await setupConsola.prompt(
    'Do you want me to set up local AI now?',
    {
      type: 'confirm',
      initial: true,
      cancel: 'default'
    }
  )
  const setupVoice = await setupConsola.prompt(
    'Do you want to talk to me with your voice now?',
    {
      type: 'confirm',
      initial: false,
      cancel: 'default'
    }
  )

  const preferences = {
    ...defaultPreferences,
    setupLocalAI,
    setupVoice
  }

  return preferences
}
