// upgraded_execution_loop.js - Fully Upgraded Solana Micro-Spot Engine
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
require('dotenv').config();

// Upgraded Modules
const { 
  getDynamicPriorityFee, 
  calculateADX, 
  getAdaptivePositionSize, 
  evaluateFeeLockExit 
} = require('./engine_upgrades');

const { validateHTFTrendGate } = require('./htf_trend_gate');
const { validateVolumeDeltaGate } = require('./volume_delta_gate');
const { validateMicroExecution, recordTradeOutcome } = require('./consecutive_streak_guard');
const { evaluateExitConditions } = require('./micro_exit_handler');

const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SOLANA_PRIVATE_KEY)));

const TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
};

let activePosition = null;

/**
 * Upgraded 1-Minute Core Cycle Tick
 */
async function process1mTick() {
  try {
    console.log(`\n--- [UPGRADED 1M ENGINE TICK] ${new Date().toISOString()} ---`);

    // 1. Balance & Infrastructure Safety Checks
    const walletBalanceSol = await connection.getBalance(wallet.publicKey) / 1e9;
    const solPriceUsd = await getSolUsdPrice();
    const walletBalanceUsd = walletBalanceSol * solPriceUsd;

    const riskCheck = validateMicroExecution(walletBalanceUsd);
    if (!riskCheck.allowed) {
      console.warn(`[RISK BLOCKED]: ${riskCheck.reason}`);
      return;
    }

    // 2. Fetch Candle Datasets
    const candles1m = await fetchCandles('1m');
    const candles15m = await fetchCandles('15m');
    const currentPrice = candles1m[candles1m.length - 1].close;

    // ---------------------------------------------------------
    // SCENARIO A: OPEN POSITION MANAGEMENT & EXITS
    // ---------------------------------------------------------
    if (activePosition) {
      // Step A1: Check Fee-Lock Guard (+1.2% threshold check)
      const feeLockCheck = evaluateFeeLockExit(activePosition, currentPrice);
      if (feeLockCheck.triggerExit) {
        console.log(`🔒 [FEE-LOCK TRIGGERED]: Exiting to lock in positive yields.`);
        await executeOptimizedSwap(TOKENS.USDC, TOKENS.SOL, activePosition.tokenAmount);
        
        recordTradeOutcome((currentPrice - activePosition.entryPrice) * activePosition.tokenAmount);
        activePosition = null;
        return;
      }

      // Step A2: Check Standard Exit Rules (Dynamic ATR / Hard SL / TP)
      const exitEvaluation = evaluateExitConditions(activePosition, candles1m);
      if (exitEvaluation.shouldExit) {
        console.log(`⚡ [EXIT TRIGGERED]: ${exitEvaluation.exitType}`);
        await executeOptimizedSwap(
          TOKENS.USDC, 
          TOKENS.SOL, 
          activePosition.tokenAmount * exitEvaluation.percentageToClose
        );

        const pnlUsd = (currentPrice - activePosition.entryPrice) * activePosition.tokenAmount;
        recordTradeOutcome(pnlUsd);

        if (exitEvaluation.percentageToClose === 1.0) {
          activePosition = null;
        } else {
          activePosition.isPartialClosed = true;
        }
      }
      return;
    }

    // ---------------------------------------------------------
    // SCENARIO B: ADX VOLATILITY SIZING & GATE EVALUATIONS
    // ---------------------------------------------------------
    const adxVal = calculateADX(candles1m, 14);
    const sizing = getAdaptivePositionSize(walletBalanceUsd, adxVal);

    if (sizing.mode === 'CHOP_STANDBY') {
      console.log(`⏸️ [ADX CHOP GUARD]: ADX = ${adxVal.toFixed(1)} <= 20. Standing by in 100% Cash.`);
      return;
    }

    // Layer 1: HTF 15m Trend Gate
    const htfResult = validateHTFTrendGate(candles15m, currentPrice);
    if (!htfResult.passed) {
      console.log(`[LAYER 1 REJECT]: ${htfResult.reason}`);
      return;
    }

    // Layer 2: Micro Volume & Delta Expansion Gate
    const microResult = validateVolumeDeltaGate(candles1m, 2.0, 0.70);
    if (!microResult.passed) {
      console.log(`[LAYER 2 REJECT]: ${microResult.reason}`);
      return;
    }

    // ---------------------------------------------------------
    // SCENARIO C: EXECUTE ENTRY WITH DYNAMIC PRIORITY TIP
    // ---------------------------------------------------------
    console.log(`🚀 [ENTRY CONFIRMED] ADX Mode: \({sizing.mode} (\)${sizing.sizeUsd.toFixed(2)} Allocation)`);
    const lamportsToSwap = Math.floor((sizing.sizeUsd / solPriceUsd) * 1e9);

    const txid = await executeOptimizedSwap(TOKENS.SOL, TOKENS.USDC, lamportsToSwap);

    activePosition = {
      entryPrice: currentPrice,
      entryTime: Date.now(),
      tokenAmount: sizing.sizeUsd / currentPrice,
      stopPrice: currentPrice * 0.988, // Initial dynamic stop
      feeLockActivated: false,
      isPartialClosed: false
    };

    console.log(`✅ [TRADE ENTERED] TXID: ${txid}`);

  } catch (err) {
    console.error("❌ Engine Error:", err.message);
  }
}

/**
 * Optimized On-Chain Swap Execution with Dynamic Fees
 */
async function executeOptimizedSwap(inputMint, outputMint, amountLamports) {
  // 1. Calculate Dynamic Priority Fee
  const priorityFeeMicroLamports = await getDynamicPriorityFee(connection, [new PublicKey(inputMint)]);

  // 2. Query Jupiter V6 Quote
  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=\({inputMint}&outputMint=\){outputMint}&amount=${amountLamports}&slippageBps=50`;
  const quoteRes = await axios.get(quoteUrl);

  // 3. Build Transaction with Dynamic Compute & Priority Tips
  const swapRes = await axios.post('https://quote-api.jup.ag/v6/swap', {
    quoteResponse: quoteRes.data,
    userPublicKey: wallet.publicKey.toString(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: priorityFeeMicroLamports
  });

  const swapBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(swapBuf);
  transaction.sign([wallet]);

  // 4. Submit via RPC Cluster
  return await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 2
  });
}

// Polling interval (every 60s)
setInterval(process1mTick, 60 * 1000);
