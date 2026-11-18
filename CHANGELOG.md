# Changelog

## 2.0.0

**New chats**
- Renamed from Ask DeepSeek to **Ask LLM**.
- Claude, ChatGPT and Gemini join DeepSeek. Pick one from the menu at the top of the side panel; it remembers your last pick. DeepSeek stays the default.
- The Ask button is labelled with the chat you picked (Ask Claude, Ask ChatGPT, ...).
- Claude gets a shorter intro: answer the question if there is one, otherwise explain the text.
- Chats button for Claude, which hides its chat list at side panel width. It opens your Claude chats right in the panel.
- Select part of a DeepSeek reply and the Ask button lets you ask a follow-up about just that bit. Always on. (Claude, ChatGPT and Gemini have their own button for this.)

**Better UI**
- New icon: a minimal rounded-square glass chat bubble with no background. The toolbar icon and the options page take the reader's colour theme.
- The side panel's top bar is a floating liquid-glass pill that sits on the chat's own background colour and turns light or dark to match it.
- Reload button in the panel, for a stuck sign-in or bot check.
- Redesigned options page: glass cards and toggle switches, following the reader's theme and colour.
- Seven colour themes for the reader (Violet, Magenta, Rose, Amber, Emerald, Teal, Ocean).
- PDF annotating: highlight, draw and text notes, with a Select tool for moving marks, undo/redo, and saving a copy with your marks.
- The reader remembers the page, zoom and rotation you left each PDF at.

**Bug fixes**
- The Ask button now appears on Claude, ChatGPT, Gemini and DeepSeek when they're open in a normal tab, and sends to the side panel (a side chat about your chat with another AI). Before, it was missing there, and on the DeepSeek website it pasted into the page itself instead of the panel.
- Snapshots now attach in Claude. Each site takes images differently, so the extension tries paste, the attach button and drag-and-drop in turn, and stops at the first one that works. If a site refuses all three, the image goes on your clipboard.
- Cookie banners are rejected automatically on Claude as well as DeepSeek.
- Clicking the Ask button on a page that was open before the extension was reloaded now says to reload the page, instead of a misleading "open the panel".
- Undo and redo icons in the annotation bar were redrawn.
- Drawing or typing on top of an existing mark no longer drags it.

## 1.0.0

- First release: DeepSeek in the side panel, the Ask button for selected text, and the glass PDF reader.
