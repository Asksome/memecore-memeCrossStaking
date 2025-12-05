/**
 * MemeCore Frontend Logic - Final Ant Version
 * Features:
 * 1. Live Network Dashboard (Block Height, Real-time Reward Pool)
 * 2. Merged Bridge UI
 * 3. Strict Number Formatting
 * 4. Phantom Anti-Hijacking
 */

// --- UI Controllers ---

const ui = {
    modal: document.getElementById('universal-modal'),
    title: document.getElementById('modal-title'),
    desc: document.getElementById('modal-desc'),
    step: document.getElementById('modal-step'),
    spinner: document.getElementById('modal-spinner'),
    closeBtn: document.getElementById('modal-close-btn'),
    
    // Show Loading/Processing State (No Close Button)
    showLoading: function(title, stepText) {
        this.title.textContent = title;
        this.step.textContent = stepText || "Please confirm in your wallet...";
        this.step.style.display = 'block';
        this.desc.style.display = 'block';
        this.spinner.style.display = 'flex'; // GIF Container
        this.closeBtn.style.display = 'none';
        this.modal.classList.add('active');
    },
    
    updateStep: function(text) {
        this.step.textContent = text;
    },
    
    // Show Alert/Result State (Has Close Button)
    showAlert: function(title, message, isError = false) {
        this.title.textContent = title;
        this.title.style.color = isError ? 'var(--danger)' : 'var(--accent)';
        this.desc.textContent = message;
        this.desc.style.display = 'block';
        this.step.style.display = 'none'; // Hide step details for simple alerts
        this.spinner.style.display = 'none'; // Hide GIF for alerts
        this.closeBtn.style.display = 'block';
        this.modal.classList.add('active');
    },
    
    hide: function() {
        this.modal.classList.remove('active');
        // Reset styles
        this.title.style.color = 'var(--accent)';
        this.desc.textContent = "Please wait while the transaction is being confirmed on the blockchain.";
    }
};

// Close button handler for Modal
document.getElementById('modal-close-btn').addEventListener('click', () => {
    ui.hide();
});

// Main Tab Switcher (Bridge vs Staking)
function switchMainTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    
    const btn = document.querySelector(`button[onclick="switchMainTab('${tabId}')"]`);
    if(btn) btn.classList.add('active');
    document.getElementById(`panel-${tabId}`).classList.add('active');
}

// Number Formatting (Max 4 decimals, Commas for thousands)
function formatDisplayValue(valueStr) {
    if (!valueStr) return "0";
    const num = parseFloat(valueStr);
    if (isNaN(num)) return "0";
    
    return new Intl.NumberFormat('en-US', { 
        minimumFractionDigits: 0, 
        maximumFractionDigits: 4 
    }).format(num);
}

// Input Validator (Limits typing to 4 decimal places)
function limitDecimals(input) {
    let val = input.value;
    if (val.indexOf('.') !== -1) {
        const parts = val.split('.');
        if (parts[1].length > 4) {
            input.value = parts[0] + '.' + parts[1].slice(0, 4);
        }
    }
}

// --- Bridge UI Logic (Merged Inbound/Outbound) ---
let currentBridgeMode = 'inbound'; // 'inbound' or 'outbound'

function setBridgeDirection(mode) {
    currentBridgeMode = mode;
    
    // Toggle Buttons
    document.getElementById('btn-dir-inbound').classList.toggle('active', mode === 'inbound');
    document.getElementById('btn-dir-outbound').classList.toggle('active', mode === 'outbound');
    
    // Toggle Forms
    document.getElementById('form-inbound').style.display = mode === 'inbound' ? 'block' : 'none';
    document.getElementById('form-outbound').style.display = mode === 'outbound' ? 'block' : 'none';
    
    // Update Header & Badge & Button Text
    const title = document.getElementById('bridge-card-title');
    const badge = document.getElementById('bridge-badge');
    const btn = document.getElementById('action-bridge-btn');
    const balanceRow = document.getElementById('outbound-balance-row');

    if (mode === 'inbound') {
        title.textContent = "DEPOSIT TO MEMECORE";
        badge.textContent = "SOLANA DEVNET";
        btn.textContent = "INITIATE WARP (SOL -> EVM)";
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-primary');
        balanceRow.style.display = 'none';
    } else {
        title.textContent = "WITHDRAW TO SOLANA";
        badge.textContent = "UNWRAP / BURN";
        btn.textContent = "BURN & RELEASE (EVM -> SOL)";
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-danger');
        balanceRow.style.display = 'block';
    }
}

// --- Global State ---
const cfg = window.APP_CONFIG || {};
let phantomPubkey = null;
let evmProvider = null, evmSigner = null, evmAddress = null;
let wrappedToken = null, stakingContract = null;
let tokenDecimals = 18;
// Globals for reward calculation
let currentRewardPool = 0; 
let currentStakedAmount = 0; // Total Staked

// --- Network Dashboard State ---
let lastBlockTimestamp = Date.now();
// Default to 3 seconds if no data yet
let currentBlockTimeMs = 3000; 

// --- Initialization ---
(function init() {
    console.log('Initializing MemeCore Interface...');
    
    // Start Live Network Monitor (Dashboard)
    startNetworkMonitor();

    // Setup Dropdowns
    const tokenSelect = document.getElementById("token-select");
    const stakingSelect = document.getElementById("staking-token-select");

    if (tokenSelect) {
        tokenSelect.innerHTML = '';
        const meta = cfg.TOKEN_META || {};
        const opt = document.createElement("option");
        opt.value = cfg.SOLANA_TOKEN_MINT;
        opt.textContent = (meta.symbol || "TOKEN");
        tokenSelect.appendChild(opt);
    }

    if (stakingSelect) {
        stakingSelect.innerHTML = '';
        const meta = cfg.TOKEN_META || {};
        const opt = document.createElement("option");
        opt.value = cfg.SOLANA_TOKEN_MINT;
        opt.textContent = (meta.symbol || "TOKEN") + " (M-Token)";
        stakingSelect.appendChild(opt);
        stakingSelect.addEventListener('change', loadStakingData);
    }
})();

// --- NEW: Live Network Monitor ---
async function startNetworkMonitor() {
    const wsUrl = 'wss://ws.memecore.net'; // Or use cfg.WS_URL if available
    
    // 1. REWARD POOL LOGIC (UTC 00:00 - 24:00 Accumulation)
    const DAILY_TARGET = 5000000.0; 

    setInterval(() => {
        const now = new Date();
        // Calculate seconds passed in UTC day
        const secondsInDay = (now.getUTCHours() * 3600) + (now.getUTCMinutes() * 60) + now.getUTCSeconds();
        const totalSeconds = 86400;
        
        // Progress Ratio of the day (0.0 to 1.0)
        const dayProgress = secondsInDay / totalSeconds;
        
        // Pool Value Logic: 50% of target accumulated over the day
        const accumulated = DAILY_TARGET * dayProgress;
        const poolValue = accumulated * 0.5;
        currentRewardPool = poolValue; // Store globally

        const rewardEl = document.getElementById("net-reward-pool");
        if(rewardEl) {
            rewardEl.innerText = formatDisplayValue(poolValue.toString());
        }
    }, 1000); 

    // 2. BLOCK MONITOR & PROGRESS BAR LOGIC
    try {
        const monitorProvider = new ethers.WebSocketProvider(wsUrl);
        console.log("Connecting to MemeCore Network Stream...");

        monitorProvider.on("block", async (blockNumber) => {
            try {
                const now = Date.now();
                // Measure actual time since last block
                const timeDiff = now - lastBlockTimestamp; 
                lastBlockTimestamp = now;

                // Update moving average or just use last diff if valid (> 100ms)
                if (timeDiff > 100 && timeDiff < 60000) {
                    currentBlockTimeMs = timeDiff;
                }

                // --- Trigger Progress Bar Animation ---
                resetAndAnimateProgressBar(currentBlockTimeMs);

                // Update Text
                updateTicker("net-block-height", `#${blockNumber}`);

                // TPS Calculation
                const block = await monitorProvider.getBlock(blockNumber);
                if (block) {
                    const txCount = block.transactions.length;
                    const tps = timeDiff > 0 ? (txCount / (timeDiff/1000)).toFixed(1) : "0.0";
                    updateTicker("net-tps", tps);
                }
            } catch (err) {
                console.error("Monitor Error:", err);
            }
        });

    } catch (e) {
        console.warn("WebSocket Monitor Failed:", e);
        document.getElementById("net-block-height").innerText = "OFFLINE";
    }
}

// Function to animate bar per block
function resetAndAnimateProgressBar(durationMs) {
    const bar = document.getElementById("block-progress-bar");
    if (!bar) return;

    // 1. Reset to 0 instantly (remove transition)
    bar.style.transition = 'none';
    bar.style.width = '0%';

    // 2. Force reflow to apply the reset
    void bar.offsetWidth;

    // 3. Animate to 100% over the duration of expected block time
    // Using linear ease for gauge feel
    bar.style.transition = `width ${durationMs}ms linear`;
    bar.style.width = '100%';
}

function updateTicker(id, value) {
    const el = document.getElementById(id);
    if(el) {
        el.innerText = value;
        el.classList.remove("updated");
        void el.offsetWidth;
        el.classList.add("updated");
    }
}


// --- Wallet Connections ---

// 1. Phantom
document.getElementById('connect-phantom').addEventListener('click', async () => {
    try {
        const provider = window.solana;
        if (!provider || !provider.isPhantom) {
            ui.showAlert("Wallet Error", "Phantom Wallet is not installed!", true);
            return;
        }
        const resp = await provider.connect();
        phantomPubkey = resp.publicKey;
        
        const btn = document.getElementById('connect-phantom');
        btn.innerHTML = `<span style="color:#10b981">●</span> ${phantomPubkey.toString().slice(0,4)}...${phantomPubkey.toString().slice(-4)}`;
        btn.classList.add('connected');
    } catch (e) {
        console.error(e);
        ui.showAlert("Connection Failed", e.message, true);
    }
});

// Helper: Get Real MetaMask (Bypass Phantom Hijacking)
function getTrueMetaMaskProvider() {
    if (!window.ethereum) return null;

    if (window.ethereum.providers) {
        return window.ethereum.providers.find(p => p.isMetaMask && !p.isPhantom);
    }
    
    if (window.ethereum.isMetaMask && !window.ethereum.isPhantom) {
        return window.ethereum;
    }
    
    return null;
}

// 2. MetaMask
document.getElementById('connect-metamask').addEventListener('click', async () => {
    const eth = getTrueMetaMaskProvider();
    
    if (!eth) {
        ui.showAlert("Wallet Error", "MetaMask is not installed (or Phantom is blocking it).", true);
        return;
    }
    
    try {
        const accounts = await eth.request({ method: "eth_requestAccounts" });
        evmProvider = new ethers.BrowserProvider(eth);
        evmSigner = await evmProvider.getSigner();
        evmAddress = ethers.getAddress(accounts[0]);
        
        const btn = document.getElementById('connect-metamask');
        btn.innerHTML = `<span style="color:#10b981">●</span> ${evmAddress.slice(0,6)}...${evmAddress.slice(-4)}`;
        
        loadStakingData(); 
    } catch (e) {
        console.error(e);
        ui.showAlert("Connection Failed", e.message, true);
    }
});

// --- Main Bridge Action Handler ---
document.getElementById('action-bridge-btn').addEventListener('click', () => {
    if (currentBridgeMode === 'inbound') {
        handleInboundBridge();
    } else {
        handleOutboundBridge();
    }
});

// 1. Inbound Logic (SOL -> EVM)
async function handleInboundBridge() {
    if (!phantomPubkey) { ui.showAlert("Wallet Required", "Please connect Phantom Wallet first.", true); return; }
    
    const amountStr = document.getElementById("bridge-amount").value.trim();
    const evmDest = document.getElementById("evm-dest").value.trim();
    
    const parsed = Number(amountStr);
    if (!parsed || parsed <= 0) { ui.showAlert("Invalid Input", "Please enter a valid amount.", true); return; }
    if (!evmDest || !evmDest.startsWith("0x")) { ui.showAlert("Invalid Input", "Please enter a valid EVM address.", true); return; }

    try {
        await fetch("/api/set-dest-address", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address: evmDest }),
        });
    } catch (e) {}
    
    ui.showLoading("INITIATING WARP", "Preparing Solana transaction...");

    try {
        const selectedMint = document.getElementById("token-select").value;
        const meta = cfg.TOKEN_META || {};
        const decimals = typeof meta.decimals === "number" ? meta.decimals : 6;
        const units = BigInt(Math.round(parsed * (10 ** decimals)));

        const connection = new solanaWeb3.Connection(cfg.SOLANA_RPC, "confirmed");
        const mintPubkey = new solanaWeb3.PublicKey(selectedMint);
        const vaultPubkey = new solanaWeb3.PublicKey(cfg.SOLANA_VAULT_ADDRESS);
        
        // Check balance
        const srcRes = await connection.getParsedTokenAccountsByOwner(phantomPubkey, { mint: mintPubkey });
        if (!srcRes.value.length) throw new Error("No token account found.");
        const sourceTokenAccount = srcRes.value[0].pubkey;
        
        const dstRes = await connection.getParsedTokenAccountsByOwner(vaultPubkey, { mint: mintPubkey });
        if (!dstRes.value.length) throw new Error("Vault not initialized.");
        const destTokenAccount = dstRes.value[0].pubkey;

        const keys = [
            { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
            { pubkey: mintPubkey, isSigner: false, isWritable: false },
            { pubkey: destTokenAccount, isSigner: false, isWritable: true },
            { pubkey: phantomPubkey, isSigner: true, isWritable: false },
        ];

        function u64ToBytes(val) {
            const b = new Uint8Array(8);
            let v = BigInt(val);
            for(let i=0; i<8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
            return b;
        }
        const data = new Uint8Array(10);
        data[0] = 12; data.set(u64ToBytes(units), 1); data[9] = decimals;

        const ix = new solanaWeb3.TransactionInstruction({ keys, programId: new solanaWeb3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), data });
        const tx = new solanaWeb3.Transaction().add(ix);
        tx.feePayer = phantomPubkey;
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;

        ui.updateStep("Please sign in Phantom...");
        const signed = await window.solana.signAndSendTransaction(tx);
        
        ui.updateStep("Transaction sent! Waiting for confirmation...");
        monitorBridgeStatus(signed.signature);

    } catch (e) {
        ui.hide();
        ui.showAlert("Bridge Failed", e.message, true);
    }
}

// 2. Outbound Logic (EVM -> SOL)
async function handleOutboundBridge() {
    try {
        if (!evmSigner || !evmAddress) { ui.showAlert("Wallet Required", "Connect MetaMask first.", true); return; }
        
        const solDest = document.getElementById("unwrap-sol-dest").value.trim();
        const amountStr = document.getElementById("bridge-amount").value.trim();
        
        if (!solDest || !amountStr) { ui.showAlert("Invalid Input", "Please fill all fields.", true); return; }

        ui.showLoading("UNWRAPPING", "Preparing burn...");

        const timestamp = Math.floor(Date.now() / 1000);
        const msg = `UNWRAP:${amountStr}:${solDest}:${timestamp}`;
        
        ui.updateStep("Sign the request in MetaMask...");
        const signature = await evmSigner.signMessage(msg);

        ui.updateStep("Processing on server...");
        const res = await fetch("/api/unwrap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount: amountStr, solanaAddress: solDest, evmAddress, timestamp, signature }),
        });
        
        const data = await res.json();
        
        if (data.status === "ok") {
            ui.showAlert("Unwrap Complete!", `Burn Tx: ${data.evmTxHash.slice(0,10)}...`);
            document.getElementById("bridge-amount").value = "";
            loadStakingData();
        } else {
            ui.showAlert("Unwrap Failed", data.message, true);
        }
    } catch (e) { 
        ui.hide();
        ui.showAlert("Error", e.message, true);
    }
}

async function monitorBridgeStatus(signature) {
    let attempts = 0;
    const interval = setInterval(async () => {
        attempts++;
        if(attempts > 30) { 
            clearInterval(interval); 
            ui.showAlert("Timeout", "Check explorer for status.", true);
            return; 
        }
        try {
            const res = await fetch("/api/confirm-bridge", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ signature }),
            });
            if(res.ok) {
                const data = await res.json();
                if (data.status === "minted" || data.status === "already_processed") {
                    clearInterval(interval);
                    ui.showAlert("Success!", "Bridge Complete! Assets minted on MemeCore.");
                    document.getElementById("bridge-amount").value = "";
                }
            }
        } catch(e) {}
    }, 2000);
}

// --- Staking Logic ---

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function decimals() view returns (uint8)"];
const STAKE_ABI = [
    "function stake(uint256) external", 
    "function requestUnstake() external", 
    "function claimRewards() external", 
    "function getStakerData(address) view returns (uint256,uint256,uint256,uint256)", 
    "function mxToken() view returns (address)",
    "function totalStakedAmount() view returns (uint256)",
    "function currentTokenPriceUSD() view returns (uint256)"
];
const FACTORY_ABI = ["function solMintToWrapped(bytes32) view returns (address)"];

let rawWrappedBalance = 0n;

async function loadStakingData() {
    if (!evmSigner) return;
    try {
        const selectedMint = document.getElementById("staking-token-select").value;
        if(!selectedMint) return;

        const factory = new ethers.Contract(cfg.BRIDGE_FACTORY_ADDR, FACTORY_ABI, evmSigner);
        const solMintHash = ethers.keccak256(ethers.toUtf8Bytes(selectedMint));
        const wrappedAddr = await factory.solMintToWrapped(solMintHash);
        
        if (wrappedAddr === ethers.ZeroAddress) {
            document.getElementById('wrapped-token-address').textContent = "Token Not Bridged Yet";
            return;
        }
        
        document.getElementById('wrapped-token-address').textContent = wrappedAddr;
        wrappedToken = new ethers.Contract(wrappedAddr, ERC20_ABI, evmSigner);
        stakingContract = new ethers.Contract(cfg.STAKING_CONTRACT_ADDR, STAKE_ABI, evmSigner);
        tokenDecimals = await wrappedToken.decimals();

        // 1. Balance
        rawWrappedBalance = await wrappedToken.balanceOf(evmAddress);
        const balHuman = formatDisplayValue(ethers.formatUnits(rawWrappedBalance, tokenDecimals));
        
        document.getElementById("wrapped-balance").textContent = balHuman;
        document.getElementById("unwrap-balance-display").textContent = balHuman;
        document.getElementById("stake-available-display").textContent = balHuman;

        // 2. User Staking Info
        const data = await stakingContract.getStakerData(evmAddress);
        const stakedAmount = data[0]; // uint256
        
        document.getElementById("staked-amount").textContent = formatDisplayValue(ethers.formatUnits(stakedAmount, tokenDecimals));
        document.getElementById("pending-reward").textContent = formatDisplayValue(ethers.formatEther(data[2]));

        // 3. Global Stats for TVL and Share
        const totalStaked = await stakingContract.totalStakedAmount();
        const price8 = await stakingContract.currentTokenPriceUSD(); // 8 decimals
        
        currentStakedAmount = parseFloat(ethers.formatUnits(totalStaked, tokenDecimals));
        const price = parseFloat(ethers.formatUnits(price8, 8));

        // Calculate TVL
        const tvl = currentStakedAmount * price;
        document.getElementById("tvl-amount").textContent = "$" + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(tvl);

        // Calculate Share %
        let share = 0;
        if (currentStakedAmount > 0) {
            const userStaked = parseFloat(ethers.formatUnits(stakedAmount, tokenDecimals));
            share = (userStaked / currentStakedAmount) * 100;
        }
        document.getElementById("share-percent").textContent = share.toFixed(3) + "%";

        // Calculate Estimated User Reward
        // This estimates the user's portion of the *upcoming* daily pool
        const estUserReward = currentRewardPool * (share / 100);
        document.getElementById("est-user-reward").textContent = formatDisplayValue(estUserReward.toFixed(2));

    } catch(e) { console.error(e); }
}

// MAX Buttons
document.getElementById('stake-max-btn').addEventListener('click', () => {
    if(rawWrappedBalance > 0n) {
        const el = document.getElementById('stake-amount');
        el.value = ethers.formatUnits(rawWrappedBalance, tokenDecimals);
        limitDecimals(el);
    }
});

document.getElementById('unwrap-max-btn').addEventListener('click', () => {
    if(rawWrappedBalance > 0n) {
        const el = document.getElementById('bridge-amount');
        el.value = ethers.formatUnits(rawWrappedBalance, tokenDecimals);
        limitDecimals(el);
    }
});

// STAKE
document.getElementById('stake-btn').addEventListener('click', async () => {
    if (!stakingContract) { ui.showAlert("Error", "Load token data first.", true); return; }
    
    const amountVal = document.getElementById("stake-amount").value;
    if(!amountVal || parseFloat(amountVal) <= 0) return;

    ui.showLoading("STAKING", "Check your wallet...");

    try {
        // Price update removed/commented as per instruction scope focus on dashboard
        
        // 2) Actual Stake
        const amount = ethers.parseUnits(amountVal, tokenDecimals);
        
        ui.updateStep("Approving Token...");
        const txApprove = await wrappedToken.approve(cfg.STAKING_CONTRACT_ADDR, amount);
        await txApprove.wait();
        
        ui.updateStep("Staking...");
        const txStake = await stakingContract.stake(amount, { gasLimit: 500000 });
        await txStake.wait();
        
        ui.showAlert("Success", "Stake Successful!");
        loadStakingData();
        document.getElementById("stake-amount").value = "";
    } catch(e) {
        ui.hide();
        console.error(e);
        ui.showAlert("Failed", "Transaction Failed. Check console.", true);
    }
});

// CLAIM
document.getElementById('claim-btn').addEventListener('click', async () => {
    if (!stakingContract) return;
    ui.showLoading("CLAIMING", "Confirming...");
    try {
        const tx = await stakingContract.claimRewards();
        await tx.wait();
        ui.showAlert("Success", "Rewards Claimed!");
        loadStakingData();
    } catch(e) { 
        ui.showAlert("Error", "Claim Failed", true); 
    }
});

// UNSTAKE
document.getElementById('unstake-btn').addEventListener('click', async () => {
    if (!stakingContract) return;
    ui.showLoading("UNSTAKING", "Confirming...");
    try {
        const tx = await stakingContract.requestUnstake();
        await tx.wait();
        ui.showAlert("Success", "Unstaked Successfully!");
        loadStakingData();
    } catch(e) { 
        ui.showAlert("Error", "Unstake Failed", true); 
    }
});