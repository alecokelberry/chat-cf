// A chat's thread and composer, live over a WebSocket to the chat's agent
// (src/lib/chat/agent.ts), for a saved chat's page (src/routes/_app/c.$id.tsx)
// and a private chat's (src/routes/_app/private.tsx). Messages load from the
// agent, so the browser renders the rest. When the agent says the chat list
// changed, the sidebar loads it again; when it says the chat is being
// deleted (from another tab), this tab goes to a new chat. A new chat
// arrives with its first message: it skips loading (there's nothing yet)
// and sends it with any images it attached once, then tells the page
// (onFirstSent). Each message carries its model in its metadata
// (src/lib/ai/models.ts), so the picker reopens on the chat's last, and
// Retry, which regenerates the last reply in place, asks the same one; and
// the browser's time zone, so the model knows what "today" is. An edited
// question is sent in the old one's place, with the picker's model: the SDK
// drops it and everything after it, here and in the agent, and the reply is
// asked again. A new chat's composer takes focus as it opens: the first
// send came from the new-chat page's composer (Enter, or Send, which Safari
// doesn't focus), so typing can go on. A reload (or a second tab) while a
// reply streams picks it up where it is: useAgentChat asks the agent to
// resume, and the agent replays the chunks it has kept, then streams the
// rest. In dev, ?data= shows made-up messages instead
// (src/lib/dev/worst-case.ts) and Send, Retry and Edit do nothing, so a
// preview never writes to a chat.
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useRouter, useSearch } from "@tanstack/react-router"
import { useAgent } from "agents/react"
import { useAgentChat } from "@cloudflare/ai-chat/react"

import { useListChanged } from "@/components/chat/chat-list"
import { Composer } from "@/components/chat/composer"
import { Thread } from "@/components/chat/thread"
import { toast } from "@/components/ui/toast"
import { lastModel, type ModelKey } from "@/lib/ai/models"
import {
  questionParts,
  takeHandedOffFiles,
  type AttachmentPart,
} from "@/lib/chat/attachments"
import { CHAT_DELETED, CHATS_CHANGED } from "@/lib/chat/events"
import { previewEnabled, previewMessages } from "@/lib/dev/worst-case"

/** A chat's page: the thread fills it, under a header that floats over it.
 *  No top pad: the header floats over the thread, whose own pad sets where
 *  the last question rests (message-scroller.tsx). */
export function ChatPage({ children }: { children: ReactNode }) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col safe-area pt-0 outline-hidden"
    >
      {children}
    </main>
  )
}

/** The header over a chat: its title pill centered, which taps go through
 *  to the page and the phone's sidebar button 88px clear of on either
 *  side, and a gradient fading the thread under it on a computer. */
export function ChatHeaderBar({ children }: { children: ReactNode }) {
  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-10 box-content flex h-header items-center justify-center px-22 pt-safe md:bg-linear-to-b md:from-background md:from-60%">
      {children}
    </header>
  )
}

/** A question's metadata: its model and the browser's time zone. */
const sentWith = (model: ModelKey) => ({
  model,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
})

/** What a new chat's first send hands its chat to send: the words, the
 *  model, and how many files went ahead in memory (handOffFiles). */
export type FirstMessage = { text: string; model: ModelKey; files?: number }

// Memoized: the screen re-renders whenever the chat list changes (its
// header reads it), and the thread needn't.
export const Chat = memo(function Chat({
  id,
  firstMessage,
  onFirstSent,
  isPrivate,
}: {
  id: string
  /** A new chat's first message, sent once the socket is up. */
  firstMessage?: FirstMessage
  /** Told once the first message is on its way. */
  onFirstSent?: () => void
  /** A private chat: its composer's border is dashed. */
  isPrivate?: boolean
}) {
  const [isNew] = useState(firstMessage !== undefined)
  const router = useRouter()
  const listChanged = useListChanged()
  const { data } = useSearch({ from: "/_app" })
  // The first message waits for the socket to open: one sent sooner is
  // queued on the socket, and useAgent can swap that socket for a new one
  // before it opens (it did on every first send in dev), losing it.
  const [open, setOpen] = useState(false)
  const agent = useAgent({
    agent: "ChatAgent",
    basePath: `api/chats/${id}`,
    onOpen: () => setOpen(true),
    onMessage: (event) => {
      if (event.data === CHATS_CHANGED) void listChanged()
      if (event.data === CHAT_DELETED) void router.navigate({ to: "/" })
    },
  })
  const {
    messages,
    sendMessage,
    regenerate,
    stop,
    status,
    error,
    isStreaming,
  } = useAgentChat({
    agent,
    getInitialMessages: isNew ? null : undefined,
    // A new chat has no reply to pick back up. Trying anyway races its
    // first send and ends it early, so the screen would look idle until
    // the first word.
    resume: !isNew,
  })
  const sent = useRef(false)
  // Stop shows the cut-off reply as it arrived, not paced (thread.tsx).
  const [stopped, setStopped] = useState(false)
  const [model, setModel] = useState(
    firstMessage?.model ?? lastModel(messages).key
  )

  useEffect(() => {
    if (firstMessage === undefined || sent.current || !open) return
    sent.current = true
    onFirstSent?.()
    const files = takeHandedOffFiles(id)
    // A reload before the first send keeps the words (history state) but
    // not the files (memory): say so rather than send without them.
    if (files.length < (firstMessage.files ?? 0)) {
      toast.error("Your files didn't come through. Attach them again.")
      if (firstMessage.text === "") return
    }
    void sendMessage({
      parts: questionParts(firstMessage.text, files),
      metadata: sentWith(firstMessage.model),
    })
  }, [firstMessage, sendMessage, onFirstSent, id, open])

  // isStreaming also covers a reply another tab started.
  const previewing = previewEnabled && data !== undefined
  const shown = useMemo(() => previewMessages(messages, data), [messages, data])
  // Stable, so the thread's past questions don't re-render as a reply
  // streams (thread.tsx).
  const onEdit = useCallback(
    (messageId: string, text: string, attachments: AttachmentPart[]) => {
      if (previewing) return
      setStopped(false)
      void sendMessage({
        parts: questionParts(text, attachments),
        messageId,
        metadata: sentWith(model),
      })
    },
    [previewing, sendMessage, model]
  )
  const busy = status === "submitted" || status === "streaming" || isStreaming
  return (
    <>
      <Thread
        messages={shown}
        busy={busy}
        stopped={stopped}
        error={
          status === "error" ? (error?.message ?? "Request failed.") : undefined
        }
        onRetry={() => {
          if (previewing) return
          setStopped(false)
          void regenerate()
        }}
        model={model}
        onModelChange={setModel}
        onEdit={onEdit}
      />
      {/* 24px in and up from the screen's edges on a phone, in line with
          the thread's text; 16px in on a computer. */}
      <div className="mx-auto w-full max-w-composer px-2 pb-2 sm:px-0">
        <Composer
          isPrivate={isPrivate}
          focusOnMount={isNew}
          busy={busy}
          model={model}
          onModelChange={setModel}
          onSend={(text, files) => {
            if (previewing) return
            setStopped(false)
            void sendMessage({
              parts: questionParts(text, files),
              metadata: sentWith(model),
            })
          }}
          onStop={() => {
            setStopped(true)
            return stop()
          }}
        />
      </div>
    </>
  )
})
