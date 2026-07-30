// The chrome renderer. Plain JS on purpose: it is loaded straight from disk by
// the chrome view, so there is nothing to build, and everything it can do is
// what preload.ts chose to expose.
const $ = (id) => document.getElementById(id);

const address = $("address");
const status = $("status");
const tabList = $("tabs");
const backBtn = $("back");
const forwardBtn = $("forward");
const settingsDialog = $("settings");
const settingsError = $("settingsError");

let addressFocused = false;
address.addEventListener("focus", () => (addressFocused = true));
address.addEventListener("blur", () => (addressFocused = false));

/** Tab labels are page titles — hostile input — so they go in as text. */
function renderTabs(tabs) {
  tabList.replaceChildren();
  for (const tab of tabs) {
    const item = document.createElement("li");
    item.className = "tab";
    if (tab.active) item.dataset.active = "true";

    const select = document.createElement("button");
    select.className = "select";
    select.type = "button";
    select.textContent = tab.title || "New tab";
    select.title = tab.url;
    select.addEventListener("click", () => window.httpx.selectTab(tab.id));

    const close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.textContent = "✕";
    close.title = "Close tab";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      window.httpx.closeTab(tab.id);
    });

    item.append(select, close);
    tabList.append(item);
  }
}

function applyState(state) {
  status.dataset.state = state.connection;
  status.textContent =
    state.connection === "online"
      ? "online"
      : state.connection === "connecting"
        ? "connecting…"
        : "offline";
  // Don't yank the address bar out from under someone who is typing in it.
  if (!addressFocused) address.value = state.url === "about:blank" ? "" : state.url;
  backBtn.disabled = !state.canGoBack;
  forwardBtn.disabled = !state.canGoForward;
  document.title = state.url ? `${state.url} — httpx` : "httpx";
  renderTabs(state.tabs);
}

window.httpx.onState(applyState);
window.httpx.onSettings((settings) => {
  if (settings.service) $("service").value = settings.service;
  if (settings.jid) $("jid").value = settings.jid;
  if (settings.password) $("password").value = settings.password;
  if (!settings.service || !settings.jid) settingsDialog.showModal();
});

$("nav").addEventListener("submit", (event) => {
  event.preventDefault();
  window.httpx.navigate(address.value);
  address.blur();
});
backBtn.addEventListener("click", () => window.httpx.back());
forwardBtn.addEventListener("click", () => window.httpx.forward());
$("reload").addEventListener("click", () => window.httpx.reload());
$("newTab").addEventListener("click", () => window.httpx.newTab());
$("settingsBtn").addEventListener("click", () => settingsDialog.showModal());

$("settingsForm").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "connect") return;
  settingsError.hidden = true;
  void window.httpx
    .connect({
      service: $("service").value.trim(),
      jid: $("jid").value.trim(),
      password: $("password").value,
    })
    .then((result) => {
      if (result && result.ok === false) {
        settingsError.textContent = result.error;
        settingsError.hidden = false;
        settingsDialog.showModal();
      }
    });
});

void window.httpx.state().then(applyState);
