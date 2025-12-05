## MemeCore ↔ Solana Cross-Chain Bridge & Value Staking (Hackathon 버전)

이 레포는 **Solana Devnet SPL 토큰 ↔ MemeCore Formicarium Testnet** 간 브릿지와  
**가치 기반 스테이킹**을 하나의 프로젝트로 구현한 해커톤 제출물입니다.

- Solana: 우리가 발행한 SPL 밈코인(들)을 Vault 지갑에서 관리
- MemeCore(EVM): Solana 토큰을 1:1 랩핑한 M-토큰(ERC20) + 스테이킹 컨트랙트
- Off-chain: Node.js 릴레이 서버 + 단일 페이지 웹 UI (Phantom / MetaMask 지원)

이 버전은 **Anchor 프로그램 없이, Solana RPC + Vault 지갑만으로 브릿지**를 구현합니다.

---

### 1. 네트워크 정보

- **MemeCore Formicarium Testnet**
  - RPC: `https://rpc.formicarium.memecore.net`
  - Chain ID: `43521`
- **Solana Devnet**
  - RPC: `.env 의 SOLANA_RPC` (예: Helius Devnet RPC)

---

### 2. 폴더 구조 & 역할

- `contracts/`
  - `BridgeWrappedToken.sol`  
    - EIP-1167 최소 프록시로 복제되는 **M-토큰 구현 컨트랙트**
    - `initialize(name, symbol, solanaMint, decimals, bridge, owner)` 한 번만 호출
    - `mint`, `burn` 권한은 오직 `BridgeFactory`(bridge) 에게만 부여
  - `BridgeFactory.sol`  
    - 여러 Solana mint 에 대해 동적으로 랩토큰을 생성/관리하는 팩토리
    - `mapping(bytes32 solMintHash => address wrapped)`  
    - `mintFromSolana(...)` : 최초 호출 시 랩토큰 클론 생성 → 이후 mint
    - `burnForSolana(...)` : 역브릿지 시 M-토큰 burn (Solana 출금은 서버에서)
  - `MemeCoreStaking.sol`  
    - 단일 M-토큰에 대한 **가치 기반 스테이킹 + 일일 보상 분배** 컨트랙트
    - MasterChef 스타일 `rewardPerShare` / `rewardDebt` 방식

- `scripts/`
  - `deploy.js` : `BridgeWrappedToken` 구현 + `BridgeFactory` 배포
  - `deploy-staking.js` : 현재 Solana mint 에 대응하는 랩토큰 주소를 찾아 `MemeCoreStaking` 배포
  - `manual-distribute.js` : 벨리데이터 지갑에서 스테이킹 컨트랙트로 M(네이티브) 보상 수동 전송

- `relay-server/`
  - `index.js` :  
    - Solana Vault 지갑에 대한 입금 폴링 (RPC 기반)
    - MemeCore 상의 `BridgeFactory.mintFromSolana` 호출
    - 가격 오라클 업데이트 / 일일 보상 분배 (cron)
    - 역브릿지(Unwrap) 처리 (`burnForSolana` + Solana SPL 출금)
    - HTTP 서버 + 단일 페이지 웹 UI 제공 (`public/index.html`)
  - `public/index.html` :  
    - **브릿지 탭**: Phantom 지갑으로 Solana → Vault 전송, 목적지 MemeCore 주소 설정, Unwrap UI
    - **스테이킹 탭**: MetaMask + MemeCore Testnet, M-토큰 스테이킹/언스테이킹/보상 청구 UI

- `solana-memecoin/`
  - `create-memecoin.js` :  
    - Solana Devnet에 SPL 밈코인 **실제 발행** + Metaplex 메타데이터 등록
    - `SOLANA_WALLET_PRIVATE_KEY` (Phantom export) 를 사용
  - `memecoin-config.json` : 발행된 SPL 토큰 정보 (mint, decimals, metadata URI 등)
  - `metadata.json` : 메타데이터 샘플/참고용

- `flat/`  
  - `*.flat.sol` : 검증용 플랫된 Solidity 소스 (MemeCoreScan Verify에서 사용)

- `artifacts/`, `cache/`  
  - Hardhat 컴파일 산출물 (검증/디버깅용, 제출 시 포함 여부는 선택)

---

### 3. 설치 & 환경 설정

#### 3-1. 의존성 설치

```bash
cd "memecore testnet"
npm install
```

#### 3-2. `.env` 생성

루트에 `.env` 파일을 만들고, 다음 예시를 참고해 값을 채웁니다.  
(`.env.example` 파일도 참고 가능)

```env
SOLANA_RPC=https://devnet.helius-rpc.com/?api-key=...
SOLANA_WALLET_PRIVATE_KEY=<Phantom 지갑 비공개키 (bs58 또는 JSON 배열)>
SOLANA_VAULT_ADDRESS=<입금을 받을 Solana Vault 지갑 주소>
SOLANA_TOKEN_MINT=Mint1,Mint2,...   # 여러 mint 를 콤마로 구분

MEMECORE_RPC=https://rpc.formicarium.memecore.net
MEMECORE_CHAIN_ID=43521
MEMECORE_PRIVATE_KEY=0x<MemeCore 배포 지갑 프라이빗키>
VALIDATOR_PRIVATE_KEY=0x<보상/브릿지 트랜잭션을 보낼 밸리데이터 키 (보통 위와 동일)>
DEFAULT_MEMECORE_ADDRESS=0x<초기 브릿지 목적지 주소>
STAKING_CONTRACT_ADDR=0x<배포 후 채움>
BRIDGE_FACTORY_ADDR=0x<배포 후 채움>
FAKE_PRICE=1.5   # 테스트용 고정 가격 (USD)
```

> **주의:** 실제 프라이빗키가 들어가는 `.env` 는 절대 Git에 올리지 말고,  
> 해커톤 제출용으로는 `.env.example` 만 포함하는 것을 권장합니다.

---

### 4. Solana 측: 밈코인 발행

1. Solana CLI + Phantom 지갑 준비 (Devnet)
2. `.env` 의 `SOLANA_WALLET_PRIVATE_KEY` 에 Phantom 비공개키 설정
3. Devnet 밈코인 발행:

```bash
npm run create-memecoin   # package.json 에 alias 되어 있음
```

스텝:
- 이름 / 심볼 / 소수점 / 총 발행량 / 메타데이터 URI 입력
- Devnet에 SPL Mint 생성 + ATA 발행 + 전량 민트
- Metaplex 메타데이터 계정까지 자동 생성

발행이 완료되면:
- `solana-memecoin/memecoin-config.json` 에 mint 정보 반영
- `.env` 의 `SOLANA_TOKEN_MINT` 에 해당 mint 주소(들)를 설정

---

### 5. MemeCore 측: 컨트랙트 배포 (Hardhat)

#### 5-1. BridgeFactory & BridgeWrappedToken 배포

```bash
npm run deploy-memecore
```

로그 예시:

- `BridgeWrappedToken implementation deployed to: 0x...`
-, BridgeFactory deployed to: 0x...`

이 값을 `.env` 의 `BRIDGE_FACTORY_ADDR` 로 복사합니다.

#### 5-2. Staking 컨트랙트 배포

```bash
npm run deploy-staking
```

이 스크립트는 내부에서:
- `BridgeFactory.solMintToWrapped(keccak256(SOLANA_TOKEN_MINT[0]))` 를 조회하고,
- 해당 랩토큰 주소를 `_mxToken` 으로 사용해 `MemeCoreStaking` 을 배포합니다.

로그에 출력되는 `MemeCoreStaking` 주소를 `.env` 의 `STAKING_CONTRACT_ADDR` 로 복사합니다.

> **여러 mint** 를 동시에 지원하지만, 현재 스테이킹 컨트랙트는 “대표 mint(배열의 첫 번째)” 전용입니다.  
> 추가 mint 들에 대한 스테이킹을 따로 만들고 싶다면, 같은 스크립트를 mint 별로 확장하면 됩니다.

---

### 6. 릴레이 서버 & 웹 UI

#### 6-1. 실행

```bash
npm run start-relay
```

- Oracle, Reward cron, 브릿지 폴링, HTTP 서버가 한 프로세스에서 모두 돌아갑니다.
- 콘솔에:
  - `[Oracle] Updating price: $1.5`
  - `Relay server started (RPC-based BridgeFactory). Web UI: http://localhost:3000`
  등이 출력됩니다.

#### 6-2. 웹 UI

브라우저에서 `http://localhost:3000` 접속:

- **Bridge (Solana ➡ MemeCore)** 탭
  - Phantom 연결
  - 지원 mint 목록 드롭다운 (여러 개일 경우)
  - 목적지 MemeCore EVM 주소 입력
  - 브릿지 수량 입력 후, Phantom 거래 승인
  - 릴레이 서버가 Vault 입금을 감지하면, 해당 mint 전용 랩토큰 클론을 자동 생성 + 민팅

- **Staking (MemeCore Testnet)** 탭
  - MetaMask 연결 + MemeCore 네트워크 추가 버튼
  - 선택한 mint 에 대응하는 랩토큰 주소 자동 조회 (`BridgeFactory.solMintToWrapped`)
  - 내 잔고 / 스테이킹 수량 / Pending Reward 표시
  - `Approve & Stake` / `Unstake All` / `Claim Rewards` 버튼 제공

- **Unwrap (MemeCore ➡ Solana)** 섹션
  - Solana 목적지 주소 + Unwrap 수량 입력
  - MetaMask 서명(`UNWRAP:amount:solAddr:timestamp`) → 서버 검증
  - 서버가 `BridgeFactory.burnForSolana()` 로 M-토큰 burn 후, Vault 지갑에서 Solana SPL 토큰 출금
  - 현재는 **대표 mint(배열의 첫 번째)** 에 대해서만 Unwrap 지원

---

### 7. 다중 Solana 토큰 지원 방식

- `.env` 의 `SOLANA_TOKEN_MINT` 에 여러 mint 를 콤마로 정의:

```env
SOLANA_TOKEN_MINT=MintA,MintB,MintC
```

- 릴레이 서버:
  - Vault 주소에 대한 트랜잭션의 `postTokenBalances` 를 훑으면서,
  - `p.mint` 가 `SOLANA_MINT_LIST` 안에 있는 경우만 브릿지 처리
  - mint 별로 `solMintHash = keccak256(mint)` 를 사용해 **서로 다른 랩토큰 컨트랙트**를 생성
- 프론트:
  - Bridge / Staking 탭의 드롭다운에서 mint 를 선택하면,
  - 해당 mint 에 대응하는 랩토큰/스테이킹 정보만 불러와서 보여줌

---

### 8. 스테이킹 & 보상 로직

- `MemeCoreStaking`  
  - `stake(amount)` : M-토큰을 컨트랙트로 전송하고, `rewardPerShare` 에 따라 `rewardDebt` 업데이트
  - `distributeDailyRewards()` :  
    - 오너(밸리데이터)가 `msg.value` 만큼 네이티브 M 을 스테이킹 풀에 주입
    - `rewardPerShare += (msg.value * 1e18) / totalStakedAmount`
  - `claimRewards()` :  
    - `_updateUserReward` 로 pending → accumulated 반영 후, 네이티브 M 전송

- 릴레이 서버의 cron:
  - 1분마다: `FAKE_PRICE` 를 사용해 `updatePrice()` 호출 (테스트용)
  - 매일 UTC 00:00: 밸리데이터 지갑 잔고의 50% 를 `distributeDailyRewards()` 로 전송

- 수동 보상 분배:

```bash
npm run set-distribute        # 10 M 고정 분배
npm run distribute -- 5.5     # 5.5 M 처럼 원하는 양 분배
```

---

### 9. 해커톤 제출 시 포함하면 좋은 파일들

**필수로 포함 권장:**

- `README.md` (이 파일)
- `contracts/` (Solidity 소스 3개)
- `scripts/` (`deploy*.js`, `manual-distribute.js`)
- `relay-server/index.js`
- `relay-server/public/index.html`
- `solana-memecoin/` (`create-memecoin.js`, `memecoin-config.json`, `metadata.json`)
- `hardhat.config.js`
- `package.json`, `package-lock.json`
- `.env.example`
- `flat/*.flat.sol` (검증용 소스)

**포함해도 되고 빼도 되는 것:**

- `artifacts/`, `cache/` (컴파일 산출물 – 용량이 크면 생략 가능)

**절대 제출하지 말 것 (Git ignore 권장):**

- `.env` (실제 프라이빗키/민감정보)
- `node_modules/`
- OS/IDE 산출물 (`.DS_Store`, `.cursor/`, 기타 IDE 설정 파일)

해커톤에서는 보통 **GitHub 레포 링크 + 짧은 실행 가이드**만으로 충분하므로,  
이 레포 전체를 업로드하되 `.env` 만 빼고 공유하면 심사자가 바로 실행·테스트할 수 있는 형태가 됩니다.

