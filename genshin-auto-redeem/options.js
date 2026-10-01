import { loadAll, saveAll, clampInterval, formatTime, normalizeSettings } from "./storage.js";
import { GAMES, GAME_IDS, SERVERS, SERVER_NAMES, regionFromUid, regionName } from "./games.js";
import { STATUS, TRANSPORT_NAMES } from "./redeem.js";
import { statusBadge, recentCodes, entryMessage, el, send } from "./ui.js";

const $ = (id) => document.getElementById(id);
let savedTimer;

async function save(patch) {
  await saveAll({ settings: patch });
  $("saved").classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $("saved").classList.remove("show"), 1200);
}

function busy(button, label) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  return () => {
    button.disabled = false;
    button.textContent = original;
  };
}

const BUSY_TEXT = "다른 작업이 끝날 때까지 기다렸어요. 한 번 더 눌러 주세요.";

// ---------------------------------------------------------------- 폼 만들기 (한 번)

function buildForm() {
  for (const id of GAME_IDS) {
    const box = el("input", { type: "checkbox", id: `game-${id}` });
    box.addEventListener("change", async () => {
      await save({ games: { ...(await loadAll()).settings.games, [id]: box.checked } });
    });
    $("games").append(el("label", {}, box, ` ${GAMES[id].name}`));
    $("code-game").append(el("option", { value: id }, GAMES[id].name));

    const uid = el("input", { type: "text", id: `uid-${id}`, inputMode: "numeric", maxLength: 10, placeholder: "자동", autocomplete: "off" });
    const region = el("select", { id: `region-${id}` }, el("option", { value: "" }, "UID로 추정"));
    for (const server of SERVERS) region.append(el("option", { value: GAMES[id].regions[server] }, SERVER_NAMES[server]));
    uid.addEventListener("change", () => saveAccount(id));
    region.addEventListener("change", () => saveAccount(id));
    $("accounts").append(
      el("tr", { id: `account-${id}` }, el("td", {}, GAMES[id].short), el("td", {}, uid), el("td", {}, region), el("td", { className: "state", id: `state-${id}` })),
    );
  }
}

async function saveAccount(id) {
  const uid = $(`uid-${id}`).value.trim();
  if (uid && !/^\d{9,10}$/.test(uid)) {
    $(`state-${id}`).textContent = "UID는 9~10자리 숫자예요";
    return;
  }
  const guessed = regionFromUid(id, uid);
  if (uid && !$(`region-${id}`).value && guessed) $(`region-${id}`).value = guessed;
  await save({ accounts: { [id]: { uid, region: $(`region-${id}`).value, source: uid ? "manual" : "" } } });
}

/** 입력 중인 칸은 건드리지 않는다. 확인이 계정을 저장하면서 폼이 다시 채워질 수 있다. */
function setField(id, prop, value) {
  const field = $(id);
  if (document.activeElement !== field) field[prop] = value;
}

function fillForm(settings) {
  for (const id of GAME_IDS) {
    setField(`game-${id}`, "checked", settings.games[id]);
    $(`account-${id}`).classList.toggle("off", !settings.games[id]);
    setField(`uid-${id}`, "value", settings.accounts[id].uid);
    setField(`region-${id}`, "value", settings.accounts[id].region);
  }
  setField("interval", "value", settings.intervalMinutes);
  setField("lang", "value", settings.lang);
  setField("transport", "value", settings.transport);
  setField("src-hoyoCodes", "checked", settings.sources.hoyoCodes);
  setField("src-fandom", "checked", settings.sources.fandom);
}

// ---------------------------------------------------------------- 상태 표시

function accountState(id, settings, meta) {
  const { uid, source } = settings.accounts[id];
  if (!uid) return meta.noRole?.[id] ? "캐릭터 없음" : "";
  const role = meta.roles?.[id];
  const parts = [];
  if (role?.uid === uid) parts.push(role.nickname, role.level ? `Lv.${role.level}` : "");
  parts.push(source === "auto" ? "자동" : "직접 입력");
  return parts.filter(Boolean).join(" · ");
}

async function renderState() {
  const { settings, codes, meta } = await loadAll();

  for (const id of GAME_IDS) $(`state-${id}`).textContent = accountState(id, settings, meta);

  $("transport-current").textContent =
    settings.transport !== "auto" ? TRANSPORT_NAMES[settings.transport] : TRANSPORT_NAMES[meta.transport] ?? "확인 전";

  const codeRows = recentCodes(codes).map(({ game, code, entry }) =>
    el(
      "tr",
      {},
      el("td", {}, GAMES[game].short),
      el("td", { className: "mono" }, code),
      el("td", {}, statusBadge(entry.status)),
      el("td", {}, entryMessage(entry)),
      el("td", { className: "muted" }, String(entry.attempts ?? 0)),
      el("td", { className: "time" }, formatTime(entry.triedAt)),
    ),
  );
  $("codes").replaceChildren(...(codeRows.length ? codeRows : [el("tr", {}, el("td", { colSpan: 6, className: "empty" }, "기록 없음"))]));

  const logRows = [...(meta.log ?? [])].reverse().map((line) =>
    el("tr", {}, el("td", { className: "time" }, formatTime(line.at)), el("td", { className: `level-${line.level}` }, line.msg)),
  );
  $("log").replaceChildren(...(logRows.length ? logRows : [el("tr", {}, el("td", { className: "empty" }, "로그 없음"))]));
}

// ---------------------------------------------------------------- 입력

$("interval").addEventListener("change", async () => {
  const minutes = clampInterval($("interval").value);
  $("interval").value = minutes;
  await save({ intervalMinutes: minutes });
});
$("lang").addEventListener("change", () => save({ lang: $("lang").value }));
$("transport").addEventListener("change", () => save({ transport: $("transport").value }));
for (const key of ["hoyoCodes", "fandom"]) {
  $(`src-${key}`).addEventListener("change", async () => {
    await save({ sources: { ...(await loadAll()).settings.sources, [key]: $(`src-${key}`).checked } });
  });
}

// ---------------------------------------------------------------- 버튼

const DETECT_FAIL_TEXT = { account_error: "캐릭터 없음", login_required: "로그인 필요" };

$("detect").addEventListener("click", async () => {
  const done = busy($("detect"), "찾는 중…");
  const res = await send("detectAccounts");
  done();
  if (res?.busy || res?.error) {
    $("detect-result").textContent = res.error ? `오류: ${res.error}` : BUSY_TEXT;
    return;
  }
  const lines = Object.entries(res).map(([id, r]) => {
    if (r.account) return `${GAMES[id].short}: ${r.role?.nickname ?? ""} (${regionName(id, r.account.region)})`;
    return `${GAMES[id].short}: ${DETECT_FAIL_TEXT[r.kind] ?? STATUS[r.kind]?.label ?? r.kind}`;
  });
  $("detect-result").textContent = lines.join(" / ");
});

const CONNECTION_TEXT = { ok: "됨", login_required: "로그인 안 잡힘" };

$("test-connection").addEventListener("click", async () => {
  const done = busy($("test-connection"), "확인 중…");
  const res = await send("testConnection");
  done();
  if (res?.error || res?.busy) {
    $("connection-result").replaceChildren(el("p", { className: "small" }, res.error ? `오류: ${res.error}` : BUSY_TEXT));
    return;
  }
  const rows = ["fetch", "tab"].map((mode) => {
    const r = res.results[mode];
    return el(
      "tr",
      {},
      el("td", {}, TRANSPORT_NAMES[mode]),
      el("td", {}, el("span", { className: `badge ${r.kind === "ok" ? "ok" : "bad"}` }, CONNECTION_TEXT[r.kind] ?? STATUS[r.kind]?.label ?? r.kind)),
      el("td", { className: "small muted" }, r.role ? `${r.role.nickname} (UID ${r.role.uid})` : r.detail),
    );
  });
  const note = res.working ? "" : "둘 다 안 되면 교환 페이지에서 로그인했는지 확인해 주세요.";
  $("connection-result").replaceChildren(el("table", {}, el("tbody", {}, ...rows)), note ? el("p", { className: "small" }, note) : "");
});

$("try-code").addEventListener("click", async () => {
  const code = $("code").value.trim();
  if (!code) return;
  const done = busy($("try-code"), "입력 중…");
  const res = await send("redeemOne", { game: $("code-game").value, code });
  done();
  if (res?.busy || (res?.error && !res.kind)) {
    $("code-result").replaceChildren(el("p", { className: "small" }, res.busy ? BUSY_TEXT : res.error));
    return;
  }
  $("code-result").replaceChildren(
    el("p", {}, el("span", { className: "mono" }, res.code), " ", statusBadge(res.kind), " ", el("span", { className: "small muted" }, res.detail ?? "")),
  );
});

$("reset").addEventListener("click", async () => {
  if (!confirm("코드 기록과 로그를 지울까요? 다음 확인 때 지금 올라와 있는 코드를 다시 시도해요.")) return;
  const res = await send("resetHistory");
  if (res?.busy) alert("확인이 끝난 뒤에 다시 눌러 주세요.");
  else if (res?.error) alert(res.error);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) fillForm(normalizeSettings(changes.settings.newValue));
  renderState();
});

buildForm();
fillForm((await loadAll()).settings);
renderState();
