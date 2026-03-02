import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import axios from 'axios'
// eslint-disable-next-line no-redeclare
import { WidgetWrapper, Flexbox, Loader, Text } from '@leon-ai/aurora'

import renderAuroraComponent from './render-aurora-component'
import ToolUIHandler from './tool-ui-handler'

const WIDGETS_TO_FETCH = []
const WIDGETS_FETCH_CACHE = new Map()
const REPLACED_MESSAGES = new Set()
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 24

export default class Chatbot {
  constructor(socket, serverURL) {
    this.socket = socket
    this.serverURL = serverURL
    this.et = new EventTarget()
    this.feed = document.querySelector('#feed')
    this.typing = document.querySelector('#is-typing')
    this.noBubbleMessage = document.querySelector('#no-bubble')
    this.bubbles = localStorage.getItem('bubbles')
    this.parsedBubbles = JSON.parse(this.bubbles)
    this.reasoningBlocks = new Map()
    this.feedAutoScrollEnabled = true
    this.isProgrammaticFeedScroll = false

    // Initialize tool UI handler
    this.toolUIHandler = new ToolUIHandler(
      this.feed,
      this.scrollDown.bind(this),
      this.formatMessage.bind(this)
    )
  }

  async init() {
    await this.loadFeed()
    this.scrollDown()

    this.et.addEventListener('to-leon', (event) => {
      this.createBubble({
        who: 'me',
        string: event.detail
      })
    })

    this.et.addEventListener('me-received', (event) => {
      this.createBubble({
        who: 'leon',
        string: event.detail
      })
    })

    // Add event delegation for clickable paths
    this.feed.addEventListener('click', (event) => {
      if (event.target.classList.contains('clickable-path')) {
        const path = event.target.getAttribute('data-path')
        if (path) {
          this.openPath(path)
        }
      }
    })

    this.feed.addEventListener(
      'scroll',
      () => {
        this.handleFeedScroll()
      },
      { passive: true }
    )
  }

  sendTo(who, string) {
    if (who === 'leon') {
      this.et.dispatchEvent(new CustomEvent('to-leon', { detail: string }))
    }
  }

  receivedFrom(who, string) {
    if (who === 'leon') {
      this.et.dispatchEvent(new CustomEvent('me-received', { detail: string }))
    }
  }

  isTyping(who, value) {
    if (who === 'leon') {
      if (value) {
        this.enableTyping()
      } else if (value === false) {
        this.disableTyping()
      }
    }
  }

  enableTyping() {
    if (!this.typing.classList.contains('on')) {
      this.typing.classList.add('on')
    }
  }

  disableTyping() {
    if (this.typing.classList.contains('on')) {
      this.typing.classList.remove('on')
    }
  }

  isElementNearBottom(element) {
    if (!element) {
      return true
    }

    const remainingScrollableDistance =
      element.scrollHeight - (element.scrollTop + element.clientHeight)

    return remainingScrollableDistance <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX
  }

  handleFeedScroll() {
    if (!this.feed || this.isProgrammaticFeedScroll) {
      return
    }

    this.feedAutoScrollEnabled = this.isElementNearBottom(this.feed)
  }

  scrollDown(options = {}) {
    if (!this.feed) {
      return
    }

    const { force = false } = options

    if (!force && !this.feedAutoScrollEnabled) {
      return
    }

    this.isProgrammaticFeedScroll = true
    this.feed.scrollTo(0, this.feed.scrollHeight)

    requestAnimationFrame(() => {
      this.isProgrammaticFeedScroll = false
      this.feedAutoScrollEnabled = this.isElementNearBottom(this.feed)
    })
  }

  scrollReasoningContentToBottom(reasoningBlock) {
    if (!reasoningBlock?.content || !reasoningBlock.isAutoScrollEnabled) {
      return
    }

    reasoningBlock.isProgrammaticScroll = true
    reasoningBlock.content.scrollTop = reasoningBlock.content.scrollHeight

    requestAnimationFrame(() => {
      reasoningBlock.isProgrammaticScroll = false
      reasoningBlock.isAutoScrollEnabled = this.isElementNearBottom(
        reasoningBlock.content
      )
    })
  }

  getWidgetPayload(formattedString) {
    if (
      typeof formattedString !== 'string' ||
      !formattedString.includes('"component":"WidgetWrapper"')
    ) {
      return null
    }

    try {
      return JSON.parse(formattedString)
    } catch {
      return null
    }
  }

  getPlanWidgetInsertionPoint(widgetPayload) {
    if (!widgetPayload || widgetPayload.widget !== 'PlanWidget') {
      return null
    }

    const reasoningBlocks = this.feed?.querySelectorAll(
      '.reasoning-block-container'
    )
    if (!reasoningBlocks || reasoningBlocks.length === 0) {
      return null
    }

    const isThinkingPhase = JSON.stringify(widgetPayload).includes('Thinking...')
    if (isThinkingPhase) {
      return reasoningBlocks[0]
    }

    const lastReasoningBlock = reasoningBlocks[reasoningBlocks.length - 1]
    return lastReasoningBlock?.nextSibling || null
  }

  loadFeed() {
    return new Promise(async (resolve) => {
      if (this.parsedBubbles === null || this.parsedBubbles.length === 0) {
        this.noBubbleMessage.classList.remove('hide')
        localStorage.setItem('bubbles', JSON.stringify([]))
        this.parsedBubbles = []
        resolve()
      } else {
        for (let i = 0; i < this.parsedBubbles.length; i += 1) {
          const bubble = this.parsedBubbles[i]

          // Skip tool output markers when recreating bubbles
          if (
            bubble.originalString &&
            ToolUIHandler.isToolOutputMarker(bubble.originalString)
          ) {
            continue
          }

          this.createBubble({
            who: bubble.who,
            string: bubble.originalString
              ? bubble.originalString
              : bubble.string,
            save: false,
            isCreatingFromLoadingFeed: true
          })

          if (i + 1 === this.parsedBubbles.length) {
            setTimeout(() => {
              resolve()
            }, 100)
          }
        }

        /**
         * Browse widgets that need to be fetched.
         * Reverse widgets to fetch the last widgets first.
         * Replace the loading content with the fetched widget
         */
        const widgetContainers = WIDGETS_TO_FETCH.reverse()
        for (let i = 0; i < widgetContainers.length; i += 1) {
          const widgetContainer = widgetContainers[i]
          const hasWidgetBeenFetched = WIDGETS_FETCH_CACHE.has(
            widgetContainer.widgetId
          )

          if (hasWidgetBeenFetched) {
            const fetchedWidget = WIDGETS_FETCH_CACHE.get(
              widgetContainer.widgetId
            )
            widgetContainer.reactRootNode.render(fetchedWidget.reactNode)

            setTimeout(() => {
              this.scrollDown()
            }, 100)

            continue
          }

          const data = await axios.get(
            `${this.serverURL}/api/v1/fetch-widget?skill_action=${widgetContainer.onFetch.actionName}&widget_id=${widgetContainer.widgetId}`
          )
          const fetchedWidget = data.data.widget
          const reactNode = fetchedWidget
            ? renderAuroraComponent(
                this.socket,
                fetchedWidget.componentTree,
                fetchedWidget.supportedEvents
              )
            : createElement(WidgetWrapper, {
                children: createElement(Flexbox, {
                  alignItems: 'center',
                  justifyContent: 'center',
                  children: createElement(Text, {
                    secondary: true,
                    children: 'This widget has been deleted.'
                  })
                })
              })

          widgetContainer.reactRootNode.render(reactNode)
          WIDGETS_FETCH_CACHE.set(widgetContainer.widgetId, {
            ...fetchedWidget,
            reactNode
          })
          setTimeout(() => {
            this.scrollDown()
          }, 100)
        }
      }
    })
  }

  createBubble(params) {
    const {
      who,
      string,
      save = true,
      bubbleId,
      isCreatingFromLoadingFeed = false,
      messageId,
      beforeElement = null
    } = params
    const container = document.createElement('div')
    const bubble = document.createElement('p')

    container.className = `bubble-container ${who}`
    bubble.className = 'bubble'

    if (messageId) {
      container.setAttribute('data-message-id', messageId)
    }

    // Store original string before formatting
    const originalString = string
    const formattedString = this.formatMessage(string)
    const widgetPayload = this.getWidgetPayload(formattedString)
    const autoPlanInsertionPoint = this.getPlanWidgetInsertionPoint(widgetPayload)
    const resolvedBeforeElement = beforeElement || autoPlanInsertionPoint

    bubble.innerHTML = formattedString

    if (bubbleId) {
      container.classList.add(bubbleId)
    }

    if (resolvedBeforeElement && resolvedBeforeElement.parentNode === this.feed) {
      this.feed.insertBefore(container, resolvedBeforeElement)
    } else {
      this.feed.appendChild(container)
    }
    container.appendChild(bubble)

    let widgetComponentTree = null
    let widgetSupportedEvents = null

    /**
     * Widget rendering
     */
    if (
      formattedString.includes &&
      formattedString.includes('"component":"WidgetWrapper"')
    ) {
      const parsedWidget = widgetPayload || JSON.parse(formattedString)
      container.setAttribute('data-widget-id', parsedWidget.id)

      /**
       * On widget fetching, render the loader
       */
      if (isCreatingFromLoadingFeed && parsedWidget.onFetch) {
        const root = createRoot(container)

        root.render(
          createElement(WidgetWrapper, {
            children: createElement(Flexbox, {
              alignItems: 'center',
              justifyContent: 'center',
              children: createElement(Loader)
            })
          })
        )

        WIDGETS_TO_FETCH.push({
          reactRootNode: root,
          widgetId: parsedWidget.id,
          onFetch: parsedWidget.onFetch
        })

        return container
      }

      widgetComponentTree = parsedWidget.componentTree
      widgetSupportedEvents = parsedWidget.supportedEvents

      /**
       * On widget creation
       */
      const root = createRoot(container)

      const reactNode = renderAuroraComponent(
        this.socket,
        widgetComponentTree,
        widgetSupportedEvents
      )

      root.render(reactNode)
    }

    if (save) {
      this.saveBubble(who, originalString, formattedString, messageId)
    }

    return container
  }

  createOrUpdateReasoningBlock(generationId, token) {
    if (!generationId || !token) {
      return null
    }

    if (!this.noBubbleMessage.classList.contains('hide')) {
      this.noBubbleMessage.classList.add('hide')
    }

    let reasoningBlock = this.reasoningBlocks.get(generationId)

    if (!reasoningBlock) {
      const container = document.createElement('div')
      const block = document.createElement('div')
      const header = document.createElement('div')
      const content = document.createElement('div')

      container.className = 'reasoning-block-container leon'
      container.setAttribute('data-reasoning-id', generationId)
      block.className = 'reasoning-block'
      header.className = 'reasoning-header'
      header.innerHTML = `
        <i class="ri-brain-line reasoning-icon"></i>
        <span class="reasoning-title">Reasoning</span>
      `
      content.className = 'reasoning-content'

      block.appendChild(header)
      block.appendChild(content)
      container.appendChild(block)
      this.feed.appendChild(container)

      reasoningBlock = {
        container,
        content,
        isAutoScrollEnabled: true,
        isProgrammaticScroll: false
      }
      content.addEventListener(
        'scroll',
        () => {
          if (reasoningBlock.isProgrammaticScroll) {
            return
          }

          reasoningBlock.isAutoScrollEnabled = this.isElementNearBottom(content)
        },
        { passive: true }
      )
      this.reasoningBlocks.set(generationId, reasoningBlock)
    }

    const tokenElement = document.createElement('span')
    tokenElement.className = 'reasoning-token fade-in'
    tokenElement.textContent = token

    reasoningBlock.content.appendChild(tokenElement)
    this.scrollReasoningContentToBottom(reasoningBlock)

    return reasoningBlock.container
  }

  handleToolOutput(data) {
    const result = this.toolUIHandler.handleToolOutput(data)

    // Save to localStorage if it's a new group
    if (result && result.isNewGroup) {
      const { toolkitName, toolName, answer } = data
      const toolInfo = this.toolUIHandler.getToolGroupInfo(
        result.groupId,
        toolkitName,
        toolName,
        answer
      )

      this.saveBubble(
        'leon',
        toolInfo.originalString,
        toolInfo.formattedMessage,
        toolInfo.messageId
      )
    }
  }

  saveBubble(who, originalString, string, messageId) {
    if (!this.noBubbleMessage.classList.contains('hide')) {
      this.noBubbleMessage.classList.add('hide')
    }

    if (this.parsedBubbles.length === 62) {
      this.parsedBubbles.shift()
    }

    // Store both original and formatted strings
    this.parsedBubbles.push({
      who,
      string,
      originalString,
      messageId
    })
    localStorage.setItem('bubbles', JSON.stringify(this.parsedBubbles))
    this.scrollDown()
  }

  formatMessage(message) {
    const isWidget =
      message.includes && message.includes('"component":"WidgetWrapper"')

    if (typeof message === 'string' && !isWidget) {
      message = message.replace(/\n/g, '<br />')

      // Handle HTTP/HTTPS URLs with simple regex
      message = message.replace(/https?:\/\/[^\s<>"{}|\\^`[\]]+/gi, (match) => {
        return `<a href="${match}" target="_blank" rel="noopener noreferrer" class="clickable-url" title="Open URL in browser">${match}</a>`
      })

      // Handle file paths with delimiters for exact matching
      message = message.replace(
        /\[FILE_PATH\](.*?)\[\/FILE_PATH\]/g,
        (match, filePath) => {
          return `<span class="clickable-path" data-path="${filePath}" title="Open in file explorer">${filePath}</span>`
        }
      )
    }

    return message
  }

  replaceMessage(replaceMessageId, newData) {
    const existingBubble = document.querySelector(
      `[data-message-id="${replaceMessageId}"]`
    )
    const nextSibling = existingBubble ? existingBubble.nextSibling : null

    if (existingBubble) {
      existingBubble.remove()

      const bubbleIndex = this.parsedBubbles.findIndex(
        (bubble) => bubble.messageId === replaceMessageId
      )
      if (bubbleIndex !== -1) {
        this.parsedBubbles.splice(bubbleIndex, 1)
      }
    }

    const widgetString =
      typeof newData === 'string' ? newData : JSON.stringify(newData)

    this.createBubble({
      who: 'leon',
      string: widgetString,
      save: false,
      messageId: replaceMessageId,
      beforeElement:
        newData?.widget === 'PlanWidget'
          ? null
          : nextSibling
    })

    /**
     * Only scroll down on the first replacement of this message
     * to avoid repeating scrolling for every message replacement
     */
    if (!REPLACED_MESSAGES.has(replaceMessageId)) {
      REPLACED_MESSAGES.add(replaceMessageId)
      this.scrollDown()
    }
  }

  openPath(filePath) {
    // Send request to server to open the file path in system file explorer
    fetch(`${this.serverURL}/api/v1/open-path`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: filePath })
    })
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) {
          console.error('Failed to open path:', data.error)
        }
      })
      .catch((error) => {
        console.error('Error opening path:', error)
      })
  }
}
