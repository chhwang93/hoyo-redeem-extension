// 서비스 워커: 알람·시작 이벤트, 팝업·옵션 메시지, 알림을 runner.js에 연결한다.
import { runCheck, testConnection, redeemOne, detectAccounts } from "./runner.js";
import { createFetchTransport, createTabTransport, openPage, closeLeftoverTab } from "./redeem.js";
import { GAMES, giftPageUrl } from "./games.js";
import { loadAll, saveAll, clampInterval } from "./storage.js";

const ALARM = "check-codes";
const ICON = "icons/icon128.png";
const CONSOLE = { error: console.error, warn: console.warn, info: console.log };

const deps = {
  load: loadAll,
  save: saveAll,
  makeTransport: (mode) => (mode === "tab" ? createTabTransport() : createFetchTransport()),
  fetchImpl: (url, init) => fetch(url, init),
  notify,
  clock: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  keepAlive: () => chrome.runtime.getPlatformInfo(), // 가벼운 확장 API 호출로 서비스 워커 유휴 타이머를 되돌린다
  onLog: (level, msg) => (CONSOLE[level] ?? console.log)(`[hoyo] ${msg}`),
};

// 서비스 워커가 새로 떴다면 이전 실행은 이미 끝난 것이다. 그때 열어 둔 탭이 남았으면 닫는다.
chrome.storage.local.remove("running");
closeLeftoverTab().catch(console.warn);

let current = null;

/** 실행이 겹치지 않게 한다. 진행 중이면 그게 끝난 뒤 { busy: true }를 돌려준다. */
function exclusive(reason, task) {
  if (current) return current.then(() => ({ busy: true }));
  current = (async () => {
    await chrome.storage.local.set({ running: { since: new Date().toISOString(), reason } });
    try {
      return await task();
    } catch (e) {
      console.error(e);
      await appendLog("error", `실행 중 오류: ${e?.message ?? e}`);
      return { error: e?.message ?? String(e) };
    } finally {
      current = null;
      await chrome.storage.local.remove("running");
    }
  })();
  return current;
}

async function appendLog(level, msg) {
  const { meta } = await loadAll();
  meta.log = [...(meta.log ?? []), { at: new Date().toISOString(), level, msg }].slice(-150);
  await chrome.storage.local.set({ meta });
}

async function ensureAlarm(force = false) {
  const { settings } = await loadAll();
  const period = clampInterval(settings.intervalMinutes);
  const existing = await chrome.alarms.get(ALARM);
  if (!force && existing?.periodInMinutes === period) return;
  await chrome.alarms.create(ALARM, { delayInMinutes: period, periodInMinutes: period });
}

// 알람은 보통 남아 있지만, 없어졌으면 다시 만든다.
ensureAlarm().catch(console.warn);

// ---------------------------------------------------------------- 알림

function successMessage(items) {
  const byGame = new Map();
  for (const { game, code } of items) byGame.set(game, [...(byGame.get(game) ?? []), code]);
  const lines = [...byGame].map(([game, codes]) => `${GAMES[game].short}: ${codes.join(", ")}`);
  return `${lines.join("\n")}\n보상은 게임 우편함으로 와요.`;
}

const NOTIFICATIONS = {
  success: (items) => ({
    id: `success|${Date.now()}`,
    title: `코드 ${items.length}개 받음`,
    message: successMessage(items),
  }),
  verify: ({ game, code }) => ({
    id: `verify|${game}|${code}`,
    title: `${GAMES[game].short} 코드는 직접 입력해 주세요`,
    message: `${code}: 보안 확인이 떠서 자동으로 못 받았어요. 누르면 코드가 들어간 교환 페이지가 열려요.`,
  }),
  login: ({ game }) => ({
    id: `login|${game}`,
    title: "HoYoverse 로그인 필요",
    message: "교환 페이지에서 로그인한 뒤 '지금 확인'을 눌러 주세요. 누르면 교환 페이지가 열려요.",
  }),
};

async function notify(kind, data) {
  const { id, title, message } = NOTIFICATIONS[kind](data);
  try {
    await chrome.notifications.create(id, { type: "basic", iconUrl: ICON, title, message });
  } catch (e) {
    console.warn("[hoyo] 알림 실패", e);
  }
}

/** 그 게임의 교환 페이지. 게임 값이 이상하면 원신 페이지(로그인은 어느 게임 페이지에서 해도 같다). */
function openGiftPage(game, code) {
  return openPage(giftPageUrl(GAMES[game] ? game : "genshin", code));
}

chrome.notifications.onClicked.addListener((id) => {
  const [kind, game, code] = id.split("|");
  if (kind === "verify") openGiftPage(game, code).catch(console.warn);
  if (kind === "login") openGiftPage(game).catch(console.warn);
  chrome.notifications.clear(id);
});

// ---------------------------------------------------------------- 이벤트

async function resetHistory() {
  if (current) return { busy: true };
  const { meta } = await loadAll();
  const { transport, roles, noRole, login, deviceId } = meta;
  await chrome.storage.local.set({ codes: {}, meta: { transport, roles, noRole, login, deviceId, log: [] } });
  return { ok: true };
}

chrome.runtime.onInstalled.addListener(async () => {
  await saveAll(await loadAll()); // 1.0 형식이면 새 형식으로 바꿔 저장
  await ensureAlarm(true);
  exclusive("install", () => runCheck(deps));
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  exclusive("startup", () => runCheck(deps));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) exclusive("alarm", () => runCheck(deps));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  if (changes.settings.oldValue?.intervalMinutes !== changes.settings.newValue?.intervalMinutes) ensureAlarm(true);
});

const handlers = {
  runNow: () => exclusive("manual", () => runCheck(deps, { manual: true })),
  testConnection: () => exclusive("connection", () => testConnection(deps)),
  detectAccounts: () => exclusive("accounts", () => detectAccounts(deps)),
  redeemOne: ({ game, code }) => exclusive("manual-code", () => redeemOne(deps, game, code)),
  resetHistory,
  openGiftPage: async ({ game, code }) => {
    await openGiftPage(game, code);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg)).then(sendResponse, (e) => sendResponse({ error: e?.message ?? String(e) }));
  return true; // 비동기 응답
});
