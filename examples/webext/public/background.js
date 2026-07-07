// Stateless event router: the XMPP connection lives in browser.html (the
// tab page), so MV3 service-worker lifetime never matters here.
// Plain script (no imports) so the same file works as a Chrome service
// worker and as a Firefox event-page script.
const api = globalThis.browser ?? globalThis.chrome;

function openBrowser(url) {
  const target =
    api.runtime.getURL("browser.html") + (url ? "#" + encodeURIComponent(url) : "");
  api.tabs.create({ url: target });
}

// Cross-browser address-bar entry: type "httpx server@example.org/page" ⏎
if (api.omnibox) {
  api.omnibox.onInputEntered.addListener((text) => {
    const url = text.includes("://") ? text : "httpx://" + text;
    openBrowser(url);
  });
}

api.action.onClicked.addListener(() => openBrowser(""));
