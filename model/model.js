/*
 * BTC Retirement Model — calculation engine.
 * Pure functions, no DOM. Works as a plain <script> in the browser (window.BTCModel)
 * and as a CommonJS module in Node for tests. Section numbers refer to SPEC.md;
 * PROJECT.md "Version 0.2" lists where the app deliberately differs from it.
 * All money is in US dollars.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BTCModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // §2.1–2.3 constants
  const GRID_START_YEAR = 2027;
  const STUB_YEARS = 0.3;
  const TIER_LENGTH = 4; // hardcoded, not exposed
  const CAGR_LADDER = [0.25, 0.20, 0.16, 0.13, 0.11, 0.09, 0.07];
  const DEV = [0.20814, 0.52647, 0.32593, -1.06054]; // recovery, run-up, peak, bear
  const PHASE_NAMES = ['recovery', 'run-up', 'peak', 'bear'];
  const TOP_DEV = DEV[0] + DEV[1] + DEV[2]; // 1.06054: trend→top log distance per unit amplitude
  const PTT_TARGET = 1.45;
  const PTT_RANGE = [1.15, 2.5];
  const FALLBACK_SPOT_USD = 80000;

  // App defaults. top_year 2030 = the top is on 1 Jan 2030, i.e. end of 2029.
  const DEFAULTS = Object.freeze({
    current_age: 47,
    retirement_age: 50,
    end_age: 90,
    lifestyle_usd: 100000,
    compound_until_year: 2033,
    bot_ratio: 0.6,
    bot_return: 0.2,
    withdrawal_mode: 'DCA',
    spot_usd: FALLBACK_SPOT_USD,
    inflation: 0.04,
    top_usd: 250000,
    top_year: 2030,
    ladder_start_index: 'auto',
    cash_yield: 0,
    cycle_enabled: true,
    lifestyles: [50000, 75000, 100000],
  });

  const mod = (a, n) => ((a % n) + n) % n;

  // Fills defaults and resolves an automatic ladder start to a number.
  function withDefaults(p) {
    const q = Object.assign({}, DEFAULTS, p || {});
    if (q.ladder_start_index === 'auto') q.ladder_start_index = suggestLadderIndex(q);
    return q;
  }

  // §3 derived values
  function derive(p) {
    const tRetire = p.retirement_age - p.current_age;
    const nWithdrawals = p.end_age - p.retirement_age;
    return {
      retirementYear: GRID_START_YEAR + tRetire,
      tRetire,
      tPeakEnd: p.top_year - GRID_START_YEAR,
      nWithdrawals,
      tLast: tRetire + nWithdrawals - 1,
      compoundStopIndex: p.compound_until_year - GRID_START_YEAR + 1,
    };
  }

  // §2.2
  function schedule(p) {
    return CAGR_LADDER.slice(p.ladder_start_index);
  }
  function rate(sched, t) {
    return sched[Math.min(Math.floor(t / TIER_LENGTH), sched.length - 1)];
  }

  // §2.3 — phase_offset is derived from top_year so year t_peak_end−1 is the peak year.
  function phaseOffset(tPeakEnd) {
    return mod(tPeakEnd - 1 - 2, 4);
  }

  /*
   * Solves the amplitude a1 from the top anchor. The spec's closed form divides by
   * 1.06054 and subtracts t_peak_end·ln(1+schedule[0]); that is exact when the top is
   * 3 years out (the default). This uses the general sum, which reduces to it.
   * Expects a numeric ladder_start_index.
   */
  function solveCycle(p) {
    const sched = schedule(p);
    const s0 = sched[0];
    const { tPeakEnd } = derive(p);
    const offset = phaseOffset(tPeakEnd);
    if (!p.cycle_enabled) {
      return { sched, a1: 0, peakToTrend: 1, offset, valid: true };
    }
    let trendLog = 0;
    let devSum = 0;
    for (let t = 0; t < tPeakEnd; t++) {
      const r = rate(sched, t);
      trendLog += Math.log(1 + r);
      devSum += (r / s0) * DEV[mod(t - offset, 4)];
    }
    if (tPeakEnd < 1 || Math.abs(devSum) < 1e-9) {
      return { sched, a1: 0, peakToTrend: NaN, offset, valid: false };
    }
    const a1 = (Math.log(p.top_usd / p.spot_usd) - trendLog) / devSum;
    return { sched, a1, peakToTrend: Math.exp(a1 * TOP_DEV), offset, valid: true };
  }

  function phaseIndex(cycle, t) {
    return mod(t - cycle.offset, 4);
  }

  // g(t): yearly growth factor
  function growth(p, cycle, t) {
    const r = rate(cycle.sched, t);
    if (!p.cycle_enabled) return 1 + r;
    const a = cycle.a1 * (r / cycle.sched[0]);
    return Math.exp(Math.log(1 + r) + a * DEV[phaseIndex(cycle, t)]);
  }

  /*
   * §2.4 — P[0..T+1], plus the smooth trend. DEV is zero-sum from a cycle low, so the
   * trend runs through cycle lows and tops sit peak_to_trend× above it. Unless the top
   * is on 1 Jan 2030, today is already part-way up the cycle, so the trend starts below spot.
   */
  function pricePath(p, cycle, T) {
    const P = [p.spot_usd];
    let built = 0; // deviation accumulated since the last cycle low, per unit amplitude
    for (let k = 0; k < phaseIndex(cycle, 0); k++) built += DEV[k];
    const trend = [p.spot_usd * Math.exp(-cycle.a1 * built)];
    const g = [];
    for (let t = 0; t <= T; t++) {
      g.push(growth(p, cycle, t));
      P.push(P[t] * g[t]);
      trend.push(trend[t] * (1 + rate(cycle.sched, t)));
    }
    return { P, trend, g };
  }

  // §2.5
  function btcSold(p, path, t, mode) {
    const E = p.lifestyle_usd * Math.pow(1 + p.inflation, t);
    if (mode === 'LS') {
      const c = p.cash_yield || 0;
      let pv = 0;
      for (let m = 0; m < 12; m++) pv += (E / 12) * Math.pow(1 + c, -m / 12);
      return pv / path.P[t];
    }
    let btc = 0;
    for (let m = 0; m < 12; m++) btc += E / 12 / (path.P[t] * Math.pow(path.g[t], m / 12));
    return btc;
  }

  // Everything that does not depend on B0, computed once per parameter set.
  function prepare(params) {
    const p = withDefaults(params);
    const d = derive(p);
    const cycle = solveCycle(p);
    const T = Math.max(d.tLast, 0) + 1;
    const path = pricePath(p, cycle, T);
    const sold = { LS: [], DCA: [] };
    for (let t = 0; t <= Math.max(d.tLast, 0); t++) {
      sold.LS.push(t >= d.tRetire ? btcSold(p, path, t, 'LS') : 0);
      sold.DCA.push(t >= d.tRetire ? btcSold(p, path, t, 'DCA') : 0);
    }
    return { p, d, cycle, path, sold };
  }

  // §2.6–2.7. `bot` is deliberately allowed to go negative; the solver relies on it.
  function run(ctx, B0, trace) {
    const { p, d, sold } = ctx;
    const need = sold[p.withdrawal_mode];
    let hodl = (1 - p.bot_ratio) * B0;
    let bot = p.bot_ratio * B0 * Math.pow(1 + p.bot_return, STUB_YEARS);
    const rows = [];
    for (let t = 0; t <= d.tLast; t++) {
      const startHodl = hodl;
      const startBot = bot;
      let take = 0;
      if (t >= d.tRetire) {
        take = Math.min(hodl, need[t]);
        hodl -= take;
        bot -= need[t] - take;
      }
      if (t < d.compoundStopIndex) bot *= 1 + p.bot_return;
      if (trace) {
        rows.push({ t, year: GRID_START_YEAR + t, age: p.current_age + t, startHodl, startBot,
          sold: t >= d.tRetire ? need[t] : 0, fromHodl: take, endHodl: hodl, endBot: bot });
      }
    }
    return trace ? { balance: hodl + bot, rows } : hodl + bot;
  }

  function endingBalance(params, B0) {
    return run(prepare(params), B0, false);
  }

  function solveCtx(ctx) {
    let lo = 0.001;
    let hi = 100;
    while (run(ctx, hi, false) < 0 && hi < 1e9) hi *= 2; // widen instead of capping at 100
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (run(ctx, mid, false) < 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function solve(params) {
    return solveCtx(prepare(params));
  }

  // §7.2 — geometric return of each full tier equals its CAGR.
  function tierInvariantErrors(params, tiers) {
    const p = withDefaults(params);
    const cycle = solveCycle(p);
    const out = [];
    for (let k = 0; k < tiers; k++) {
      let prod = 1;
      for (let t = k * TIER_LENGTH; t < (k + 1) * TIER_LENGTH; t++) prod *= growth(p, cycle, t);
      out.push(Math.pow(prod, 1 / TIER_LENGTH) - 1 - rate(cycle.sched, k * TIER_LENGTH));
    }
    return out;
  }

  // §3 trap: the ladder start whose peak/trend is closest to 1.45 for this top and spot.
  function suggestLadderIndex(params) {
    const p = Object.assign({}, DEFAULTS, params || {});
    let best = 0;
    let bestErr = Infinity;
    for (let i = 0; i < CAGR_LADDER.length; i++) {
      const c = solveCycle(Object.assign({}, p, { ladder_start_index: i }));
      if (!c.valid) continue;
      const err = Math.abs(c.peakToTrend - PTT_TARGET);
      if (err < bestErr) { bestErr = err; best = i; }
    }
    return best;
  }

  function range(values) {
    return { min: Math.min(...values), max: Math.max(...values) };
  }

  // §4 outputs and warnings, §6.2 sensitivity, §6.3 lever ranking — as shown in v0.2.
  function results(params) {
    const p = withDefaults(params);
    const ctx = prepare(p);
    const { d, cycle } = ctx;
    const B0 = solveCtx(ctx);
    const sim = run(ctx, B0, true);

    const atRetire = sim.rows[d.tRetire];
    const btcAtRetirement = atRetire ? atRetire.startHodl + atRetire.startBot : B0;
    const exhausted = sim.rows.find((r) => r.t >= d.tRetire && r.endHodl <= 1e-12);

    // Scenario A: bots stop when you retire (last growth year is the year before).
    const scenarioA = Object.assign({}, p, { compound_until_year: d.retirementYear - 1 });
    const btcA = solve(scenarioA);
    const lifestyleList = p.lifestyles.slice();
    if (!lifestyleList.includes(p.lifestyle_usd)) lifestyleList.push(p.lifestyle_usd);
    lifestyleList.sort((a, b) => a - b);
    const lifestyleRows = lifestyleList.map((L) => ({
      lifestyle: L,
      isCurrent: L === p.lifestyle_usd,
      A: L === p.lifestyle_usd ? btcA : solve(Object.assign({}, scenarioA, { lifestyle_usd: L })),
      B: L === p.lifestyle_usd ? B0 : solve(Object.assign({}, p, { lifestyle_usd: L })),
    }));

    // Sensitivity: 2029 top with the ladder re-chosen automatically; bot return.
    const topRows = [150000, 200000, 250000, 300000, 400000].map((top) => ({
      top, btc: solve(Object.assign({}, p, { top_usd: top, ladder_start_index: 'auto' })),
    }));
    const botRows = [0, 0.1, 0.15, 0.2, 0.25].map((br) => ({
      botReturn: br, btc: solve(Object.assign({}, p, { bot_return: br })),
    }));

    const levers = [
      { name: '2029 top prediction ($150K–$400K)', ...range(topRows.map((r) => r.btc)) },
      { name: 'Bot return (0–25%)', ...range(botRows.map((r) => r.btc)) },
      { name: `Bots stop: when you retire vs end of ${p.compound_until_year}`, ...range([btcA, B0]) },
    ].map((l) => Object.assign(l, { spread: l.max - l.min }))
      .sort((a, b) => b.spread - a.spread);

    const pttOutOfRange = p.cycle_enabled && cycle.valid &&
      (cycle.peakToTrend < PTT_RANGE[0] || cycle.peakToTrend > PTT_RANGE[1]);

    return {
      params: p,
      derived: d,
      cycle: { a1: cycle.a1, peakToTrend: cycle.peakToTrend, valid: cycle.valid, schedule: cycle.sched,
        ladderStart: p.ladder_start_index, trendAtTop: ctx.path.trend[d.tPeakEnd] },
      btcNeeded: B0,
      usdValue: B0 * p.spot_usd,
      botPortfolio: p.bot_ratio * B0,
      hodlPortfolio: (1 - p.bot_ratio) * B0,
      btcAtRetirement,
      scenarios: { A: btcA, B: B0, AYear: scenarioA.compound_until_year, BYear: p.compound_until_year },
      lifestyleRows,
      sensitivity: { tops: topRows, botReturns: botRows,
        // Always includes the headline, even when inputs sit outside the swept values.
        band: range([...topRows, ...botRows].map((r) => r.btc).concat([B0])) },
      levers,
      warnings: {
        // With the ladder chosen automatically this only fires when no ladder start fits.
        peakToTrend: pttOutOfRange ? { value: cycle.peakToTrend,
          worstYear: Math.min(...ctx.path.g.slice(0, 8)) - 1 } : null,
        hodlExhaustedYear: exhausted ? exhausted.year : null,
      },
      series: {
        rows: sim.rows,
        years: sim.rows.map((r) => r.year),
        sold: ctx.sold[p.withdrawal_mode],
      },
    };
  }

  // Input checks the UI shows before running the model.
  function validate(params) {
    const p = Object.assign({}, DEFAULTS, params || {});
    const errors = [];
    const between = (k, lo, hi) => {
      if (!(Number.isFinite(p[k]) && p[k] >= lo && p[k] <= hi)) errors.push(`${k} must be between ${lo} and ${hi}.`);
    };
    between('current_age', 18, 80);
    between('end_age', 60, 105);
    between('lifestyle_usd', 10000, 500000);
    between('bot_ratio', 0, 1);
    between('bot_return', 0, 0.5);
    between('inflation', 0, 0.1);
    between('top_usd', 50000, 2000000);
    between('top_year', 2028, 2030);
    between('cash_yield', 0, 0.06);
    if (p.ladder_start_index !== 'auto') between('ladder_start_index', 0, 6);
    ['current_age', 'retirement_age', 'end_age', 'compound_until_year', 'top_year', 'ladder_start_index']
      .forEach((k) => { if (Number.isFinite(p[k]) && !Number.isInteger(p[k])) errors.push(`${k} must be a whole number.`); });
    if (!(p.spot_usd > 0)) errors.push('spot_usd must be above 0.');
    if (!(p.retirement_age >= p.current_age)) errors.push('Retirement age must be at least your current age.');
    if (!(p.end_age > p.retirement_age)) errors.push('End age must be after retirement age.');
    const retirementYear = GRID_START_YEAR + (p.retirement_age - p.current_age);
    if (!Number.isFinite(p.compound_until_year)) errors.push('Bots-stop year must be a year.');
    else if (Number.isFinite(retirementYear) && p.compound_until_year < retirementYear) {
      errors.push(`Bots-stop year must be ${retirementYear} (your retirement year) or later. The table already shows bots stopping when you retire.`);
    }
    return errors;
  }

  return {
    GRID_START_YEAR, STUB_YEARS, TIER_LENGTH, CAGR_LADDER, DEV, PHASE_NAMES, PTT_TARGET, PTT_RANGE,
    FALLBACK_SPOT_USD, DEFAULTS, derive, schedule, rate, solveCycle, growth, prepare, run,
    endingBalance, solve, tierInvariantErrors, suggestLadderIndex, phaseIndex, results, validate,
  };
});
