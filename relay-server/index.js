const path = require("path");
require("dotenv").config({
  // 루트 디렉토리의 .env 를 공통으로 사용
  path: path.resolve(__dirname, "..", ".env"),
});

const { Connection, PublicKey, Keypair, Transaction } = require("@solana/web3.js");
const { ethers } = require("ethers");
const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
const http = require("http");
const bs58 = require("bs58");
const {
  getOrCreateAssociatedTokenAccount,
  createTransferCheckedInstruction,
} = require("@solana/spl-token");

// --- 환경 변수 ---
const SOLANA_RPC =
  process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const MEMECORE_RPC =
  process.env.MEMECORE_RPC || "https://rpc.formicarium.memecore.net";
const MEMECORE_CHAIN_ID = Number(process.env.MEMECORE_CHAIN_ID || 43521);

const SOLANA_VAULT_ADDRESS = process.env.SOLANA_VAULT_ADDRESS || "";
const SOLANA_TOKEN_MINT = process.env.SOLANA_TOKEN_MINT || "";

const STAKING_CONTRACT_ADDR = process.env.STAKING_CONTRACT_ADDR || "0x...";
const BRIDGE_FACTORY_ADDR = process.env.BRIDGE_FACTORY_ADDR || "0x...";
const VALIDATOR_PRIVATE_KEY = process.env.VALIDATOR_PRIVATE_KEY || "0x...";
const DEFAULT_MEMECORE_ADDRESS =
  process.env.DEFAULT_MEMECORE_ADDRESS || "";

const SOLANA_WALLET_PRIVATE_KEY =
  process.env.SOLANA_WALLET_PRIVATE_KEY || "";

// 여러 개의 Solana mint 를 지원하기 위해, SOLANA_TOKEN_MINT 를
// 콤마(,)로 구분된 리스트로 사용할 수 있게 처리한다.
// 예: SOLANA_TOKEN_MINT=Mint1,Mint2,Mint3
const SOLANA_MINT_LIST = (SOLANA_TOKEN_MINT || "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// 첫 번째 mint 를 기본값으로 사용 (프론트 표시 및 역브릿지 기본값)
const PRIMARY_SOL_MINT = SOLANA_MINT_LIST[0] || "";

// --- 브릿지 처리 내역 JSON 저장 (서버 재시작 후에도 재처리 방지) ---
const DEPOSITS_DB_PATH = path.join(__dirname, "processed-deposits.json");
let processedDeposits = {};
try {
  if (fs.existsSync(DEPOSITS_DB_PATH)) {
    const raw = fs.readFileSync(DEPOSITS_DB_PATH, "utf8");
    processedDeposits = JSON.parse(raw || "{}");
  }
} catch (e) {
  console.warn("[Bridge] Failed to load processed deposits DB:", e);
  processedDeposits = {};
}

const processedSignatures = new Set(Object.keys(processedDeposits));
const processingSignatures = new Set();

// --- Solana Vault Keypair (for reverse bridge) ---
let vaultKeypair = null;
if (SOLANA_WALLET_PRIVATE_KEY) {
  try {
    const keyData = SOLANA_WALLET_PRIVATE_KEY.trim();
    const secretKey = keyData.startsWith("[")
      ? Uint8Array.from(JSON.parse(keyData))
      : bs58.decode(keyData);
    vaultKeypair = Keypair.fromSecretKey(secretKey);
    if (
      SOLANA_VAULT_ADDRESS &&
      vaultKeypair.publicKey.toBase58() !== SOLANA_VAULT_ADDRESS
    ) {
      console.warn(
        "[Bridge] WARNING: SOLANA_WALLET_PRIVATE_KEY pubkey != SOLANA_VAULT_ADDRESS. Reverse bridge transfers will use the private key wallet."
      );
    }
  } catch (e) {
    console.warn(
      "[Bridge] Failed to parse SOLANA_WALLET_PRIVATE_KEY for reverse bridge:",
      e.message
    );
    vaultKeypair = null;
  }
}

// --- ABI 로드 (Hardhat 아티팩트 기준) ---
let stakingAbi;
let bridgeFactoryAbi;
try {
  stakingAbi = require("../artifacts/contracts/MemeCoreStaking.sol/MemeCoreStaking.json").abi;
  bridgeFactoryAbi = require("../artifacts/contracts/BridgeFactory.sol/BridgeFactory.json").abi;
} catch (e) {
  console.warn(
    "[WARN] Hardhat artifacts not found. Build contracts to enable full relay features."
  );
  stakingAbi = [];
  bridgeFactoryAbi = [];
}

// --- 브릿지 래핑 토큰 메타데이터 (Solana memecoin 설정에서 자동 로드 시도) ---
let baseName = "Unknown Token";
let baseSymbol = "X";
let tokenDecimals = 6;
let tokenMetadataUri = "";
try {
  const cfg = require("../solana-memecoin/memecoin-config.json");
  if (cfg.name) baseName = cfg.name;
  if (cfg.symbol) baseSymbol = cfg.symbol;
  if (typeof cfg.decimals === "number") tokenDecimals = cfg.decimals;
  if (cfg.metadataUri) tokenMetadataUri = cfg.metadataUri;
} catch (e) {
  console.warn(
    "[Bridge] solana-memecoin/memecoin-config.json not found or invalid. Using default token metadata."
  );
}

// --- 클라이언트 초기화 ---
const solConnection = new Connection(SOLANA_RPC, "confirmed");
const memeProvider = new ethers.JsonRpcProvider(
  MEMECORE_RPC,
  MEMECORE_CHAIN_ID
);
const validatorWallet = new ethers.Wallet(
  VALIDATOR_PRIVATE_KEY,
  memeProvider
);

const stakingContract = new ethers.Contract(
  STAKING_CONTRACT_ADDR,
  stakingAbi,
  validatorWallet
);

const bridgeFactory = new ethers.Contract(
  BRIDGE_FACTORY_ADDR,
  bridgeFactoryAbi,
  validatorWallet
);

// --- 1. Oracle: 가격 업데이트 (수동/요청 기반) ---
async function updatePriceOnce() {
  if (!stakingAbi.length) {
    throw new Error("Staking ABI not loaded");
  }
  try {
    const price = Number(process.env.FAKE_PRICE || "1.5");
    const priceScale = ethers.parseUnits(price.toString(), 8); // 8 decimals

    console.log(`[Oracle] Updating price (on-demand): $${price}`);
    const tx = await stakingContract.updatePrice(priceScale);
    await tx.wait();
    console.log("[Oracle] Price update tx:", tx.hash);
    return tx.hash;
  } catch (e) {
    console.error("[Oracle] Error:", e);
    throw e;
  }
}

// --- 2. UTC 00:00 보상 분배 ---
cron.schedule(
  "0 0 * * *",
  async () => {
    if (!stakingAbi.length) return;
    console.log("[Reward] Running daily reward distribution...");
    try {
      const currentBalance = await memeProvider.getBalance(
        validatorWallet.address
      );
      const rewardAmount = (currentBalance * 50n) / 100n; // 잔고의 50%

      if (rewardAmount > 0n) {
        const tx = await stakingContract.distributeDailyRewards({
          value: rewardAmount,
        });
        await tx.wait();
        console.log(
          `[Reward] Distributed ${ethers.formatEther(
            rewardAmount
          )} M (native) to stakers. tx=${tx.hash}`
        );
      } else {
        console.log("[Reward] No balance to distribute.");
      }
    } catch (e) {
      console.error("[Reward] Error:", e);
    }
  },
  {
    timezone: "Etc/UTC",
  }
);

// --- 3. Solana → MemeCore 브릿지 (RPC 기반, Anchor X) ---

async function handleDepositSignature(sig, { verbose = true } = {}) {
  if (!SOLANA_VAULT_ADDRESS || !SOLANA_MINT_LIST.length || !bridgeFactoryAbi.length) {
    return { status: "not_configured" };
  }

  if (processedSignatures.has(sig)) {
    return {
      status: "already_processed",
      record: processedDeposits[sig] || null,
    };
  }

  if (processingSignatures.has(sig)) {
    return { status: "processing" };
  }

  processingSignatures.add(sig);

  try {
    const tx = await solConnection.getParsedTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.meta) {
      return { status: "pending" };
    }

    if (tx.meta.err) {
      if (verbose) {
        console.warn("[Bridge] Solana tx has error meta for", sig, tx.meta.err);
      }
      return { status: "failed", error: tx.meta.err };
    }

    const pre = tx.meta.preTokenBalances || [];
    const post = tx.meta.postTokenBalances || [];

    let handled = false;
    let lastRecord = null;

    for (let i = 0; i < post.length; i++) {
      const p = post[i];
      // 허용된 mint 목록에 포함되지 않은 토큰은 무시
      if (!SOLANA_MINT_LIST.includes(p.mint)) continue;
      if (p.owner !== SOLANA_VAULT_ADDRESS) continue;

      const accountIndex = p.accountIndex;
      const preBalance = pre.find((b) => b.accountIndex === accountIndex);
      const preAmount = preBalance
        ? BigInt(preBalance.uiTokenAmount.amount)
        : 0n;
      const postAmount = BigInt(p.uiTokenAmount.amount);
      const delta = postAmount - preAmount;
      if (delta <= 0n) continue;

      if (!currentDestAddress) {
        if (verbose) {
          console.warn(
            "[Bridge] Destination EVM address not set. Skipping mint for",
            sig
          );
        }
        return { status: "no_destination" };
      }

      const recipient = currentDestAddress;

      // Solana SPL 토큰의 base unit 을 그대로 사용 (decimals 일치)
      const mintAmount = delta;

      const wrappedName = `M ${baseName}`;
      const wrappedSymbol = `M${baseSymbol}`;
      // 단일 토큰이 아닌 경우에도, Solana 의 decimals 정보를 우선 사용
      const decimalsForWrapped =
        typeof p.uiTokenAmount?.decimals === "number"
          ? p.uiTokenAmount.decimals
          : tokenDecimals || 6;

      const solMintHash = ethers.keccak256(
        ethers.toUtf8Bytes(p.mint)
      );

      if (verbose) {
        console.log(
          `[Bridge] Detected deposit on Solana. tx=${sig}, mint=${p.mint}, amountBase=${mintAmount.toString()}, decimals=${decimalsForWrapped}`
        );
      }

        const txMint = await bridgeFactory.mintFromSolana(
          solMintHash,
          p.mint,
          wrappedName,
          wrappedSymbol,
          decimalsForWrapped,
          recipient,
          mintAmount
        );
      await txMint.wait();

      if (verbose) {
        console.log(
          `[Bridge] Minted ${mintAmount.toString()} M tokens to ${recipient} via BridgeFactory. mint=${p.mint}, tx=${txMint.hash}`
        );
      }

      processedSignatures.add(sig);
      const record = {
        solanaSignature: sig,
        solanaMint: p.mint,
        vault: SOLANA_VAULT_ADDRESS,
        recipient,
        amount: mintAmount.toString(),
        decimals: decimalsForWrapped,
        evmTxHash: txMint.hash,
        timestamp: Date.now(),
      };
      processedDeposits[sig] = record;
      lastRecord = record;

      try {
        fs.writeFileSync(
          DEPOSITS_DB_PATH,
          JSON.stringify(processedDeposits, null, 2),
          "utf8"
        );
      } catch (err) {
        console.error("[Bridge] Failed to persist deposits DB:", err);
      }

      handled = true;
      break; // 단일 Vault ATA 기준
    }

    if (!handled) {
      return { status: "no_deposit" };
    }

    return { status: "minted", record: lastRecord };
  } catch (e) {
    console.error("[Bridge] handleDepositSignature error:", e);
    return { status: "error", message: e.message || String(e) };
  } finally {
    processingSignatures.delete(sig);
  }
}

// --- Reverse Bridge: send SPL token from Vault to user on Solana ---
async function sendSplFromVault(toSolAddress, amountBaseUnits) {
  if (!vaultKeypair) {
    throw new Error("Vault keypair not configured for reverse bridge");
  }
  if (!PRIMARY_SOL_MINT) {
    throw new Error("PRIMARY_SOL_MINT is not configured");
  }

  // 현재 역브릿지는 첫 번째 mint(PRIMARY_SOL_MINT)에 대해서만 지원
  const mintPubkey = new PublicKey(PRIMARY_SOL_MINT);
  const destOwner = new PublicKey(toSolAddress);

  // Ensure ATAs exist
  const sourceAta = await getOrCreateAssociatedTokenAccount(
    solConnection,
    vaultKeypair,
    mintPubkey,
    vaultKeypair.publicKey
  );
  const destAta = await getOrCreateAssociatedTokenAccount(
    solConnection,
    vaultKeypair,
    mintPubkey,
    destOwner
  );

  const decimals = tokenDecimals;
  const ix = createTransferCheckedInstruction(
    sourceAta.address,
    mintPubkey,
    destAta.address,
    vaultKeypair.publicKey,
    BigInt(amountBaseUnits),
    decimals
  );

  const tx = new Transaction().add(ix);
  tx.feePayer = vaultKeypair.publicKey;
  const { blockhash, lastValidBlockHeight } =
    await solConnection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  const sig = await solConnection.sendTransaction(tx, [vaultKeypair]);
  await solConnection.confirmTransaction(
    {
      blockhash,
      lastValidBlockHeight,
      signature: sig,
    },
    "confirmed"
  );

  return sig;
}

async function pollSolanaDeposits() {
  if (
    !SOLANA_VAULT_ADDRESS ||
    !SOLANA_MINT_LIST.length ||
    !bridgeFactoryAbi.length
  )
    return;

  try {
    const vaultPubkey = new PublicKey(SOLANA_VAULT_ADDRESS);

    const sigInfos = await solConnection.getSignaturesForAddress(
      vaultPubkey,
      { limit: 20 }
    );

    for (const info of sigInfos) {
      const sig = info.signature;
      if (processedSignatures.has(sig)) continue;

      await handleDepositSignature(sig, { verbose: true });
    }
  } catch (e) {
    console.error("[Bridge] pollSolanaDeposits error:", e);
  }
}

setInterval(pollSolanaDeposits, 10_000);

// --- 4. 간단한 웹 서버 (포트 3000) - 정적 대시보드 제공 ---

const PUBLIC_DIR = path.join(__dirname, "public");

let currentDestAddress = DEFAULT_MEMECORE_ADDRESS;

const CONFIG_FOR_CLIENT = {
  SOLANA_RPC,
  SOLANA_VAULT_ADDRESS,
  SOLANA_TOKEN_MINT: PRIMARY_SOL_MINT,
  SOLANA_MINT_LIST,
  MEMECORE_RPC,
  MEMECORE_CHAIN_ID,
  BRIDGE_FACTORY_ADDR,
  STAKING_CONTRACT_ADDR,
  DEFAULT_MEMECORE_ADDRESS: currentDestAddress,
  TOKEN_META: {
    name: baseName,
    symbol: baseSymbol,
    decimals: tokenDecimals,
    mint: SOLANA_TOKEN_MINT,
    metadataUri: tokenMetadataUri,
  },
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url || "/", "http://localhost");
  const url = parsedUrl.pathname || "/";

  // 간단 HTTP 로그 (디버깅용)
  if (url.startsWith("/api/")) {
    console.log("[HTTP]", req.method, url);
  }

  if (url === "/" || url === "/index.html") {
    const filePath = path.join(PUBLIC_DIR, "index.html");
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  // 이전의 /bridge, /staking 별도 페이지는 SPA 탭으로 통합되었으므로 모두 index.html 로 라우팅
  if (
    url === "/bridge" ||
    url === "/bridge.html" ||
    url === "/staking" ||
    url === "/staking.html"
  ) {
    const filePath = path.join(PUBLIC_DIR, "index.html");
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (url === "/config.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(
      "window.APP_CONFIG = " +
        JSON.stringify(
          { ...CONFIG_FOR_CLIENT, DEFAULT_MEMECORE_ADDRESS: currentDestAddress },
          null,
          2
        ) +
        ";"
    );
    return;
  }

  if (url === "/api/update-price" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        const txHash = await updatePriceOnce();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, txHash }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            message: err.message || String(err),
          })
        );
      }
    });
    return;
  }

  if (url === "/api/confirm-bridge" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const sig = parsed.signature;
        if (typeof sig !== "string" || !sig.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "bad_request" }));
          return;
        }
        const result = await handleDepositSignature(sig.trim(), {
          verbose: false,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error("[Bridge] /api/confirm-bridge error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "error",
            message: err.message || String(err),
          })
        );
      }
    });
    return;
  }

  if (url === "/api/unwrap" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        if (!bridgeFactoryAbi.length) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "error",
              message: "BridgeFactory ABI not loaded",
            })
          );
          return;
        }
        if (!vaultKeypair) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "error",
              message:
                "Solana vault keypair not configured. Set SOLANA_WALLET_PRIVATE_KEY in .env.",
            })
          );
          return;
        }

        const parsed = JSON.parse(body || "{}");
        const { amount, solanaAddress, evmAddress, timestamp, signature } =
          parsed;

        if (
          typeof amount !== "string" ||
          !amount.trim() ||
          Number(amount) <= 0
        ) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ status: "bad_request", message: "Invalid amount" })
          );
          return;
        }

        let solAddr;
        try {
          solAddr = new PublicKey(solanaAddress).toBase58();
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "bad_request",
              message: "Invalid Solana address",
            })
          );
          return;
        }

        if (typeof timestamp !== "number") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "bad_request",
              message: "Missing timestamp",
            })
          );
          return;
        }

        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - timestamp) > 60 * 10) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "bad_request",
              message: "Request timestamp too old or in the future",
            })
          );
          return;
        }

        const msg = `UNWRAP:${amount}:${solAddr}:${timestamp}`;
        let recovered;
        try {
          recovered = ethers.verifyMessage(msg, signature);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "bad_request",
              message: "Invalid signature",
            })
          );
          return;
        }

        if (
          !evmAddress ||
          ethers.getAddress(evmAddress) !== ethers.getAddress(recovered)
        ) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "bad_request",
              message: "Signer mismatch",
            })
          );
          return;
        }

        // Parse amount to base units
        const decimals =
          typeof tokenDecimals === "number" && tokenDecimals >= 0
            ? tokenDecimals
            : 6;
        const amountUnits = ethers.parseUnits(amount, decimals);

        const solMintHash = ethers.keccak256(
          ethers.toUtf8Bytes(SOLANA_TOKEN_MINT)
        );
        const erc20Abi = [
          "function balanceOf(address) view returns (uint256)",
        ];

        const wrappedAddr = await bridgeFactory.solMintToWrapped(solMintHash);
        if (wrappedAddr === ethers.ZeroAddress) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "bad_request",
              message:
                "Wrapped token for this Solana mint does not exist. Bridge in first.",
            })
          );
          return;
        }

        const wrappedToken = new ethers.Contract(
          wrappedAddr,
          erc20Abi,
          validatorWallet
        );
        const userBal = await wrappedToken.balanceOf(recovered);
        if (userBal < amountUnits) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "bad_request",
              message: "Insufficient M-token balance to unwrap",
            })
          );
          return;
        }

        console.log(
          `[Unwrap] Burning ${amountUnits.toString()} from ${recovered} and sending to Solana ${solAddr}`
        );

        const txBurn = await bridgeFactory.burnForSolana(
          solMintHash,
          recovered,
          amountUnits
        );
        await txBurn.wait();

        const solSig = await sendSplFromVault(solAddr, amountUnits);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            evmTxHash: txBurn.hash,
            solanaTx: solSig,
          })
        );
      } catch (err) {
        console.error("[Bridge] /api/unwrap error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "error",
            message: err.message || String(err),
          })
        );
      }
    });
    return;
  }

  if (url === "/api/set-dest-address" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const addr = parsed.address;
        if (
          typeof addr !== "string" ||
          !/^0x[0-9a-fA-F]{40}$/.test(addr.trim())
        ) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid EVM address");
          return;
        }
        currentDestAddress = addr.trim();
        console.log("[Bridge] Destination EVM address set to:", currentDestAddress);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, address: currentDestAddress }));
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request");
      }
    });
    return;
  }

  // static files (app.js, css, etc.)
  const safePath = path.normalize(url).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    let contentType = "text/plain";
    if (filePath.endsWith(".js")) contentType = "application/javascript";
    else if (filePath.endsWith(".html"))
      contentType = "text/html; charset=utf-8";
    else if (filePath.endsWith(".css")) contentType = "text/css";

    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(
    `Relay server started (RPC-based BridgeFactory). Web UI: http://localhost:${PORT}`
  );
});

