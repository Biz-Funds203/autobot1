// engine_upgrades.js - Dynamic Priority Fees, ADX Sizing, & Fee-Lock Exit Guard
const axios = require('axios');

/**
 * 1. DYNAMIC PRIORITY TIP CALCULATOR
 * Fetches 75th percentile priority fee for the target market to optimize gas costs.
 */
async function getDynamicPriorityFee(connection, accountKeys = []) {
  try {
    // Query recent prioritization fees for target account keys
    const fees = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: accountKeys });
    if (!fees || fees.length === 0) return 10000; // Fallback: 10,000 micro-lamports (~$0.002)

    // Extract non-zero fees and take the 75th percentile
    const sortedFees = fees.map(f => f.prioritizationFee).filter(f => f > 0).sort((a, b) => a - b);
    if (sortedFees.length === 0) return 10000;

    const index75 = Math.floor(sortedFees.length * 0.75);
    const targetFee = sortedFees[index75];

    // Cap maximum priority tip to preserve capital (Max ~0.0002 SOL)
    return Math.min(targetFee, 200000);
  } catch (err) {
    console.warn("⚠️ Priority fee query failed, using baseline: 10,000 micro-lamports");
    return 10000;
  }
}

/**
 * 2. ADX INDICATOR CALCULATOR
 * Calculates 1-minute Average Directional Index over a 14-period window.
 */
function calculateADX(candles1m, period = 14) {
  if (candles1m.length < period * 2) return 20; // Default baseline if historical candles are limited

  let trs = [], pDMs = [], nDMs = [];

  for (let i = 1; i < candles1m.length; i++) {
    const high = candles1m[i].high;
    const low = candles1m[i].low;
    const prevHigh = candles1m[i - 1].high;
    const prevLow = candles1m[i - 1].low;
    const prevClose = candles1m[i - 1].close;

    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    const pDM = (upMove > downMove && upMove > 0) ? upMove : 0;
    const nDM = (downMove > upMove && downMove > 0) ? downMove : 0;

    trs.push(tr);
    pDMs.push(pDM);
    nDMs.push(nDM);
  }

  // Calculate smoothed TR, +DM, -DM
  let smoothedTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedpDM = pDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothednDM = nDMs.slice(0, period).reduce((a, b) => a + b, 0);

  let dxArray = [];

  for (let i = period; i < trs.length; i++) {
    smoothedTR = smoothedTR - (smoothedTR / period) + trs[i];
    smoothedpDM = smoothedpDM - (smoothedpDM / period) + pDMs[i];
    smoothednDM = smoothednDM - (smoothednDM / period) + nDMs[i];

    const pDI = (smoothedpDM / smoothedTR) * 100;
    const nDI = (smoothednDM / smoothedTR) * 100;
    const diDiff = Math.abs(pDI - nDI);
    const diSum = pDI + nDI;

    const dx = diSum > 0 ? (diDiff / diSum) * 100 : 0;
    dxArray.push(dx);
  }

  // Final ADX smooth
  const adx = dxArray.slice(-period).reduce((a, b) => a + b, 0) / period;
  return adx;
}

/**
 * 3. VOLATILITY-ADAPTIVE POSITION SIZING
 * Adjusts position allocation percentage based on ADX trend strength.
 */
function getAdaptivePositionSize(walletBalanceUsd, adxValue) {
  if (adxValue <= 20) {
    // Chop Regime: Halt trading / return 0 allocation
    return { sizeUsd: 0, mode: 'CHOP_STANDBY' };
  } else if (adxValue >= 35) {
    // Strong Expansion Regime: Scale allocation to 15% of equity
    const sizeUsd = walletBalanceUsd * 0.15;
    return { sizeUsd, mode: 'EXPANSION_15_PCT' };
  } else {
    // Standard Trend Regime (20 < ADX < 35): Standard 10% allocation
    const sizeUsd = walletBalanceUsd * 0.10;
    return { sizeUsd, mode: 'STANDARD_10_PCT' };
  }
}

/**
 * 4. FEE-LOCK TRAILING EXIT GUARD
 * Evaluates fee-lock threshold (+1.2% net) to move stop to breakeven (+0.20%).
 */
function evaluateFeeLockExit(position, currentPrice) {
  const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;

  // Check if position touched +1.2% net profit threshold
  if (pnlPct >= 0.012 && !position.feeLockActivated) {
    position.feeLockActivated = true;
    position.stopPrice = position.entryPrice * 1.002; // Lock +0.20% gain (covers gas)
    console.log(`🔒 [FEE-LOCK ACTIVATED]: Stop Loss moved to Breakeven+ ($${position.stopPrice.toFixed(4)})`);
  }

  // Trailing stop trigger if fee lock is active and price drops to locked stop
  if (position.feeLockActivated && currentPrice <= position.stopPrice) {
    return { triggerExit: true, exitType: 'FEE_LOCK_PROTECTION', percentageToClose: 1.0 };
  }

  return { triggerExit: false };
}

module.exports = {
  getDynamicPriorityFee,
  calculateADX,
  getAdaptivePositionSize,
  evaluateFeeLockExit
};