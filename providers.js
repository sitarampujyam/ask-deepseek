// The chat sites the side panel can show. DeepSeek is the default; the choice is remembered
// in chrome.storage.local under "provider". To add another site, add it here, to the
// content script matches in manifest.json, and give it input selectors in selectors.js.
globalThis.ASK_PROVIDERS = {
  deepseek: { id: 'deepseek', name: 'DeepSeek', origin: 'https://chat.deepseek.com', url: 'https://chat.deepseek.com/' },
  claude:   { id: 'claude',   name: 'Claude',   origin: 'https://claude.ai',          url: 'https://claude.ai/new' }
};
globalThis.ASK_DEFAULT_PROVIDER = 'deepseek';
