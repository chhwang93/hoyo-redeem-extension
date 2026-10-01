# HoYo 코드 자동 수령

원신, 붕괴: 스타레일, 젠레스 존 제로에 새 리딤코드가 올라오면 브라우저에 로그인된 HoYoverse 계정으로 대신 입력해 주는 크롬 확장입니다.

HoYoverse와 관계없는 비공식 도구입니다. 공개되지 않은 HoYoverse API를 쓰기 때문에 언제든 동작하지 않을 수 있고, 계정에 생기는 문제는 쓰는 사람 책임입니다. 쓰기 전에 HoYoverse 이용약관을 확인해 주세요.

## 설치

1. 이 저장소를 내려받거나 clone 합니다.
2. `chrome://extensions`에서 개발자 모드를 켜고, 압축해제된 확장 프로그램 로드로 `genshin-auto-redeem` 폴더를 고릅니다. 폴더 이름은 원신 전용이던 1.0 때 이름입니다.
3. [원신 교환 페이지](https://genshin.hoyoverse.com/ko/gift)에서 로그인한 뒤, 툴바 아이콘을 눌러 지금 확인을 누릅니다.

쓰는 법과 동작 방식은 [genshin-auto-redeem/README.md](genshin-auto-redeem/README.md)에 있습니다.

## 개발

Node 22만 있으면 따로 설치할 패키지 없이 돌아갑니다.

```bash
npm test
```

```bash
npm run check:sources
```

```bash
npm run icons
```

차례로 단위 테스트, 실제 코드 출처가 아직 파싱되는지 확인, 아이콘 다시 만들기입니다.

## 라이선스

[MIT](LICENSE). 단, `tests/fixtures/`의 위키 문서 내용은 Fandom의 CC BY-SA 라이선스를 따릅니다([출처](tests/fixtures/README.md)).
