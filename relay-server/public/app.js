/**
 * MemeCore Frontend Logic - Final Design
 */

// --- UI Controllers ---

const loadingModal = {
    el: document.getElementById('loading-modal'),
    title: document.getElementById('modal-title'),
    step: document.getElementById('modal-step'),
    
    show: function(title, stepText) {
        this.title.textContent = title;
        this.step.textContent = stepText || "Please confirm in your wallet...";
        this.el.classList.add('active');
    },
    
    update: function(text) {
        this.step.textContent = text;
    },
    
    hide: function() {
        this.el.classList.remove('active');
    }
};

function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    
    // Select based on onClick handler
    const btn = document.querySelector(`button[onclick="switchTab('${tabId}')"]`);
    if(btn) btn.classList.add('active');
    document.getElementById(`panel-${tabId}`).classList.add('active');
}

function formatDisplayValue(valueStr) {
    if (!valueStr) return "0";
    const num = parseFloat(valueStr);
    if (isNaN(num)) return "0";
    return num.toLocaleString('en-US', { maximumFractionDigits: 4, minimumFractionDigits: 0 });
}

function limitDecimals(input) {
    if (input.value.indexOf('.') !== -1) {
        const parts = input.value.split('.');
        if (parts[1].length > 4) input.value = parts[0] + '.' + parts[1].slice(0, 4);
    }
}

// --- Global State ---
const cfg = window.APP_CONFIG || {};
let phantomPubkey = null;
let evmProvider = null, evmSigner = null, evmAddress = null;
let wrappedToken = null, stakingContract = null;
let tokenDecimals = 18;

// --- Initialization ---
(function init() {
    console.log('Initializing MemeCore Interface...');
    
    // Setup Solana Mint Dropdown
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

    if (cfg.DEFAULT_MEMECORE_ADDRESS) {
        document.getElementById("evm-dest").value = cfg.DEFAULT_MEMECORE_ADDRESS;
    }
})();

// --- Wallet Connections ---

// 1. Phantom
document.getElementById('connect-phantom').addEventListener('click', async () => {
    try {
        const provider = window.solana;
        if (!provider || !provider.isPhantom) {
            alert("Phantom Wallet is not installed!");
            return;
        }
        const resp = await provider.connect();
        phantomPubkey = resp.publicKey;
        
        const btn = document.getElementById('connect-phantom');
        btn.innerHTML = `<span style="color:#10b981">●</span> ${phantomPubkey.toString().slice(0,4)}...${phantomPubkey.toString().slice(-4)}`;
        btn.classList.add('connected');
    } catch (e) {
        console.error(e);
    }
});

// 2. MetaMask
function getMetaMaskProvider() {
    const eth = window.ethereum;
    if (!eth) return null;
    if (Array.isArray(eth.providers)) return eth.providers.find((p) => p.isMetaMask && !p.isPhantom);
    if (eth.isPhantom) return null;
    return eth;
}

document.getElementById('connect-metamask').addEventListener('click', async () => {
    const eth = getMetaMaskProvider();
    if (!eth) {
        alert("MetaMask is not installed!");
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
    }
});

// --- Bridge Logic ---

async function saveDestination() {
    const addr = document.getElementById("evm-dest").value.trim();
    if (!addr) return;
    try {
        await fetch("/api/set-dest-address", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address: addr }),
        });
    } catch (e) { console.error(e); }
}

document.getElementById('bridge-btn').addEventListener('click', async () => {
    if (!phantomPubkey) { alert("Connect Phantom Wallet first!"); return; }
    
    const amountStr = document.getElementById("bridge-amount").value.trim();
    const parsed = Number(amountStr);
    if (!parsed || parsed <= 0) { alert("Invalid amount."); return; }

    await saveDestination();
    
    loadingModal.show("INITIATING WARP", "Preparing Solana transaction...");

    try {
        const selectedMint = document.getElementById("token-select").value;
        const meta = cfg.TOKEN_META || {};
        const decimals = typeof meta.decimals === "number" ? meta.decimals : 6;
        const units = BigInt(Math.round(parsed * (10 ** decimals)));

        const connection = new solanaWeb3.Connection(cfg.SOLANA_RPC, "confirmed");
        const mintPubkey = new solanaWeb3.PublicKey(selectedMint);
        const vaultPubkey = new solanaWeb3.PublicKey(cfg.SOLANA_VAULT_ADDRESS);
        
        // Check balance (Simple check)
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

        loadingModal.update("Please sign in Phantom...");
        const signed = await window.solana.signAndSendTransaction(tx);
        
        loadingModal.update("Transaction sent! Waiting for confirmation...");
        
        // Start polling for relay
        monitorBridgeStatus(signed.signature);

    } catch (e) {
        loadingModal.hide();
        alert(`Bridge Failed: ${e.message}`);
    }
});

async function monitorBridgeStatus(signature) {
    let attempts = 0;
    const interval = setInterval(async () => {
        attempts++;
        if(attempts > 30) { 
            clearInterval(interval); 
            loadingModal.hide();
            alert("Timeout: Check explorer for status.");
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
                    loadingModal.hide();
                    alert("Bridge Complete! Assets minted on MemeCore.");
                    document.getElementById("bridge-amount").value = "";
                }
            }
        } catch(e) {}
    }, 2000);
}

// --- Staking Logic ---

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function decimals() view returns (uint8)"];
const STAKE_ABI = ["function stake(uint256) external", "function requestUnstake() external", "function claimRewards() external", "function getStakerData(address) view returns (uint256,uint256,uint256,uint256)", "function mxToken() view returns (address)"];
const FACTORY_ABI = ["function solMintToWrapped(bytes32) view returns (address)"];

// Store raw balance for MAX button
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

        // Balance
        rawWrappedBalance = await wrappedToken.balanceOf(evmAddress);
        const balHuman = formatDisplayValue(ethers.formatUnits(rawWrappedBalance, tokenDecimals));
        
        document.getElementById("wrapped-balance").textContent = balHuman;
        document.getElementById("unwrap-balance-display").textContent = balHuman;
        document.getElementById("stake-available-display").textContent = balHuman;

        // Staking Info
        const data = await stakingContract.getStakerData(evmAddress);
        document.getElementById("staked-amount").textContent = formatDisplayValue(ethers.formatUnits(data[0], tokenDecimals));
        document.getElementById("pending-reward").textContent = formatDisplayValue(ethers.formatEther(data[2]));

    } catch(e) { console.error(e); }
}

// MAX Buttons
document.getElementById('stake-max-btn').addEventListener('click', () => {
    if(rawWrappedBalance > 0n) {
        document.getElementById('stake-amount').value = ethers.formatUnits(rawWrappedBalance, tokenDecimals);
    }
});

document.getElementById('unwrap-max-btn').addEventListener('click', () => {
    if(rawWrappedBalance > 0n) {
        document.getElementById('unwrap-amount').value = ethers.formatUnits(rawWrappedBalance, tokenDecimals);
    }
});

// STAKE
document.getElementById('stake-btn').addEventListener('click', async () => {
    if (!stakingContract) { alert("Load token data first."); return; }
    
    const amountVal = document.getElementById("stake-amount").value;
    if(!amountVal || parseFloat(amountVal) <= 0) return;

    loadingModal.show("STAKING", "Check your wallet...");

    try {
        const amount = ethers.parseUnits(amountVal, tokenDecimals);
        
        loadingModal.update("Approving Token...");
        const txApprove = await wrappedToken.approve(cfg.STAKING_CONTRACT_ADDR, amount);
        await txApprove.wait();
        
        loadingModal.update("Staking...");
        const txStake = await stakingContract.stake(amount, { gasLimit: 500000 }); // Safety gas
        await txStake.wait();
        
        loadingModal.hide();
        alert("Stake Successful!");
        loadStakingData();
        document.getElementById("stake-amount").value = "";
    } catch(e) {
        loadingModal.hide();
        console.error(e);
        alert("Transaction Failed. Check console.");
    }
});

// CLAIM
document.getElementById('claim-btn').addEventListener('click', async () => {
    if (!stakingContract) return;
    loadingModal.show("CLAIMING", "Confirming...");
    try {
        const tx = await stakingContract.claimRewards();
        await tx.wait();
        loadingModal.hide();
        alert("Rewards Claimed!");
        loadStakingData();
    } catch(e) { 
        loadingModal.hide();
        alert("Claim Failed"); 
    }
});

// UNSTAKE
document.getElementById('unstake-btn').addEventListener('click', async () => {
    if (!stakingContract) return;
    loadingModal.show("UNSTAKING", "Confirming...");
    try {
        const tx = await stakingContract.requestUnstake();
        await tx.wait();
        loadingModal.hide();
        alert("Unstaked Successfully!");
        loadStakingData();
    } catch(e) { 
        loadingModal.hide();
        alert("Unstake Failed"); 
    }
});

// UNWRAP
document.getElementById('unwrap-btn').addEventListener('click', async () => {
    try {
        if (!evmSigner || !evmAddress) { alert("Connect MetaMask first."); return; }
        
        const solDest = document.getElementById("unwrap-sol-dest").value.trim();
        const amountStr = document.getElementById("unwrap-amount").value.trim();
        if (!solDest || !amountStr) { alert("Invalid inputs"); return; }

        loadingModal.show("UNWRAPPING", "Preparing burn...");

        const units = ethers.parseUnits(amountStr, tokenDecimals);
        const timestamp = Math.floor(Date.now() / 1000);
        const msg = `UNWRAP:${amountStr}:${solDest}:${timestamp}`;
        
        loadingModal.update("Sign the request in MetaMask...");
        const signature = await evmSigner.signMessage(msg);

        loadingModal.update("Processing on server...");
        const res = await fetch("/api/unwrap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount: amountStr, solanaAddress: solDest, evmAddress, timestamp, signature }),
        });
        
        const data = await res.json();
        loadingModal.hide();

        if (data.status === "ok") {
            alert(`Unwrap Complete! Burn Tx: ${data.evmTxHash.slice(0,10)}...`);
            document.getElementById("unwrap-amount").value = "";
            loadStakingData();
        } else {
            alert(`Unwrap Failed: ${data.message}`);
        }
    } catch (e) { 
        loadingModal.hide();
        alert(`Error: ${e.message}`); 
    }
});