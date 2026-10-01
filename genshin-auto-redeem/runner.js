// 확인 한 번의 흐름: 게임마다 코드 수집 → 새 코드 고르기 → 로그인·계정 확인 → 교환 → 저장·알림.
// chrome.* 는 deps로 받는다(background.js). 테스트에서는 가짜를 넣는다.
//
// deps = {
//   load(), save({settings?, codes?, meta?}),
//   makeTransport(mode: "fetch"|"tab"): { call(request), close() },
//   fetchImpl,                     코드 출처 요청용
//   notify(kind, data),            "success" | "verify" | "login"
//   clock(), sleep(ms),
//   newDeviceId?(), throttle?, onLog?(level, msg),
// }
import { GAMES, GAME_IDS, SERVERS, regionFromUid, regionName, serverOf } from "./games.js";
import { collectCodes, normalizeCode, SOURCES } from "./sources.js";
import {
  STATUS,
  MIN_GAP_MS,
  TRANSPORT_NAMES,
  classifyResponse,
  describeResponse,
  buildRedeemRequest,
  buildRolesRequest,
  pickRole,
} from "./redeem.js";

/** not_active / unknown 응답을 몇 번까지 다시 시도할지 */
export const MAX_ATTEMPTS = 5;
/** 로그아웃 상태를 확인한 뒤 자동 확인이 다시 로그인을 확인하기까지 (탭 우회가 매번 열리지 않게) */
export const LOGIN_RECHECK_MS = 60 * 60 * 1000;
/** 캐릭터가 없는 게임을 자동 확인에서 다시 찾기까지 */
export const NO_ROLE_RECHECK_MS = 24 * 60 * 60 * 1000;
/** 보안 확인이 뜬 게임을 자동 확인에서 쉬는 시간. 계속 보내면 보안 확인만 더 뜬다. */
export const VERIFY_BACKOFF_MS = 6 * 60 * 60 * 1000;
/** 한 번의 확인에서 게임마다 시도할 코드 수. 위키에 가짜 코드가 잔뜩 올라와도 계정으로 수백 번 보내지 않게 한다. */
export const MAX_CODES_PER_GAME = 20;
const LOG_LIMIT = 150;

// 서비스 워커가 살아 있는 동안은 확인과 확인 사이에도 요청 간격을 지킨다.
const sharedThrottle = { last: 0 };

export function isFinal(entry) {
  return STATUS[entry?.status]?.final === true;
}

/** 이번에 시도할 코드: 지금 출처에 올라와 있고 결과가 아직 정해지지 않은 것 */
export function selectCandidates(found, codes) {
  return found.filter((c) => !isFinal(codes[c.code]));
}

export function applyResult(entry, kind, resp, at) {
  const counts = STATUS[kind].counts === true;
  const attempts = (entry?.attempts ?? 0) + (counts ? 1 : 0);
  return {
    ...entry,
    status: counts && attempts >= MAX_ATTEMPTS ? "gave_up" : kind,
    retcode: resp.retcode ?? null,
    message: resp.error ? describeResponse(resp) : resp.message ?? "",
    triedAt: at,
    attempts,
  };
}

function forcedMode(settings) {
  return settings.transport === "fetch" || settings.transport === "tab" ? settings.transport : null;
}

function accountOf(settings, gameId) {
  const { uid, region } = settings.accounts[gameId];
  const resolved = region || regionFromUid(gameId, uid);
  return uid && resolved ? { uid, region: resolved } : null;
}

function regionsToProbe(settings, gameId) {
  const { region } = settings.accounts[gameId];
  return region ? [region] : SERVERS.map((server) => GAMES[gameId].regions[server]);
}

/**
 * 한 번의 확인 동안 쓰는 HoYoverse API 세션. 모든 요청은 MIN_GAP_MS 간격을 지킨다.
 * 요청 방식을 아직 모르면 fetch → tab 순서로 캐릭터 조회(읽기 전용)를 해 보고 되는 쪽을 쓴다.
 */
export function createSession(deps, settings, meta) {
  const { makeTransport, sleep, clock, throttle = sharedThrottle } = deps;
  const forced = forcedMode(settings);
  // tab만 된다고 확인된 환경이면 fetch는 다시 시도하지 않는다.
  const modes = forced ? [forced] : meta.transport === "tab" ? ["tab"] : ["fetch", "tab"];
  const transports = {};
  let active = forced ?? meta.transport ?? null;

  async function call(mode, request) {
    // 서비스 워커는 확장 API 호출 없이 30초가 지나면 내려간다. fetch와 setTimeout은 이 시간을 늘려 주지 않는다.
    await deps.keepAlive?.();
    const wait = throttle.last + MIN_GAP_MS - clock();
    if (wait > 0) await sleep(wait);
    try {
      transports[mode] ??= makeTransport(mode);
      return await transports[mode].call(request);
    } finally {
      throttle.last = clock();
    }
  }

  /** 로그인 여부, 되는 요청 방식, 캐릭터를 확인한다. */
  async function probe(gameId, regions) {
    let last = null;
    for (const mode of modes) {
      let loggedIn = false;
      let role = null;
      for (const region of regions) {
        last = await call(mode, buildRolesRequest(gameId, { region, lang: settings.lang }));
        const kind = classifyResponse(last);
        if (kind === "login_required") break; // 이 방식으로는 쿠키가 안 갔거나 로그아웃 → 다음 방식
        if (kind !== "success" && kind !== "account_error") return { kind, mode, resp: last };
        loggedIn = true; // account_error는 로그인은 됐지만 이 서버에 캐릭터가 없다는 뜻
        role = kind === "success" ? pickRole(last) : null;
        if (role) break;
      }
      if (loggedIn) {
        active = mode;
        return { kind: "ok", mode, role, resp: last };
      }
    }
    return { kind: "login_required", resp: last };
  }

  async function redeem(gameId, account, code) {
    const request = buildRedeemRequest(gameId, {
      ...account,
      lang: settings.lang,
      cdkey: code,
      deviceId: meta.deviceId,
      now: clock(),
    });
    const first = active ?? modes[0];
    const resp = await call(first, request);
    const kind = classifyResponse(resp);
    if (kind !== "login_required") return { resp, kind };

    // 로그인 오류면 다른 방식으로 같은 요청을 한 번 더 보낸다. 이 방식으로만 쿠키가 안 갔을 수 있다.
    for (const mode of modes.filter((m) => m !== first)) {
      const retry = await call(mode, request);
      const retryKind = classifyResponse(retry);
      if (retryKind !== "login_required") {
        active = mode;
        return { resp: retry, kind: retryKind };
      }
    }
    // 어느 방식으로도 로그인 오류인데 계정 조회는 된다면 로그아웃이 아니라 이 게임 교환만 막힌 것이다.
    const p = await probe(gameId, [account.region]);
    if (p.kind !== "ok") return { resp, kind };
    return { resp: { ...resp, message: `${resp.message} (계정 조회는 됨)` }, kind: "account_error" };
  }

  async function close() {
    await Promise.all(Object.values(transports).map((t) => t.close().catch(() => {})));
  }

  return {
    probe,
    redeem,
    close,
    get mode() {
      return active;
    },
  };
}

function createRunContext(deps, loaded) {
  const iso = () => new Date(deps.clock()).toISOString();
  const prevLogin = loaded.meta.login?.state;
  const ctx = {
    settings: loaded.settings,
    codes: loaded.codes,
    meta: { ...loaded.meta, roles: { ...loaded.meta.roles }, noRole: { ...loaded.meta.noRole }, verifyAt: { ...loaded.meta.verifyAt } },
    accountPatch: null,
    loginBecameRequired: false,
    logs: [],
    iso,
    log(level, msg) {
      ctx.logs.push({ at: iso(), level, msg });
      deps.onLog?.(level, msg);
    },
    setLogin(state) {
      if (state === "required" && prevLogin !== "required") ctx.loginBecameRequired = true;
      ctx.meta.login = { state, checkedAt: iso() };
    },
    setAccount(gameId, account) {
      ctx.settings = { ...ctx.settings, accounts: { ...ctx.settings.accounts, [gameId]: account } };
      ctx.accountPatch = { ...ctx.accountPatch, [gameId]: account };
    },
    setTransport(mode) {
      if (forcedMode(ctx.settings) || !mode || ctx.meta.transport === mode) return;
      ctx.log("info", `요청 방식: ${TRANSPORT_NAMES[mode]}`);
      ctx.meta.transport = mode;
    },
    async flush() {
      ctx.meta.log = [...(loaded.meta.log ?? []), ...ctx.logs].slice(-LOG_LIMIT);
      const settings = ctx.accountPatch ? { settings: { accounts: ctx.accountPatch } } : {};
      await deps.save({ codes: ctx.codes, meta: ctx.meta, ...settings });
    },
  };
  ctx.meta.deviceId ??= deps.newDeviceId?.() ?? crypto.randomUUID();
  return ctx;
}

/** 게임 계정을 정한다. 필요하면 캐릭터 조회로 로그인과 계정을 확인한다. */
async function ensureAccount(ctx, session, gameId, { forceProbe }) {
  const { settings, meta } = ctx;
  const name = GAMES[gameId].name;
  let account = accountOf(settings, gameId);
  const needProbe = forceProbe || !account || (!forcedMode(settings) && !meta.transport);
  if (!needProbe) return { account };

  const p = await session.probe(gameId, account ? [account.region] : regionsToProbe(settings, gameId));
  if (p.kind === "login_required") {
    ctx.setLogin("required");
    ctx.log("warn", "로그인이 필요해요");
    return { stop: "login_required" };
  }
  if (p.kind !== "ok") {
    ctx.log("warn", `${name} 계정 조회 실패: ${describeResponse(p.resp)}`);
    return { stop: p.kind === "unknown" ? "account_error" : p.kind };
  }

  ctx.setLogin("ok");
  ctx.setTransport(p.mode);
  if (p.role) {
    meta.roles[gameId] = p.role;
    delete meta.noRole[gameId];
  }
  // 직접 입력한 계정은 그대로 둔다. 자동으로 찾은 계정은 로그인된 HoYoverse 계정이 바뀌었으면 따라간다.
  const keep = account && (settings.accounts[gameId].source !== "auto" || !p.role || p.role.uid === account.uid);
  if (keep) return { account };

  if (!p.role) {
    meta.noRole[gameId] = ctx.iso();
    ctx.log("info", `${name}: 이 계정에 캐릭터가 없어요`);
    return { stop: "account_error", noRole: true };
  }
  account = { uid: p.role.uid, region: p.role.region };
  ctx.setAccount(gameId, { ...account, source: "auto" });
  ctx.log("info", `${name} 계정: ${p.role.nickname} (UID ${account.uid}, ${regionName(gameId, account.region)})`);
  return { account };
}

function recordRedeem(ctx, session, gameId, code, kind, resp) {
  const entry = applyResult(ctx.codes[gameId][code], kind, resp, ctx.iso());
  ctx.codes[gameId][code] = entry;
  const level = STATUS[kind].stop || kind === "unknown" ? "warn" : "info";
  const detail = describeResponse(resp, kind);
  ctx.log(level, `${GAMES[gameId].name} ${code}: ${STATUS[entry.status].label}${detail ? ` (${detail})` : ""}`);
  if (kind === "login_required") ctx.setLogin("required");
  else if (!resp.error && kind !== "cooldown") ctx.setLogin("ok");
  ctx.setTransport(session.mode);
}

/** 한 게임의 코드를 차례로 교환한다. 전체를 멈춰야 하면 그 사유를 돌려준다. */
async function redeemCandidates(ctx, session, gameId, account, candidates, summary) {
  const server = serverOf(gameId, account.region);
  for (const { code, servers } of candidates) {
    // 서버를 모르면(표에 없는 region) 거르지 않는다.
    if (servers && server && !servers.includes(server)) {
      ctx.codes[gameId][code] = {
        ...ctx.codes[gameId][code],
        status: "region_locked",
        message: `위키 기준 ${servers.map((s) => regionName(gameId, GAMES[gameId].regions[s])).join(", ")} 전용`,
        triedAt: ctx.iso(),
      };
      continue;
    }
    const { resp, kind } = await session.redeem(gameId, account, code);
    summary.attempted++;
    recordRedeem(ctx, session, gameId, code, kind, resp);
    if (kind === "success") summary.successes.push({ game: gameId, code });
    if (kind === "verify_required") {
      summary.verify.push({ game: gameId, code });
      ctx.meta.verifyAt[gameId] = ctx.iso();
    }
    await ctx.flush(); // 서비스 워커가 중간에 내려가도 여기까지는 남는다

    const stop = STATUS[kind].stop;
    if (stop === "all") return kind;
    if (stop === "game") return null;
  }
  return null;
}

function recentlyChecked(iso, now, windowMs) {
  return Boolean(iso) && now - Date.parse(iso) < windowMs;
}

/** 한 게임에서 받아 온 코드를 기록에 올리고, 이번에 시도할 코드를 돌려준다. */
function recordFound(ctx, gameId, { codes: found, errors, counts }, summary) {
  const name = GAMES[gameId].name;
  for (const e of errors) {
    ctx.log("warn", `${name} ${SOURCES[e.source].name} 수집 실패: ${e.message}`);
    summary.sourceErrors.push({ game: gameId, ...e });
  }

  const gameCodes = ctx.codes[gameId];
  for (const { code, sources } of found) {
    gameCodes[code] = gameCodes[code]
      ? { ...gameCodes[code], sources }
      : { status: "new", message: "", retcode: null, triedAt: null, attempts: 0, firstSeenAt: ctx.iso(), sources };
  }
  const candidates = selectCandidates(found, gameCodes);
  summary.found += found.length;
  summary.candidates += candidates.length;
  const countText = Object.entries(counts).map(([source, n]) => `${SOURCES[source].name} ${n}`).join(", ");
  ctx.log("info", `${name}: 코드 ${found.length}개${countText ? ` (${countText})` : ""}, 새로 시도할 코드 ${candidates.length}개`);
  return candidates;
}

/** 게임마다 출처별로 한 번씩 코드를 받아 와서, 이번 확인에서 다룰 게임과 코드를 고른다. */
async function collectWork(deps, ctx, games, { manual, now }, summary) {
  const collected = await Promise.all(
    games.map((gameId) => collectCodes(gameId, ctx.settings.sources, { fetchImpl: deps.fetchImpl, now: new Date(now) })),
  );
  const work = [];
  games.forEach((gameId, i) => {
    const candidates = recordFound(ctx, gameId, collected[i], summary);
    if (!candidates.length && !manual) return;
    if (!manual) {
      // 캐릭터가 없던 게임은 한동안 계정을 다시 찾지 않고, 보안 확인이 떴던 게임은 한동안 쉰다.
      if (!accountOf(ctx.settings, gameId) && recentlyChecked(ctx.meta.noRole[gameId], now, NO_ROLE_RECHECK_MS)) return;
      if (recentlyChecked(ctx.meta.verifyAt[gameId], now, VERIFY_BACKOFF_MS)) {
        ctx.log("info", `${GAMES[gameId].name}: 보안 확인이 떠서 잠시 쉬어요`);
        return;
      }
    }
    work.push({ gameId, candidates: candidates.slice(0, MAX_CODES_PER_GAME) });
  });
  return work;
}

/**
 * 확인 한 번.
 * @param {{manual?: boolean}} options  manual이면 새 코드가 없어도 로그인과 계정을 확인한다.
 */
export async function runCheck(deps, { manual = false } = {}) {
  const ctx = createRunContext(deps, await deps.load());
  const { settings } = ctx;
  const now = deps.clock();
  const games = GAME_IDS.filter((id) => settings.games[id]);
  const summary = { at: null, manual, found: 0, candidates: 0, attempted: 0, successes: [], verify: [], stopReason: null, sourceErrors: [] };

  const finish = async () => {
    summary.at = ctx.iso();
    ctx.meta.lastCheckAt = summary.at;
    ctx.meta.lastRun = summary;
    await ctx.flush();
    if (summary.successes.length) await deps.notify("success", summary.successes);
    for (const item of summary.verify) await deps.notify("verify", item);
    if (ctx.loginBecameRequired) await deps.notify("login", { game: games[0] });
    return summary;
  };

  if (!games.length) ctx.log("warn", "켜 둔 게임이 없어요");
  if (!Object.values(settings.sources).some(Boolean)) ctx.log("warn", "켜 둔 코드 출처가 없어요");

  const work = await collectWork(deps, ctx, games, { manual, now }, summary);
  if (!manual && !work.some((w) => w.candidates.length)) return finish();

  if (!manual && ctx.meta.login?.state === "required" && recentlyChecked(ctx.meta.login.checkedAt, now, LOGIN_RECHECK_MS)) {
    ctx.log("info", "로그인이 필요해서 교환은 건너뛰었어요");
    summary.stopReason = "login_required";
    return finish();
  }

  // 로그인·계정 확인과 교환
  const session = createSession(deps, settings, ctx.meta);
  try {
    for (const [i, { gameId, candidates }] of work.entries()) {
      // 수동 확인은 로그인 상태를 한 번 직접 확인한다.
      const { account, stop } = await ensureAccount(ctx, session, gameId, { forceProbe: manual && i === 0 });
      await ctx.flush(); // 계정·캐릭터 없음 기록을 바로 남긴다
      if (stop && STATUS[stop].stop === "all") {
        summary.stopReason = stop;
        break;
      }
      if (stop) continue;

      const stopAll = await redeemCandidates(ctx, session, gameId, account, candidates, summary);
      if (stopAll) {
        summary.stopReason = stopAll;
        break;
      }
    }
    return await finish();
  } finally {
    await session.close();
  }
}

function firstEnabledGame(settings) {
  return GAME_IDS.find((id) => settings.games[id]) ?? GAME_IDS[0];
}

/** 옵션의 "연결 확인": 두 요청 방식으로 캐릭터 조회를 각각 해 보고, 되는 쪽을 저장한다. */
export async function testConnection(deps) {
  const ctx = createRunContext(deps, await deps.load());
  const gameId = firstEnabledGame(ctx.settings);
  const region = accountOf(ctx.settings, gameId)?.region ?? GAMES[gameId].regions.asia;
  const results = {};

  for (const mode of ["fetch", "tab"]) {
    const session = createSession(deps, { ...ctx.settings, transport: mode }, ctx.meta);
    try {
      const p = await session.probe(gameId, [region]);
      results[mode] = { kind: p.kind, detail: p.resp ? describeResponse(p.resp) : "", role: p.role ?? null };
    } finally {
      await session.close();
    }
  }

  const working = ["fetch", "tab"].find((mode) => results[mode].kind === "ok") ?? null;
  if (working) {
    ctx.setLogin("ok");
    ctx.setTransport(working);
    if (results[working].role) ctx.meta.roles[gameId] = results[working].role;
  } else if (results.fetch.kind === "login_required" && results.tab.kind === "login_required") {
    ctx.setLogin("required");
  }
  const resultText = (kind) => (kind === "ok" ? "됨" : STATUS[kind]?.label ?? kind);
  ctx.log("info", `연결 확인: ${TRANSPORT_NAMES.fetch} ${resultText(results.fetch.kind)}, ${TRANSPORT_NAMES.tab} ${resultText(results.tab.kind)}`);
  await ctx.flush();
  return { game: gameId, results, working };
}

/** 옵션의 "계정 다시 찾기": 켜 둔 게임마다 저장된 UID를 비우고 다시 찾는다. */
export async function detectAccounts(deps) {
  const loaded = await deps.load();
  const games = GAME_IDS.filter((id) => loaded.settings.games[id]);
  const cleared = Object.fromEntries(games.map((id) => [id, { uid: "", region: "", source: "" }]));
  const ctx = createRunContext(deps, {
    ...loaded,
    settings: { ...loaded.settings, accounts: { ...loaded.settings.accounts, ...cleared } },
  });
  const session = createSession(deps, ctx.settings, ctx.meta);
  const results = {};
  try {
    for (const gameId of games) {
      const { account, stop, noRole } = await ensureAccount(ctx, session, gameId, { forceProbe: true });
      if (noRole) ctx.setAccount(gameId, { uid: "", region: "", source: "" }); // 예전 UID가 남지 않게
      results[gameId] = stop ? { kind: stop } : { account, role: ctx.meta.roles[gameId] ?? null };
      await ctx.flush();
      if (stop && STATUS[stop].stop === "all") break;
    }
    return results;
  } finally {
    await session.close();
  }
}

/** 옵션의 "코드 직접 입력": 코드 하나를 교환하고 결과를 돌려준다. 결과는 기록에도 남긴다. */
export async function redeemOne(deps, gameId, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return { error: "영문과 숫자 4~30자로 입력해 주세요" };
  if (!GAMES[gameId]) return { error: "게임을 골라 주세요" };

  const ctx = createRunContext(deps, await deps.load());
  const session = createSession(deps, ctx.settings, ctx.meta);
  try {
    const { account, stop } = await ensureAccount(ctx, session, gameId, { forceProbe: false });
    if (stop) {
      await ctx.flush();
      return { game: gameId, code, kind: stop, label: STATUS[stop].label, detail: "계정 확인에서 멈춤" };
    }
    const { resp, kind } = await session.redeem(gameId, account, code);
    ctx.codes[gameId][code] ??= { status: "new", attempts: 0, firstSeenAt: ctx.iso(), sources: ["manual"] };
    recordRedeem(ctx, session, gameId, code, kind, resp);
    await ctx.flush();
    if (kind === "success") await deps.notify("success", [{ game: gameId, code }]);
    if (kind === "verify_required") await deps.notify("verify", { game: gameId, code });
    return {
      game: gameId,
      code,
      kind,
      label: STATUS[kind].label,
      retcode: resp.retcode ?? null,
      detail: describeResponse(resp, kind),
      mode: session.mode,
    };
  } finally {
    await session.close();
  }
}
