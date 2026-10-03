// dry_run_runner.js - 24-Hour Paper Trading Validator
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
require('dotenv').config();

const { 
  getDynamicPriorityFee, 
  calculateADX, 
  getAdaptivePositionSize, 
  evaluateFeeLockExit 
} = require('./engine_upgrades');

const { validateHTFTrendGate } = require('./htf_trend_gate');
const { validateVolumeDeltaGate } = require('./volume_delta_gate');
const { validateMicroExecution } = require('./consecutive_streak_guard');
const { evaluateExitConditions } = require('./micro_exit_handler');

const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const wallet = Keypair.generate(); // Temporary dummy keypair for paper simulation

const TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
};

// Paper Trading Portfolio State ($5.00 Starting Balance)
let paperPortfolio = {
  walletBalanceUsd: 5.00,
  gasReserveUsd: 1.50, // Preserved $1.50 gas floor
  activePosition: null,
  paperTradeHistory: []
};

async function processPaperTick() {
  try {
    console.log(`\n--- [PAPER TRADE TICK] ${new Date().toISOString()} ---`);
    console.log(`💼 Simulated Equity: $${paperPortfolio.walletBalanceUsd.toFixed(2)} USD`);

    // 1. Validate Gas Floor & Streak Guardrails
    const riskCheck = validateMicroExecution(paperPortfolio.walletBalanceUsd);
    if (!riskCheck.allowed) {
      console.warn(`⚠️ [RISK BLOCKED]: ${riskCheck.reason}`);
      return;
    }

    // 2. Fetch Live Market Candle Datasets
    const candles1m = await fetchCandles('1m');
    const candles15m = await fetchCandles('15m');
    const currentPrice = candles1m[candles1m.length - 1].close;

    // ---------------------------------------------------------
    // SCENARIO A: SIMULATE OPEN POSITION MANAGEMENT
    // ---------------------------------------------------------
    if (paperPortfolio.activePosition) {
      const pos = paperPortfolio.activePosition;

      // Fee-Lock Trailing Stop Check (+1.2% profit lock)
      const feeLockCheck = evaluateFeeLockExit(pos, currentPrice);
      if (feeLockCheck.triggerExit) {
        closePaperPosition(currentPrice, 'FEE_LOCK_PROTECTION');
        return;
      }

      // Exit Evaluation (Dynamic ATR / Hard SL / TP)
      const exitEvaluation = evaluateExitConditions(pos, candles1m);
      if (exitEvaluation.shouldExit) {
        closePaperPosition(currentPrice, exitEvaluation.exitType);
      }
      return;
    }

    // ---------------------------------------------------------
    // SCENARIO B: EVALUATE ADX VOLATILITY & GATING
    // ---------------------------------------------------------
    const adxVal = calculateADX(candles1m, 14);
    const sizing = getAdaptivePositionSize(paperPortfolio.walletBalanceUsd, adxVal);

    if (sizing.mode === 'CHOP_STANDBY') {
      console.log(`⏸️ [ADX CHOP GUARD]: ADX = ${adxVal.toFixed(1)} <= 20. Holding 100% Cash.`);
      return;
    }

    // Layer 1: HTF 15m Trend Gate Check
    const htfResult = validateHTFTrendGate(candles15m, currentPrice);
    if (!htfResult.passed) {
      console.log(`🛑 [LAYER 1 REJECT]: ${htfResult.reason}`);
      return;
    }

    // Layer 2: Micro Volume & Delta Expansion Gate Check
    const microResult = validateVolumeDeltaGate(candles1m, 2.0, 0.70);
    if (!microResult.passed) {
      console.log(`🛑 [LAYER 2 REJECT]: ${microResult.reason}`);
      return;
    }

    // ---------------------------------------------------------
    // SCENARIO C: SIMULATE PAPER ENTRY
    // ---------------------------------------------------------
    const priorityFee = await getDynamicPriorityFee(connection, [new PublicKey(TOKENS.SOL)]);
    
    console.log(`🚀 [SIMULATED ENTRY MATCHED]`);
    console.log(`   • Entry Price: $${currentPrice.toFixed(4)}`);
    console.log(`   • ADX Mode: \({sizing.mode} (\)${sizing.sizeUsd.toFixed(2)} Allocation)`);
    console.log(`   • Calculated Priority Tip: ${priorityFee} micro-lamports`);

    paperPortfolio.activePosition = {
      entryPrice: currentPrice,
      entryTime: Date.now(),
      sizeUsd: sizing.sizeUsd,
      tokenAmount: sizing.sizeUsd / currentPrice,
      stopPrice: currentPrice * 0.988,
      feeLockActivated: false
    };

  } catch (err) {
    console.error("❌ Paper Execution Error:", err.message);
  }
}

function closePaperPosition(exitPrice, reason) {
  const pos = paperPortfolio.activePosition;
  const pnlUsd = (exitPrice - pos.entryPrice) * pos.tokenAmount;
  const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

  paperPortfolio.walletBalanceUsd += pnlUsd;
  paperPortfolio.paperTradeHistory.push({
    entryPrice: pos.entryPrice,
    exitPrice,
    pnlUsd,
    pnlPct,
    reason,
    timestamp: new Date().toISOString()
  });

  console.log(`✅ [SIMULATED EXIT EXECUTED] Reason: ${reason}`);
  console.log(`   • PnL: ${pnlUsd >= 0 ? '+' : ''}$\({pnlUsd.toFixed(4)} (\){pnlPct.toFixed(2)}%)`);
  console.log(`   • New Balance: $${paperPortfolio.walletBalanceUsd.toFixed(2)} USD`);

  paperPortfolio.activePosition = null;
}

// Start 24-Hour Paper Simulation (Polls every 60s)
setInterval(processPaperTick, 60 * 1000);
