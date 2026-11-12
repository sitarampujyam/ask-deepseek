# Ask DeepSeek

> **Heads up:** a lot of vibe coding went into this extension. I shaped it around my own taste, mainly to fix the things I
> found annoying about Chrome's built-in PDF viewer. I built it for personal use only, but other people might find it
> useful too, so I put it on GitHub. Issues and pull requests are welcome.

A Chrome extension that puts DeepSeek in your side panel and makes it easy to ask about whatever you're reading.

Select some text on any page, click the small **Ask DeepSeek** button that pops up, and the text lands in DeepSeek's
message box. You write your question and press send yourself. The extension never sends anything for you.

It also comes with its own PDF reader, because Chrome's built-in one can't talk to extensions.

Not affiliated with DeepSeek. This just embeds their public chat site, the same one you'd use in a tab.

## Install

You don't need the Chrome Web Store or any coding. It takes about a minute.

1. **Get the files.** On this page click the green **Code** button, then **Download ZIP**. Unzip it somewhere you won't
   delete it later (the extension runs from that folder). If you use git: `git clone https://github.com/sitarampujyam/ask-deepseek.git`
2. In Chrome, open `chrome://extensions` (paste it in the address bar).
3. Turn on **Developer mode** (switch at the top right).
4. Click **Load unpacked** and pick the folder that contains `manifest.json`.
5. Click the puzzle-piece icon in the toolbar and pin **Ask DeepSeek**.
6. Click the extension icon. The side panel opens with DeepSeek. Sign in once.
7. Refresh any tabs you already had open. Extensions only attach to pages loaded after they're installed.
8. Want it on local PDFs (files on your computer)? On the extension's card in `chrome://extensions` click **Details** and
   switch on **Allow access to file URLs**.

Needs Chrome 114 or newer. Other Chromium browsers (Edge, Brave, Arc) should work the same way, but I've only tested Chrome.

To update later, replace the folder with the new download and press the reload arrow on the extension's card.

## How to use it

- **Ask about text:** open the side panel (click the icon, or press `Option+D` on Mac / `Alt+Shift+D` elsewhere), select
  text on any page, click the button that appears. Press the shortcut again to close the panel.
- **Ask about a PDF:** open any link ending in `.pdf`. It opens in the reader. Select text there and the button always
  shows, even if the panel is closed (it opens the panel for you).
- **Snapshot:** click the camera in the reader's toolbar, or the Snapshot button at the top of the side panel, to paste a picture of what's on screen into the message box.
- **Summarise:** the Summarise button in the side panel pastes the active tab's text and a screenshot, with a short instruction to summarise it.

## Features

**Asking**
- Floating glass button on selected text, on every normal web page (while the panel is open) and always in the PDF reader.
- Fills DeepSeek's message box and puts the cursor at the end. Never presses send.
- Adds a source line with the page title, the PDF page number and the link. A second selection is appended below the first.
- Starts the box with a short instruction telling DeepSeek to explain the text plainly. Add your own question and it follows that instead.
- Snapshot of the visible part of a page or PDF, pasted as an image. Held in memory only, never saved to disk.
- Summarise button for web pages: page text plus a screenshot.
- Declines DeepSeek's cookie banner for you (necessary cookies only), since it can't remember the choice inside a panel.
- If DeepSeek refuses to load inside the side panel, the panel offers a docked popup window and everything works there.
- Right-click a link or page, **Open in Ask DeepSeek reader**, for PDFs that don't end in `.pdf`.

**PDF reader**
- Continuous scrolling, page counter, jump to page by typing a number.
- Zoom with the buttons, a typed percentage, `Ctrl`/`Cmd` plus `+`, `-`, `0`, pinch or `Ctrl`+scroll. Fit to page or fit to width.
- Rotate pages.
- Thumbnail panel on the left that follows your scrolling.
- Two-page view.
- Page colours: Original, Dark, Sepia. Only the pages change.
- Light, Dark or System theme for the reader itself.
- Seven colour themes (Violet, Magenta, Rose, Amber, Emerald, Teal, Ocean), under the three-dots menu.
- Present mode (fullscreen, arrow keys or space to turn pages).
- Print, download, document properties, password-protected PDFs.
- Opens big files quickly: loads the PDF in pieces, draws visible pages first.
- Remembers the page, scroll position, zoom and rotation you left each PDF at. A link ending in `#page=5` overrides it.
- Switch to Chrome's own viewer for the current file at any time.

**Annotating** (pen button in the reader)
- Highlight text, or drag over empty space to highlight freehand.
- Draw with a pen, set colour and thickness.
- Type text boxes, set colour and size.
- Select tool to move, resize or delete marks. Draw and Text never grab old marks, so you can draw right over them.
- Undo and redo.
- Marks stay in the tab until you save, like Chrome's viewer. An orange dot warns you about unsaved changes, and closing the tab asks first.
- Download either a copy with your marks (real PDF highlight, ink and text annotations, so other PDF apps see them) or the untouched original.
- Marks show up in prints and snapshots.

## Privacy

Selected text, the page title and the link only ever go into the DeepSeek message box on your own screen. They leave your
browser when you press send in DeepSeek, not before. There is no analytics, no tracking and no server of mine. The only
network traffic is the PDF you open and DeepSeek itself.

Reading position and settings are stored in your browser. Options has a switch to stop remembering positions and a button to wipe them.

## Why it asks for those permissions

| Permission | Why |
|---|---|
| Access to all sites | To show the Ask DeepSeek button on whatever page you're on, and to read PDFs from any link. |
| `sidePanel` | The DeepSeek side panel. |
| `declarativeNetRequest` | DeepSeek normally refuses to be embedded in other pages. A rule removes the `X-Frame-Options` and `Content-Security-Policy` headers, only on DeepSeek's own frame inside this extension's panel. It touches nothing else. |
| `storage` | Your settings. |
| `contextMenus` | The right-click "Open in Ask DeepSeek reader" entry. |
| `webNavigation`, `scripting` | Catching `.pdf` links and tracking the panel's open state. |

## Options

Open the extension's options page (right-click the icon, then Options):
- Open PDF links in the reader (on by default). Turn it off to use Chrome's viewer again.
- Remember where I stopped in each PDF.
- Forget all saved positions.

## If DeepSeek changes its website

The button fills the message box by looking for it on the page. If DeepSeek redesigns and filling stops working, the
selectors live in `selectors.js`, in one place, and are easy to update.

## Limits

- Scanned PDFs have no text to select, so highlighting and asking won't work on them.
- Existing annotations already inside a PDF can't be edited yet, and you can't insert images.
- Chrome doesn't let extensions run on `chrome://` pages, the Web Store or Chrome's built-in PDF viewer.
- Snapshot relies on DeepSeek accepting a pasted image. If they change that, it may stop attaching.

## Files

| File | What it does |
|---|---|
| `viewer.html`, `viewer.js`, `viewer.css` | The PDF reader |
| `sidepanel.html`, `sidepanel.js`, `sidepanel.css` | The side panel with DeepSeek and the Snapshot/Summarise strip |
| `background.js` | Header rule, PDF interception, shortcut, message routing |
| `page-button.js` | The floating button on pages and in the reader |
| `content.js` | Runs inside DeepSeek, fills the message box |
| `selectors.js` | Everything that depends on DeepSeek's page layout |
| `options.html`, `options.js` | Settings |
| `lib/` | PDF.js 4.10.38 (Apache-2.0), bundled so nothing is downloaded |

## License

MIT, see `LICENSE`. PDF.js in `lib/` is Apache-2.0.
