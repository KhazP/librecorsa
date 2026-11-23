# LibreCorsa 한국어 현지화 용어집 (`ko`)

## 스타일 가이드

- **문체 및 어조**: 문장·안내문·설명에는 정중한 격식체(**합니다체**, 예: `저장되었습니다.`, `다시 시도해 주십시오.` / `다시 시도하세요.` 대신 `합니다/하십시오` 중심의 일관된 합쇼체)를 사용합니다. 단, 개발자의 1인칭 목소리("I'll keep trying" 등)는 자연스러운 1인칭 합쇼체(`계속 시도해 보겠습니다`)를 유지합니다.
- **버튼·라벨·HUD**: 짧은 명사형 또는 동사 어근/명사형으로 간결하게 표기합니다(예: `저장`, `계속`, `취소`, `적용`, `초기화`). 특히 `hud.` 및 `hudStyles.` 영역은 화면 공간이 좁으므로 최대한 짧게 작성합니다.
- **영문 유지 항목**: 차량명, 서킷명, 드라이버명, `LibreCorsa`, 약어(`DRS`, `ERS`, `ABS`, `TC`, `MFD`, `HUD`, `FFB`), 단위(`km/h`, `mph`, `rpm`), 섹터/순위 코드(`S1`/`S2`/`S3`, `P1`/`P2`), HUD 영문 이니셜 코드(`FL`, `PB`, `ELEC`, `TYRE`, `L{lap}`, `T{turn}` 등, 억지 초성/약어 생성 금지), 키보드 키 이름(`Esc`, `Shift`, `Enter`, `Space`, `F8`, `WASD`, `Ctrl+V` 등), 컨트롤러 버튼 이름(`Cross`, `Circle`, `A`, `B`, `L3`, `R2`, `LB` 등)은 원문 그대로 유지합니다.
- **문장 부호 및 따옴표**: 표준 한국어 문장 부호를 사용하며, ASCII 작은따옴표 `'`는 ICU MessageFormat 규칙에 따라 절대 사용하지 않습니다(필요시 `’` 사용 또는 자연스럽게 풀어쓰기).
- **복수형(ICU Plural)**: 한국어 CLDR 규칙에 따라 `other`만 사용하되, 영어 원문에 `=0` 또는 `=1` 분기가 있으면 그대로 유지합니다.
- **대소문자**: 디자인상 대문자로 표시되는 영문 라벨도 한국어는 일반 표기 규칙에 맞게 작성합니다.

## 용어집

| English | 한국어 | 비고 |
|---|---|---|
| Drive | 주행 | 메인 메뉴 주행 시작 버튼(문장/보조 문구에서는 주행 시작) |
| lap | 랩 | |
| lap time | 랩 타임 | |
| best lap | 베스트 랩 | |
| fastest lap | 패스티스트 랩 | 레이스 전체 최고 랩 |
| personal best | 개인 최고 기록 | HUD 약어는 `PB` 유지 |
| last lap | 이전 랩 | 직전 완료 랩(최종 랩 문맥에서는 `마지막 랩`) |
| out lap | 아웃 랩 | 피트 아웃 직후 랩 |
| sector | 섹터 | `S1`/`S2`/`S3` 코드 유지 |
| lap board | 랩 보드 | 서킷·차량별 온라인 랩 타임 기록표 |
| Hall of Fame | 명예의 전당 | 역대 최고 랩 기록 |
| weekly challenge | 주간 챌린지 | |
| time trial | 타임 트라이얼 | |
| practice | 연습 | 전체 명칭이 필요한 경우 `연습 주행` |
| race | 레이스 | |
| AI race | AI 레이스 | |
| grid | 그리드 | 스타팅 그리드 |
| pole position | 폴 포지션 | |
| pit lane | 피트 레인 | |
| pit limiter | 피트 리미터 | 피트 속도 제한기 |
| track limits | 트랙 리밋 | 트랙 이탈로 인한 랩 무효 규정 |
| lap deleted | 랩 무효 | 트랙 리밋 위반 등으로 삭제된 랩 |
| racing line | 레이싱 라인 | 화면에 표시되는 이상 주행선 |
| braking point | 브레이킹 포인트 | 제동 지점 |
| apex | 에이펙스 | 코너 정점 |
| kerb | 연석 | |
| run-off | 런오프 | 트랙 외곽 안전지대 |
| circuit | 서킷 | |
| layout | 레이아웃 | 서킷 구성/코스 변형 |
| hill climb | 힐 클라임 | |
| point-to-point | 구간 주행 | 출발지와 도착지가 다른 코스(명사형 수식: `구간`) |
| car | 차량 | |
| class | 클래스 | 차량 등급 |
| ghost | 고스트 | 반투명으로 표시되는 기록 주행 차량 |
| share code | 공유 코드 | 랩 또는 셋업 공유용 텍스트 코드 |
| room / room code / host / join | 방 / 방 코드 / 호스트 / 참가 | 온라인 멀티플레이어 방 관련 용어 |
| driver | 드라이버 | |
| force feedback | 포스 피드백 | 약어 `FFB` 유지 |
| steering wheel / wheel | 레이싱 휠 / 휠 | 설정·장비 명칭은 `레이싱 휠`, 짧은 표기는 `휠` |
| pedals | 페달 | |
| throttle | 스로틀 | |
| brake | 브레이크 | |
| clutch | 클러치 | |
| handbrake | 핸드브레이크 | |
| gear up / gear down | 기어 업 / 기어 다운 | 변속 조작(동사 문맥: 기어 올리기 / 기어 내리기) |
| paddle shifters | 패들 시프터 | |
| manual gearbox / automatic gearbox | 수동 변속기 / 자동 변속기 | 짧은 라벨: `수동` / `자동` |
| dead zone | 데드존 | |
| steering lock / full lock | 스티어링 록 / 풀 록 | 최대 조향각 / 끝까지 꺾음 |
| steering rotation | 스티어링 회전각 | 휠 회전 각도(도) |
| sensitivity | 감도 | |
| linearity | 선형성 | |
| gyro steering | 자이로 조향 | |
| controller | 컨트롤러 | 게임패드 |
| keyboard | 키보드 | |
| touch controls | 터치 조작 | |
| bind | 할당 | 버튼·축 매핑(동사: 할당하기) |
| axis | 축 | |
| calibrate | 보정 | |
| driving assists | 주행 보조 | |
| traction control | 트랙션 컨트롤 | 약어 `TC` 유지 |
| ABS | ABS | 영문 유지 |
| stability control | 자세 제어 | 스태빌리티 컨트롤 |
| brake bias | 브레이크 바이어스 | 전후 제동력 배분 |
| tyre wear | 타이어 마모 | |
| tyre temperatures | 타이어 온도 | |
| tyre pressure | 타이어 공기압 | |
| tyre compound | 타이어 컴파운드 | 소프트, 미디엄, 하드, 인터미디어트, 웻 |
| tyre blankets | 타이어 워머 | 주행 전 타이어 예열 장비 |
| setup | 셋업 | 차량 세팅 |
| apply setup | 셋업 적용 | |
| suspension | 서스펜션 | |
| ride height | 차고 | |
| springs | 스프링 | |
| dampers | 댐퍼 | |
| bump / rebound | 범프 / 리바운드 | 고속 범프, 저속 리바운드 |
| anti-roll bar | 안티롤 바 | |
| camber | 캠버 | |
| toe | 토 | |
| downforce | 다운포스 | |
| rear wing / front wing | 리어 윙 / 프런트 윙 | |
| active aero | 액티브 에어로 | |
| drag | 항력 | 공기 저항 |
| grip / front grip / rear grip | 그립 / 프런트 그립 / 리어 그립 | |
| understeer / oversteer | 언더스티어 / 오버스티어 | |
| differential | 디퍼렌셜 | |
| gear ratios | 기어비 | |
| fuel | 연료 | |
| yellow flag / double yellow / blue flag / black flag / chequered flag / green flag | 황기 / 이중 황기 / 청기 / 흑기 / 체커기 / 녹기 | 국제 모터스포츠 한국어 표준 |
| safety car | 세이프티 카 | |
| penalty / time penalty / drive-through | 페널티 / 시간 페널티 / 드라이브 스루 | |
| lights out | 라이트 아웃 | 레이스 스타트 신호 |
| jump start | 부정 출발 | |
| overtake / overtake mode | 추월 / 오버테이크 모드 | 동사: 추월, F1 2026 에너지 부스트: 오버테이크 모드 |
| ERS / DRS / deploy / harvest | ERS / DRS / 방출 / 회생 | `ERS`·`DRS` 유지, 에너지 방출·회생 |
| battery | 배터리 | |
| HUD | HUD | 영문 유지 |
| proximity radar | 근접 레이더 | |
| shift lights / rev lights | 시프트 라이트 / RPM 라이트 | |
| delta | 델타 | 기준 랩과의 시간 차 |
| gap | 격차 | 앞뒤 차량과의 시간 차 |
| position | 순위 | |
| mirror | 미러 | |
| camera (chase / cockpit / bonnet / Trackside TV / free) | 카메라 (체이스 카메라 / 콕핏 / 보닛 카메라 / 트랙사이드 TV / 자유 카메라) | 짧은 HUD/선택지에서는 `체이스`, `콕핏`, `보닛`, `트랙사이드 TV`, `자유` |
| replay | 리플레이 | |
| pause menu / main menu | 일시 정지 메뉴 / 메인 메뉴 | |
| restart / retry / quit / continue | 재시작 / 다시 시도 / 나가기 / 계속 | |
| Settings / Display / Audio / Controls / Graphics / Gameplay | 설정 / 디스플레이 / 오디오 / 조작 / 그래픽 / 게임플레이 | |
| quality (Low / Medium / High / Ultra) | 품질 (낮음 / 보통 / 높음 / 울트라) | 그래픽 품질 프리셋 |
| frame rate | 프레임 레이트 | |
| resolution | 해상도 | |
| Reset / Restore default | 초기화 / 기본값 복원 | |
| weather (clear / cloudy / overcast / rain / wet track / dry track) | 날씨 (맑음 / 구름 많음 / 흐림 / 비 / 젖은 노면 / 마른 노면) | |
| time of day / night | 시간대 / 야간 | 짧은 표현에서 문맥상 `밤` 가능 |
| realism | 리얼리즘 | Full realism = `풀 리얼리즘` |
| physics / physics version | 물리 / 물리 버전 | 문맥에 따라 `물리 엔진` |
| post / upload | 등록 / 업로드 | 온라인 보드에 랩 등록 / 업로드 |
| Lap times | 랩 타임 | 랩 타임 목록 화면 |

## Accounts

| English | 한국어 | 비고 |
|---|---|---|
| account | 계정 | |
| sign in / sign out | 로그인 / 로그아웃 | Google·Apple·Microsoft 표기와 동일 |
| passkey | 패스키 | |
| code / one-time code | 코드 | 일회용은 `한 번만 사용할 수 있습니다`로 풀어 씀 |
| cloud save | 클라우드 저장 데이터 | 계정의 저장 데이터 |
| save | 저장 데이터 | |
| sync | 동기화 | |
| device | 기기 | |
| join an account | 계정에 연결 / 연결 | 버튼은 `연결` |
| combine saves / accounts | 합치기 | |
| ways to sign in | 로그인 방법 | |
| driver key | 드라이버 키 | 기존 용어 유지 |
