require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const HELIUS_KEY = (process.env.HELIUS_RPC || "").match(/api-key=([^&]+)/)?.[1] || "";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const ENHANCED_URL = `https://api-mainnet.helius-rpc.com/v0/addresses`;
const PORT = process.env.PORT || 3000;

// ─── Helpers ────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

// ─── Helius RPC: Баланс токена ──────────────────────────────

async function getTokenBalance(wallet, mint) {
  try {
    const result = await rpcCall("getTokenAccountsByOwner", [
      wallet,
      { mint },
      { encoding: "jsonParsed" },
    ]);
    if (!result.value || result.value.length === 0) return 0;
    let total = 0;
    for (const acc of result.value) {
      total += parseFloat(acc.account.data.parsed.info.tokenAmount.uiAmount || 0);
    }
    return total;
  } catch (err) {
    console.error(`  ⚠️ [Balance] ${wallet.slice(0, 6)}: ${err.message}`);
    return 0;
  }
}

// ─── Helius RPC: Total Supply ───────────────────────────────

async function getTotalSupply(mint) {
  try {
    const result = await rpcCall("getTokenSupply", [mint]);
    return parseFloat(result.value.uiAmount || 0);
  } catch (err) {
    console.error(`  ⚠️ [Supply]: ${err.message}`);
    return 0;
  }
}

// ─── Helius Enhanced API: Parse Transaction History ─────────
//
// Получаем ВСЕ транзакции кошелька через Helius Enhanced API,
// фильтруем по нужному токену, считаем bought/sold в SOL
//

async function getWalletPnL(wallet, mint) {
  let boughtSol = 0;
  let soldSol = 0;
  let buyCount = 0;
  let sellCount = 0;
  let lastSignature = null;
  let totalTxFetched = 0;
  const MAX_PAGES = 20; // макс 20 страниц × 100 = 2000 транзакций

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      let url = `${ENHANCED_URL}/${wallet}/transactions/?api-key=${HELIUS_KEY}&limit=100`;
      if (lastSignature) {
        url += `&before=${lastSignature}`;
      }

      const res = await fetch(url, { timeout: 30000 });
      if (!res.ok) {
        console.error(`  ⚠️ Helius API ${res.status}: ${res.statusText}`);
        break;
      }

      const txs = await res.json();
      if (!txs || txs.length === 0) break;

      totalTxFetched += txs.length;

      for (const tx of txs) {
        // Проверяем swap события
        if (tx.events?.swap) {
          const swap = tx.events.swap;
          
          // Покупка токена: отдал SOL → получил токен
          const tokenOutput = (swap.tokenOutputs || []).find(
            (t) => t.mint?.toLowerCase() === mint.toLowerCase()
          );
          if (tokenOutput && swap.nativeInput) {
            const solAmount = (swap.nativeInput.amount || 0) / 1e9;
            if (solAmount > 0) {
              boughtSol += solAmount;
              buyCount++;
            }
          }

          // Продажа токена: отдал токен → получил SOL
          const tokenInput = (swap.tokenInputs || []).find(
            (t) => t.mint?.toLowerCase() === mint.toLowerCase()
          );
          if (tokenInput && swap.nativeOutput) {
            const solAmount = (swap.nativeOutput.amount || 0) / 1e9;
            if (solAmount > 0) {
              soldSol += solAmount;
              sellCount++;
            }
          }
          continue;
        }

        // Fallback: проверяем через tokenTransfers + nativeTransfers
        if (tx.tokenTransfers && tx.nativeTransfers) {
          const tokenTxs = tx.tokenTransfers.filter(
            (t) => t.mint?.toLowerCase() === mint.toLowerCase()
          );

          if (tokenTxs.length === 0) continue;

          // Получил токены → покупка
          const received = tokenTxs.some(
            (t) => t.toUserAccount?.toLowerCase() === wallet.toLowerCase()
          );
          // Отправил токены → продажа
          const sent = tokenTxs.some(
            (t) => t.fromUserAccount?.toLowerCase() === wallet.toLowerCase()
          );

          if (received && tx.type === "SWAP") {
            // Считаем SOL потраченный
            for (const nt of tx.nativeTransfers) {
              if (
                nt.fromUserAccount?.toLowerCase() === wallet.toLowerCase() &&
                nt.amount > 0
              ) {
                boughtSol += nt.amount / 1e9;
                buyCount++;
              }
            }
          }

          if (sent && tx.type === "SWAP") {
            // Считаем SOL полученный
            for (const nt of tx.nativeTransfers) {
              if (
                nt.toUserAccount?.toLowerCase() === wallet.toLowerCase() &&
                nt.amount > 0
              ) {
                soldSol += nt.amount / 1e9;
                sellCount++;
              }
            }
          }
        }
      }

      // Пагинация: берём подпись последней транзакции
      lastSignature = txs[txs.length - 1]?.signature;
      if (!lastSignature || txs.length < 100) break;

      // Маленькая пауза между страницами
      await sleep(100);
    }
  } catch (err) {
    console.error(`  ⚠️ [PnL] ${wallet.slice(0, 6)}: ${err.message}`);
  }

  return {
    boughtSol,
    soldSol,
    pnl: soldSol - boughtSol,
    buyCount,
    sellCount,
    txFetched: totalTxFetched,
  };
}

// ─── API: /api/scan ─────────────────────────────────────────

app.post("/api/scan", async (req, res) => {
  const { wallets, mint } = req.body;
  if (!wallets || !mint || !Array.isArray(wallets)) {
    return res.status(400).json({ error: "wallets[] and mint required" });
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`🚀 Scan: ${wallets.length} wallets | ${mint.slice(0, 8)}...${mint.slice(-4)}`);
  console.log(`📡 Source: Helius Enhanced API (on-chain data)`);
  console.log(`${"═".repeat(60)}`);

  try {
    // 1) Total supply
    const totalSupply = await getTotalSupply(mint);
    console.log(`📊 Supply: ${(totalSupply / 1e6).toFixed(2)}M\n`);

    // 2) Сканируем кошельки ПАРАЛЛЕЛЬНО
    //    (но с лёгким stagger чтобы не словить rate limit)
    const BATCH_SIZE = 5; // по 5 кошельков одновременно
    const results = [];

    for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
      const batch = wallets.slice(i, i + BATCH_SIZE);
      
      const batchResults = await Promise.all(
        batch.map(async (wallet, j) => {
          const idx = i + j;
          await sleep(j * 150); // 150ms между стартами в батче

          console.log(`🔍 [${idx + 1}/${wallets.length}] ${wallet.slice(0, 6)}...${wallet.slice(-4)}`);

          // Баланс + PnL параллельно
          const [balance, pnl] = await Promise.all([
            getTokenBalance(wallet, mint),
            getWalletPnL(wallet, mint),
          ]);

          const holdPct = totalSupply > 0 ? (balance / totalSupply) * 100 : 0;

          console.log(
            `  ✅ Buy:${pnl.boughtSol.toFixed(2)} Sell:${pnl.soldSol.toFixed(2)} Hold:${holdPct.toFixed(2)}% (${pnl.txFetched} txs parsed)`
          );

          return {
            wallet,
            walletShort: wallet.slice(0, 4) + "..." + wallet.slice(-4),
            balance,
            holdingPercent: holdPct,
            boughtSol: pnl.boughtSol,
            soldSol: pnl.soldSol,
            pnl: pnl.pnl,
            buyCount: pnl.buyCount,
            sellCount: pnl.sellCount,
            txParsed: pnl.txFetched,
          };
        })
      );

      results.push(...batchResults);

      // Пауза между батчами
      if (i + BATCH_SIZE < wallets.length) {
        await sleep(200);
      }
    }

    // 3) Totals
    const totals = results.reduce(
      (a, r) => ({
        totalBought: a.totalBought + r.boughtSol,
        totalSold: a.totalSold + r.soldSol,
        totalPnl: a.totalPnl + r.pnl,
        totalHoldingPercent: a.totalHoldingPercent + r.holdingPercent,
      }),
      { totalBought: 0, totalSold: 0, totalPnl: 0, totalHoldingPercent: 0 }
    );

    console.log(`\n${"─".repeat(60)}`);
    console.log(`📊 TOTAL → Bought: ${totals.totalBought.toFixed(2)} | Sold: ${totals.totalSold.toFixed(2)} SOL | Holding: ${totals.totalHoldingPercent.toFixed(2)}%`);
    console.log(`${"─".repeat(60)}\n`);

    res.json({ success: true, totalSupply, wallets: results, totals });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ──────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n⚡ Wallet Scanner → http://localhost:${PORT}`);
  console.log(`📡 Helius Key: ${HELIUS_KEY ? HELIUS_KEY.slice(0, 8) + "..." : "⚠️ NOT SET!"}`);
  console.log(`📡 RPC: ${RPC_URL.slice(0, 55)}...`);
  console.log(`📡 Enhanced API: ${ENHANCED_URL}\n`);
});
