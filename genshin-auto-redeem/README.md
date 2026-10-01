# HoYo 코드 자동 수령

원신, 붕괴: 스타레일, 젠레스 존 제로에 새 리딤코드가 올라오면 브라우저에 로그인된 HoYoverse 계정으로 대신 입력해 주는 개인용 크롬 확장입니다. 보상은 게임 우편함으로 옵니다. 웹스토어에는 올리지 않고 폴더째 로드해서 씁니다.

## 설치

1. `chrome://extensions`에서 오른쪽 위 개발자 모드를 켭니다.
2. 압축해제된 확장 프로그램 로드를 누르고 이 폴더(`genshin-auto-redeem`)를 고릅니다.
3. [원신 교환 페이지](https://genshin.hoyoverse.com/ko/gift)에서 로그인합니다. 한 번 로그인하면 세 게임 모두 됩니다.
4. 툴바 아이콘을 눌러 팝업에서 지금 확인을 누릅니다.

처음 확인할 때는 지금 올라와 있는 코드를 전부 시도해서 몇 분 걸립니다. 그 뒤로는 30분마다(설정에서 변경) 새 코드만 확인합니다.

### 1.0에서 올릴 때

`chrome://extensions`에서 이 확장의 새로고침 버튼만 누르면 됩니다. 원신 UID와 기록은 그대로 남습니다.
폴더 이름이나 위치를 바꾸면 크롬이 다른 확장으로 보고 기록이 사라지니 그대로 두세요.

## 쓰는 법

- 팝업: 로그인 상태, 게임별 계정, 마지막·다음 확인 시각, 최근 결과. 지금 확인으로 바로 확인합니다.
- 설정: 게임 켜고 끄기, 게임별 UID와 서버, 확인 주기, 코드 출처, 요청 방식, 코드 직접 입력, 기록과 로그.
- UID를 비워 두면 로그인된 계정에서 찾아 채웁니다. 한 서버에 캐릭터가 여럿이면 공식 페이지처럼 첫 번째를 씁니다.
- 알림은 코드를 받았을 때, 직접 입력이 필요할 때, 로그인이 필요할 때만 뜹니다.

### 스타레일·젠존제의 보안 확인

두 게임은 교환할 때 서버가 가끔 보안 확인(Geetest 퍼즐)을 요구합니다. 이 확장은 보안 확인을 풀지 않습니다. 대신 그 코드를 "직접 입력 필요"로 두고 알림을 띄웁니다. 알림이나 팝업의 배지를 누르면 코드가 들어간 공식 교환 페이지가 열리니 거기서 마무리하면 됩니다. 그 게임의 남은 코드는 다음 확인 때 이어서 시도합니다.

## 동작

확인할 때마다 이렇게 돕니다.

1. 켜 둔 게임마다 hoyo-codes와 Fandom 위키에서 코드 목록을 한 번씩 받습니다. 한쪽이 실패해도 다른 쪽으로 진행합니다.
2. 결과가 정해지지 않은 코드만 고릅니다. 받음, 이미 받음, 만료, 없는 코드, 다른 서버, 직접 입력 필요는 다시 시도하지 않습니다.
3. 게임마다 계정을 확인하고 코드를 하나씩 입력합니다. 요청 사이는 5.5초 이상 띄웁니다.
4. 로그인 필요, 요청 제한, 네트워크 오류가 나면 그 자리에서 멈추고 다음 확인 때 다시 합니다.

로그아웃 상태가 확인되면 자동 확인은 1시간 동안 교환을 쉽니다. 캐릭터가 없는 게임은 하루 동안 계정을 다시 찾지 않습니다. 둘 다 지금 확인을 누르면 바로 다시 봅니다.

### 코드 출처

- [hoyo-codes](https://hoyo-codes.seria.moe/codes?game=genshin): `game=genshin`, `hkrpg`, `nap`
- Fandom 위키: 원신은 `Promotional_Code` 문서의 Active Codes 표, 스타레일·젠존제는 `Redemption_Code` 문서의 All Codes 표를 읽습니다. Expired 표시가 있거나 Valid until 날짜가 지난 행, 중국 서버 전용 행은 뺍니다.
  `/wiki/` 페이지는 Cloudflare에 막혀서 MediaWiki API(`api.php?action=parse`)로 받습니다.

### 교환 요청

공식 교환 페이지의 코드에서 확인한 요청을 그대로 보냅니다(2026-10-01).

| 게임 | 요청 |
| --- | --- |
| 원신 | `GET public-operation-hk4e.hoyoverse.com/common/apicdkey/api/webExchangeCdkey?uid&region&lang&cdkey&game_biz=hk4e_global` |
| 스타레일 | `POST public-operation-hkrpg.hoyoverse.com/common/apicdkey/api/webExchangeCdkeyRisk` (JSON) |
| 젠존제 | `POST public-operation-nap.hoyoverse.com/common/apicdkey/api/webExchangeCdkeyRisk` (JSON) |
| 계정 조회 | `GET api-account-os.hoyoverse.com/account/binding/api/getUserGameRolesByCookieToken?lang&region&game_biz` |

POST 본문은 `{ t, lang, game_biz, uid, region, cdkey, platform: "4", device_uuid }`입니다. 폼 형식으로 보내면 `-502`가 옵니다. `device_uuid`는 처음 한 번 만들어 저장해 두고 계속 씁니다.

쿠키는 저장하거나 복사하지 않습니다. 요청은 두 가지 방식으로 보냅니다.

- 바로 요청: 확장의 서비스 워커에서 `credentials: "include"`로 보냅니다. 권한이 있는 주소라 브라우저 쿠키가 같이 갑니다. 세 게임 모두 실제로 이 방식으로 됐습니다.
- 교환 페이지 경유: 원신 교환 페이지를 비활성 탭으로 열고 그 안에서 같은 요청을 보낸 뒤 탭을 닫습니다. 세 게임 API 모두 `*.hoyoverse.com` 출처를 허용해서 페이지 하나로 됩니다.

자동으로 두면 바로 요청을 먼저 해 보고, 로그인이 안 잡히면 경유 방식으로 바꿉니다. 설정의 연결 확인으로 둘 다 확인할 수 있습니다.

### retcode

| retcode | 상태 | 확인 |
| --- | --- | --- |
| `0` | 받음 | 세 게임 실측 |
| `0` + `gee_test_param.should_pop_verify` | 직접 입력 필요 | 공식 페이지 코드 |
| `-2017`, `-2018` | 이미 받음 (같은 묶음 코드 포함) | 원신 `-2017`, 스타레일 `-2018` 실측 |
| `-2001`, `-2006` | 만료 | `-2001` 원신·스타레일 실측 |
| `-2003`, `-2004`, `-1065` | 없는 코드 | |
| `-2008` | 다른 서버 | |
| `-2011`, `-2021` | 레벨 부족 | |
| `-2014` | 아직 안 열림 (5번까지 재시도) | |
| `-2016`, HTTP 429 | 요청 제한 | |
| `-1071`, `-100` | 로그인 필요 | 세 게임 실측 |
| `-1073` | 계정 오류 | |
| 그 외 | 알 수 없음 (5번까지 재시도) | |

확인 칸이 빈 값은 [genshin.py](https://github.com/seriaati/genshin.py)의 표를 따랐습니다. 다른 값이 오면 `redeem.js`의 `RETCODES`를 고치면 됩니다.

## 권한

`alarms`(주기 실행), `storage`(설정과 기록), `notifications`(알림), `scripting`(교환 페이지 경유)와 아래 주소만 씁니다.

- 코드 출처: `hoyo-codes.seria.moe`, Fandom 위키 세 곳
- 교환·계정 조회: `public-operation-hk4e/hkrpg/nap.hoyoverse.com`, `api-account-os.hoyoverse.com`
- 경유용 페이지: `genshin.hoyoverse.com`

## 테스트

저장소 루트(이 폴더의 상위 폴더)에서 Node 22로 돌립니다. 설치할 패키지는 없습니다.

```bash
npm test
```

```bash
npm run check:sources
```

`npm test`는 2026-10-01에 받아 둔 실제 응답(`tests/fixtures/`)과 가짜 HoYoverse 서버로 파서, 요청 형식, 확인 흐름, 1.0 기록 이전을 검사합니다. `check:sources`는 지금 올라와 있는 코드를 실제로 받아서 파서가 아직 맞는지 봅니다.

실제 계정으로 확인하려면 설정의 코드 직접 입력에 게임을 고르고 이미 쓴 코드를 넣어 보세요. 이미 받음이 나오면 맞습니다. 안 쓴 코드를 넣으면 실제로 받으니 주의하세요.

화면과 로그에는 응답 코드 숫자를 보여 주지 않고, 위 표에 없는 응답일 때만 `(응답 코드 -9999)`처럼 붙입니다. 숫자는 기록 데이터(`codes`의 `retcode`)에는 항상 남습니다.

로그는 설정 아래쪽에 있고, 더 자세한 건 `chrome://extensions`의 서비스 워커 링크를 눌러 콘솔(`[hoyo]`)에서 볼 수 있습니다.

## 한계

- 공식 API가 아니어서 주소나 응답이 예고 없이 바뀔 수 있습니다.
- 크롬이 켜져 있을 때만 확인합니다. 꺼져 있던 동안의 주기는 건너뛰고, 다음에 켤 때 한 번 확인합니다.
- 보안 확인은 2026-10-01 첫 실행(스타레일 13개, 젠존제 4개)에서는 뜨지 않았습니다. 얼마나 자주 뜨는지는 아직 모릅니다.
- 경유 방식을 쓰는 환경에서는 확인할 때 교환 페이지 탭이 잠깐 열렸다 닫힙니다.
- 위키 표 구조가 바뀌면 위키 쪽은 실패로 남고 hoyo-codes만으로 진행합니다.

## 파일

```
genshin-auto-redeem/       크롬에 로드하는 폴더
  manifest.json
  background.js            알람, 메시지, 알림
  runner.js                확인 한 번의 흐름
  games.js                 게임별 주소, 서버, UID 규칙
  sources.js               hoyo-codes, 위키 파서
  redeem.js                요청 생성, retcode 분류, 요청 방식
  storage.js               설정 기본값, 1.0 기록 이전, 저장
  popup.*, options.*       팝업, 설정 화면
  ui.css, ui.js            화면 공용
  icons/                   scripts/make-icons.js로 생성
../tests, ../scripts       개발용
```
