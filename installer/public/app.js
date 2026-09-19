const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
let language = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
let accounts = [];

function translate() {
  document.documentElement.lang = language === "zh" ? "zh-Hans" : "en";
  document.querySelectorAll("[data-zh]").forEach((element) => {
    element.textContent = element.dataset[language];
  });
  $("#language").textContent = language === "zh" ? "EN" : "中文";
}

function show(id) {
  ["start", "account", "progress", "success"].forEach((name) => $(`#${name}`).classList.toggle("hidden", name !== id));
}

async function loadSession() {
  show("progress");
  const response = await fetch("/api/session", { credentials: "same-origin" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Session expired");
  if (!data.authorized) {
    show("start");
    return;
  }
  accounts = data.accounts || [];
  if (!accounts.length) throw new Error("No Cloudflare account is available");
  $("#accounts").replaceChildren(...accounts.map((account, index) => {
    const label = document.createElement("label");
    label.className = "account-choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "account";
    input.value = account.id;
    input.checked = index === 0;
    label.append(input, document.createTextNode(account.name));
    return label;
  }));
  show("account");
}

async function install() {
  const accountId = document.querySelector('input[name="account"]:checked')?.value;
  if (!accountId) return;
  show("progress");
  const response = await fetch("/api/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ accountId })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Installation failed");
  $("#openApp").href = `${data.appUrl}#claim=${encodeURIComponent(data.setupCode)}`;
  show("success");
}

function fail(error) {
  show("progress");
  $("#progressTitle").textContent = language === "zh" ? "安装暂时没有完成" : "Installation did not finish";
  $("#progressDetail").textContent = error.message || String(error);
  $("#progressDetail").classList.add("error");
  $(".spinner").classList.add("hidden");
  $(".bar").classList.add("hidden");
  $("#retry").classList.remove("hidden");
}

$("#language").addEventListener("click", () => { language = language === "zh" ? "en" : "zh"; translate(); });
$("#install").addEventListener("click", () => install().catch(fail));
$("#retry").addEventListener("click", () => location.assign("/oauth/start"));
translate();
if (params.get("error")) fail(new Error(language === "zh" ? "Cloudflare 授权没有完成，请重试。" : "Cloudflare authorization did not finish. Please try again."));
else loadSession().catch((error) => {
  fail(error);
});
