import { SetupUI, setupConsola } from './setup-ui'
import setupRemoteLLM from './setup-remote-llm'

/**
 * Ask lightweight setup questions so users can skip optional downloads.
 */
export default async function setupPreferences(
  localAICapability,
  existingLLMChoice,
  voiceSetupState
) {
  const defaultPreferences = {
    setupLocalAI: localAICapability.canInstallLocalAI,
    setupVoice: false,
    remoteLLMProvider: '',
    remoteLLMModel: '',
    remoteLLMAPIKeyEnv: '',
    remoteLLMAPIKey: ''
  }

  if (
    process.env.IS_DOCKER === 'true' ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  ) {
    if (!localAICapability.canInstallLocalAI) {
      SetupUI.info(
        'This computer is not a good fit for local AI or voice features, so I will set up the essentials.'
      )
    }

    return defaultPreferences
  }

  if (existingLLMChoice.hasResolvedChoice) {
    SetupUI.info(
      `I found your current AI setup, so I will keep using it: ${existingLLMChoice.label}`
    )

    if (!localAICapability.canInstallLocalAI) {
      return {
        ...defaultPreferences,
        setupLocalAI: existingLLMChoice.setupLocalAI,
        setupVoice: false
      }
    }

    if (voiceSetupState.isReady) {
      SetupUI.info('Voice is already ready, so I will keep it as is.')

      return {
        ...defaultPreferences,
        setupLocalAI: existingLLMChoice.setupLocalAI,
        setupVoice: true
      }
    }

    SetupUI.questionIntro(1)

    const setupVoice = await setupConsola.prompt(
      'Do you want to talk to me with your voice now?',
      {
        type: 'confirm',
        initial: false,
        cancel: 'default'
      }
    )

    return {
      ...defaultPreferences,
      setupLocalAI: existingLLMChoice.setupLocalAI,
      setupVoice
    }
  }

  if (voiceSetupState.isReady) {
    SetupUI.info('Voice is already ready, so I will keep it as is.')
  }

  if (localAICapability.canInstallLocalAI) {
    SetupUI.info(
      'I just have a few quick questions so I can set things up the way you want.'
    )
  } else {
    SetupUI.info(
      'This computer is not a good fit for local AI or voice features.'
    )
    return {
      ...defaultPreferences,
      ...(await setupRemoteLLM())
    }
  }

  const setupLocalAI = await setupConsola.prompt(
    'Do you want me to set up local AI now?',
    {
      type: 'confirm',
      initial: true,
      cancel: 'default'
    }
  )

  let remoteLLMPreferences = {
    remoteLLMProvider: '',
    remoteLLMModel: '',
    remoteLLMAPIKeyEnv: '',
    remoteLLMAPIKey: ''
  }

  if (!setupLocalAI) {
    remoteLLMPreferences = await setupRemoteLLM()
  }

  const setupVoice = voiceSetupState.isReady
    ? true
    : await setupConsola.prompt('Do you want to talk to me with your voice now?', {
        type: 'confirm',
        initial: false,
        cancel: 'default'
      })

  const preferences = {
    ...defaultPreferences,
    setupLocalAI,
    setupVoice,
    ...remoteLLMPreferences
  }

  return preferences
}
