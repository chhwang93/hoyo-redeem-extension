// HoYoverse API 요청 생성, 응답 분류, 호출 방식(서비스 워커 fetch / 교환 페이지 탭).
import { GAMES } from "./games.js";

export const ROLES_URL = "https://api-account-os.hoyoverse.com/account/binding/api/getUserGameRolesByCookieToken";

// 탭으로 우회할 때 요청을 보낼 페이지. 세 게임 API 모두 *.hoyoverse.com 출처를 CORS로 허용한다.
export const TAB_PAGE_URL = "https://genshin.hoyoverse.com/ko/gift";

/** 화면에 보이는 요청 방식 이름 */
export const TRANSPORT_NAMES = { fetch: "바로 요청", tab: "교환 페이지 경유" };

/** 교환 요청 사이 최소 간격. 짧으면 -2016(쿨다운)이 온다. */
export const MIN_GAP_MS = 5500;
const REQUEST_TIMEOUT_MS = 20000;
const TAB_LOAD_TIMEOUT_MS = 30000;
const TAB_KEY = "helperTabId";

/**
 * final : 결과가 정해져서 다시 시도하지 않는다
 * stop  : "all"이면 이번 확인을 멈추고, "game"이면 그 게임만 멈춘다. 다음 확인 때 다시 한다
 * counts: 코드 문제일 수도 있어서 시도 횟수를 세고, 한도에 닿으면 gave_up
 */
export const STATUS = {
  new: { label: "대기" },
  success: { label: "받음", final: true },
  used: { label: "이미 받음", final: true },
  expired: { label: "만료", final: true },
  invalid: { label: "없는 코드", final: true },
  region_locked: { label: "다른 서버", final: true },
  ineligible: { label: "레벨 부족", final: true },
  verify_required: { label: "직접 입력 필요", final: true, stop: "game" },
  gave_up: { label: "중단", final: true },
  not_active: { label: "아직 안 열림", counts: true },
  unknown: { label: "알 수 없음", counts: true },
  account_error: { label: "계정 오류", stop: "game" },
  server_error: { label: "서버 오류", stop: "game" }, // HTTP 오류, JSON이 아닌 응답: 그 게임 주소만의 문제일 수 있다
  login_required: { label: "로그인 필요", stop: "all" },
  cooldown: { label: "요청 제한", stop: "all" },
  network_error: { label: "네트워크 오류", stop: "all" }, // 연결 실패, 탭을 못 엶
};

// 실측(2026-10-01): 원신 0, -2017, -2001 / 스타레일 0, -2018, -2001 / 젠존제 0 (로그인 상태)
//                   -1071, -100 (세 게임, 로그아웃 상태)
// 나머지는 genshin.py의 retcode 표를 따랐다.
export const RETCODES = {
  0: "success",
  [-2017]: "used", // 같은 묶음의 다른 코드를 이미 받은 경우도 이 값
  [-2018]: "used", // 스타레일은 이미 받은 코드에 이 값
  [-2001]: "expired",
  [-2006]: "expired", // 사용 한도 도달
  [-2003]: "invalid",
  [-2004]: "invalid",
  [-1065]: "invalid",
  [-2008]: "region_locked",
  [-2011]: "ineligible",
  [-2021]: "ineligible",
  [-2014]: "not_active",
  [-2016]: "cooldown",
  [-1071]: "login_required",
  [-100]: "login_required",
  [10001]: "login_required",
  [-1073]: "account_error", // 게임 계정이 연결되지 않음
};

/** @param {{retcode?: number, data?: object, error?: string, httpStatus?: number}} resp */
export function classifyResponse(resp) {
  if (resp.httpStatus === 429) return "cooldown";
  if (resp.error) return resp.error === "http" ? "server_error" : "network_error";
  // 스타레일·젠존제: retcode 0이어도 보안 확인(Geetest)을 요구하면 교환이 끝나지 않은 상태다.
  if (resp.retcode === 0 && resp.data?.gee_test_param?.should_pop_verify) return "verify_required";
  return RETCODES[resp.retcode] ?? "unknown";
}

/**
 * 화면과 로그에 보일 설명. 서버가 보낸 문장을 그대로 쓰고, 응답 코드 숫자는
 * 분류표에 없는 응답일 때만 붙인다(그 숫자가 있어야 RETCODES를 고칠 수 있다).
 */
export function describeResponse(resp, kind = classifyResponse(resp)) {
  if (resp.error) return resp.message || resp.error;
  const message = resp.message === "OK" ? "" : resp.message ?? "";
  return kind === "unknown" ? `${message} (응답 코드 ${resp.retcode})`.trim() : message;
}

/**
 * 공식 교환 페이지와 같은 요청을 만든다.
 *  원신          GET  ?uid&region&lang&cdkey&game_biz
 *  스타레일·젠존제 POST JSON { t, lang, game_biz, uid, region, cdkey, platform: "4", device_uuid }
 *                (폼 형식으로 보내면 -502)
 */
export function buildRedeemRequest(gameId, { uid, region, lang, cdkey, deviceId, now = Date.now() }) {
  const game = GAMES[gameId];
  if (!game.riskControl) {
    const params = new URLSearchParams({ uid: String(uid), region, lang, cdkey, game_biz: game.gameBiz });
    return { url: `${game.redeemUrl}?${params}`, method: "GET" };
  }
  return {
    url: game.redeemUrl,
    method: "POST",
    headers: { "Content-Type": "application/json", "x-rpc-language": lang },
    body: JSON.stringify({
      t: now,
      lang,
      game_biz: game.gameBiz,
      uid: String(uid),
      region,
      cdkey,
      platform: "4", // 데스크톱
      device_uuid: deviceId,
    }),
  };
}

export function buildRolesRequest(gameId, { region, lang }) {
  const params = new URLSearchParams({ lang, region, game_biz: GAMES[gameId].gameBiz });
  return { url: `${ROLES_URL}?${params}`, method: "GET" };
}

/** 캐릭터 조회 응답에서 공식 페이지처럼 list[0]을 고른다. */
export function pickRole(resp) {
  const role = resp?.data?.list?.[0];
  if (!role) return null;
  return {
    uid: String(role.game_uid),
    region: role.region,
    nickname: role.nickname ?? "",
    level: role.level ?? null,
  };
}

/** {status, body} → {retcode, message, data} 또는 {error, httpStatus, message} */
export function parseRawResponse(raw) {
  if (!raw || raw.error || !raw.status) {
    return { error: "network", message: raw?.error || "응답 없음" };
  }
  if (raw.status < 200 || raw.status >= 300) {
    return { error: "http", httpStatus: raw.status, message: `HTTP ${raw.status}` };
  }
  try {
    const json = JSON.parse(raw.body);
    if (typeof json?.retcode !== "number") throw new Error("retcode 없음");
    return { retcode: json.retcode, message: json.data?.msg || json.message || "", data: json.data ?? null };
  } catch {
    return { error: "http", httpStatus: raw.status, message: "JSON이 아닌 응답" };
  }
}

// ---------------------------------------------------------------- 호출 방식

/** 서비스 워커에서 바로 fetch. host_permissions가 있는 호스트라 브라우저 쿠키가 같이 간다. */
export function createFetchTransport(fetchImpl = globalThis.fetch) {
  return {
    mode: "fetch",
    async call({ url, method, headers, body }) {
      try {
        const res = await fetchImpl(url, {
          method,
          headers,
          body,
          credentials: "include",
          cache: "no-store",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        return parseRawResponse({ status: res.status, body: await res.text() });
      } catch (e) {
        return { error: "network", message: e?.message ?? String(e) };
      }
    },
    async close() {},
  };
}

// executeScript로 교환 페이지 안에서 실행된다. 바깥 변수를 쓰면 안 된다.
function fetchInPage({ url, method, headers, body }, timeoutMs) {
  return fetch(url, { method, headers, body, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) })
    .then(async (res) => ({ status: res.status, body: await res.text() }))
    .catch((e) => ({ status: 0, body: "", error: String(e) }));
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("교환 페이지 로딩 시간 초과")), timeoutMs);
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") finish();
    }
    function finish(error) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      error ? reject(error) : resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => tab.status === "complete" && finish(), finish);
  });
}

/**
 * 교환 페이지를 비활성 탭으로 열고 그 페이지 안에서 fetch한다.
 * 요청이 hoyoverse.com 출처로 나가서 공식 페이지와 같은 쿠키 조건이 된다.
 * 탭은 첫 호출 때 열고 close()에서 닫는다.
 */
export function createTabTransport(pageUrl = TAB_PAGE_URL) {
  let tabId = null;
  return {
    mode: "tab",
    async call(request) {
      try {
        if (tabId === null) {
          tabId = (await chrome.tabs.create({ url: pageUrl, active: false })).id;
          await chrome.storage.session.set({ [TAB_KEY]: tabId }); // 서비스 워커가 도중에 내려가면 다음에 닫는다
          await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
        }
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId },
          func: fetchInPage,
          args: [request, REQUEST_TIMEOUT_MS],
        });
        return parseRawResponse(injection?.result);
      } catch (e) {
        return { error: "network", message: e?.message ?? String(e) };
      }
    },
    async close() {
      if (tabId === null) return;
      const id = tabId;
      tabId = null;
      await chrome.tabs.remove(id).catch(() => {});
      await chrome.storage.session.remove(TAB_KEY).catch(() => {});
    },
  };
}

/** 서비스 워커가 확인 도중 내려가서 못 닫은 교환 페이지 탭을 닫는다. */
export async function closeLeftoverTab() {
  const { [TAB_KEY]: id } = await chrome.storage.session.get(TAB_KEY);
  if (id == null) return;
  await chrome.storage.session.remove(TAB_KEY);
  await chrome.tabs.remove(id).catch(() => {});
}

/**
 * 페이지를 사용자 앞에 띄운다. tabs.create는 창을 앞으로 가져오지 않아서 창도 포커스하고,
 * 열린 창이 하나도 없으면(tabs.create 실패) 새 창을 연다.
 */
export async function openPage(url) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: true });
  } catch {
    await chrome.windows.create({ url, focused: true });
    return;
  }
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}
