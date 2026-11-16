// The chat sites the side panel can show. DeepSeek is the default; the choice is remembered
// in chrome.storage.local under "provider". To add another site: add it here, add its address to
// the content script matches in manifest.json, and give it input selectors in selectors.js.
//   shortIntro: use the short "answer the question, else explain" intro instead of the style rules.
//   imageVia:   order of ways to attach a snapshot; the first one that shows an attachment wins.
//   chatsUrl:   page listing past chats, opened by the Chats button (for sites whose own menu is hidden at panel width).
//   replyButton: show our Ask button on text selected in the site's own replies (the others have their own).
globalThis.ASK_PROVIDERS = {
  deepseek: { id: 'deepseek', name: 'DeepSeek', origin: 'https://chat.deepseek.com', url: 'https://chat.deepseek.com/',  imageVia: ['paste', 'drop', 'input'], replyButton: true },
  claude:   { id: 'claude',   name: 'Claude',   origin: 'https://claude.ai',          url: 'https://claude.ai/new',       imageVia: ['input', 'drop', 'paste'], shortIntro: true, chatsUrl: 'https://claude.ai/recents' },
  chatgpt:  { id: 'chatgpt',  name: 'ChatGPT',  origin: 'https://chatgpt.com',        url: 'https://chatgpt.com/',        imageVia: ['paste', 'input', 'drop'] },
  gemini:   { id: 'gemini',   name: 'Gemini',   origin: 'https://gemini.google.com',  url: 'https://gemini.google.com/app', imageVia: ['paste', 'drop', 'input'] }
};
globalThis.ASK_DEFAULT_PROVIDER = 'deepseek';
