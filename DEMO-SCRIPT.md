# Demo walkthrough

Aim for 2–3 minutes. The timing is a guide; leave a moment after each action so
the reviewer can see the result. Read the quoted text aloud, not the action notes.

## Before recording

- Open the deployed app and wait for the inbox and live messages to load.
- Keep the app tab large enough to read. Close DevTools except when showing the
  narrow-screen layout, and use a separate window for your notes.
- Wait for a real handoff with a visible reason. A conversation that started in
  “Needs human” may not have a reason because the mock does not return it in REST.
- Prepare one genuinely failed reply for the retry segment. Rejection is random;
  do not change the mock or promise that the next send will fail.

## 0:00–0:20 — Introduction

**Show:** The inbox and an open conversation.

> This is my Hams.AI assessment: a live conversation monitor built with React
> and TypeScript. A supervisor can follow customer conversations, watch AI
> replies stream, and take over when human assistance is requested.

## 0:20–0:40 — Live updates

**Show:** An AI reply streaming and the changing inbox preview.

> The inbox shows each customer, conversation status, latest message, and unread
> count. These update as events arrive. Inside the selected conversation, the
> AI response appears progressively. Other conversations keep receiving updates
> in the background.

## 0:40–1:00 — Large history

**Show:** Sara's conversation, which starts with 5,000 messages. Scroll into older
messages, allow a new arrival, then select Jump to latest.

> This conversation starts with five thousand messages. The list renders only
> the visible rows and a small buffer. Scrolling back pauses automatic
> following. The new-message count and this button let me return to the latest
> messages when I am ready.

## 1:00–1:35 — Handoff, reply, and retry

**Show:** A received handoff reason, Take over, and a reply being sent. Show the
prepared failed bubble and retry it. If demonstrating draft preservation, type
a separate draft before pressing Retry. Do not submit that draft.

> When the AI requests help, the reason appears here. Taking over enables the
> reply composer. A reply appears immediately while sending. If the server
> rejects it, the message is marked as failed, with Retry inside its bubble.
> Retrying that message leaves a newer draft untouched.

Only describe a retry as successful after the failed state has actually cleared.
The mock may reject the retry too. This segment can be recorded separately if
waiting for a rejection would make the walkthrough too long.

## 1:35–1:55 — Reconnection

**Show:** An actual reconnect toast followed by recovery and continued updates.
The mock disconnects every 20–40 seconds, so this segment can happen earlier.

> The mock deliberately drops connections. The app reconnects using its last
> processed event ID and ignores events it has already handled. The toast
> reports recovery, and live updates continue.

If using DevTools Offline instead, set it back to No throttling before continuing.
An offline send is “Delivery unconfirmed,” which is different from a server rejection.

## 1:55–2:20 — Arabic and mobile layout

**Show:** Switch to Ar, show a mixed-language message, then narrow the viewport
below 1024px and open the inbox drawer. Restore the desktop layout afterward.

> Arabic changes the interface language and layout direction. Each message keeps
> its natural text direction, including mixed Arabic and English. On smaller
> screens, the inbox moves into a drawer.

## 2:20–2:40 — Technical closing

**Show:** Return to the app, or briefly show State ownership in the README.

> TanStack Query manages server data. Zustand holds live and temporary state,
> and React Context shares the controller. The tests cover stream ordering,
> reconnect deduplication, handoff, replies, and large-history rendering.

## Before sharing

Watch the recording once to check that the text and microphone audio are clear.
Make sure the video link is viewable by the hiring team, and include it beside
the live demo and source links in the submission.
