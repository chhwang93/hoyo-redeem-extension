import { loadAll, formatTime } from "./storage.js";
import { STATUS } from "./redeem.js";
import { SOURCES } from "./sources.js";
import { GAMES, GAME_IDS, regionFromUid, regionName } from "./games.js";
import { statusBadge, recentCodes, entryMessage, el, send } from "./ui.js";

const MAX_ROWS = 20;
// 서비스 워커가 확인 도중 내려가면 running 표시가 남는다. 이보다 오래된 표시는 무시한다.
const RUNNING_STALE_MS = 15 * 60 * 1000;
const LOGIN_VIEW = {
  ok: { text: "로그인됨", tone: "ok" },
  required: { text: "로그인 필요", tone: "bad" },
};
const LOGIN_UNKNOWN = { text: "로그인 확인 전", tone: "" };
const $ = (id) => document.getElementById(id);

function accountText(gameId, settings, meta) {
  const { uid, region } = settings.accounts[gameId];
  if (!uid) return meta.noRole?.[gameId] ? "캐릭터 없음" : "다음 확인 때 찾아요";
  const role = meta.roles?.[gameId];
  const nickname = role?.uid === uid ? `${role.nickname} · ` : "";
  return `${nickname}${regionName(gameId, region || regionFromUid(gameId, uid))}`;
}

function renderLogin(settings, meta) {
  const state = meta.login?.state;
  const view = LOGIN_VIEW[state] ?? LOGIN_UNKNOWN;
  $("login").hidden = state !== "required";
  $("login-text").textContent = view.text;
  document.querySelector(".login .dot").className = `dot ${view.tone}`;

  const rows = GAME_IDS.filter((id) => settings.games[id]).map((id) =>
    el("li", {}, el("span", { className: "game" }, GAMES[id].short), el("span", {}, accountText(id, settings, meta))),
  );
  $("accounts").replaceChildren(...(rows.length ? rows : [el("li", { className: "muted" }, "켜 둔 게임이 없어요")]));
}

function renderSummary(run) {
  if (!run) return;
  const parts = [`코드 ${run.found}개`, `시도 ${run.attempted}개`, `받음 ${run.successes.length}개`];
  if (run.stopReason) parts.push(`멈춤: ${STATUS[run.stopReason]?.label ?? run.stopReason}`);
  $("summary").textContent = `지난번 확인: ${parts.join(" · ")}`;
  $("warning").textContent = run.sourceErrors?.length
    ? `코드를 못 가져온 곳: ${run.sourceErrors.map((e) => `${GAMES[e.game]?.short ?? ""} ${SOURCES[e.source]?.name ?? e.source}`).join(", ")}`
    : "";
}

function resultBadge(game, code, status) {
  if (status !== "verify_required") return statusBadge(status);
  const button = el("button", { className: "badge warn", title: "교환 페이지 열기" }, STATUS[status].label);
  button.addEventListener("click", () => send("openGiftPage", { game, code }));
  return button;
}

function renderResults(codes) {
  const rows = recentCodes(codes)
    .slice(0, MAX_ROWS)
    .map(({ game, code, entry }) => {
      const row = el(
        "tr",
        {},
        el("td", { className: "game" }, GAMES[game].short),
        el("td", { className: "code mono" }, code),
        el("td", {}, resultBadge(game, code, entry.status)),
        el("td", { className: "time" }, formatTime(entry.triedAt)),
      );
      row.title = entryMessage(entry);
      return row;
    });
  $("results").replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { colSpan: 4, className: "empty" }, "아직 기록이 없어요"))]));
}

async function render() {
  const [{ settings, codes, meta }, { running }, alarm] = await Promise.all([
    loadAll(),
    chrome.storage.local.get("running"),
    chrome.alarms.get("check-codes"),
  ]);
  const busy = Boolean(running) && Date.now() - Date.parse(running.since) < RUNNING_STALE_MS;
  renderLogin(settings, meta);
  $("last-check").textContent = formatTime(meta.lastCheckAt);
  $("next-check").textContent = alarm ? formatTime(new Date(alarm.scheduledTime).toISOString()) : "-";
  $("run").disabled = busy;
  $("run").textContent = busy ? "확인하는 중…" : "지금 확인";
  renderSummary(meta.lastRun);
  renderResults(codes);
}

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  $("run").textContent = "확인하는 중…";
  const res = await send("runNow");
  await render();
  if (res?.error) $("warning").textContent = `오류: ${res.error}`;
  else if (res?.busy) $("warning").textContent = "이미 돌던 확인이 끝나서 그 결과를 보여 줘요.";
});

$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("login").addEventListener("click", async () => {
  const { settings } = await loadAll();
  send("openGiftPage", { game: GAME_IDS.find((id) => settings.games[id]) });
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") render();
});

render();
