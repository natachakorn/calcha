// Deployment settings for CalCha.
// proxyUrl: URL of the Cloudflare Worker in /worker that holds a shared Gemini key.
// When set, users can analyse photos without getting their own key. Leave '' to require a personal key.
window.CALCHA_CONFIG = {
  proxyUrl: '',
};
