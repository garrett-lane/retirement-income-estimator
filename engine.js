/*
 * Retirement projection engine.
 *
 * Pure functions only - no DOM. Works in the browser (window.RetirementEngine)
 * and in Node (module.exports) so it can be tested from the command line.
 *
 * The simulation steps one calendar month at a time from the start month to the
 * month the plan ends. All money inside the engine is NOMINAL (future dollars);
 * callers divide by `inflationFactor` to show today's dollars.
 */
(function (root) {
  'use strict';

  const ACCOUNT_TYPES = ['taxable', 'deferred', 'roth'];

  const WITHDRAWAL_ORDERS = {
    'taxable-deferred-roth': ['taxable', 'deferred', 'roth'],
    'deferred-taxable-roth': ['deferred', 'taxable', 'roth'],
    'taxable-roth-deferred': ['taxable', 'roth', 'deferred'],
    proportional: null,
  };

  function monthlyRate(annual) {
    return Math.pow(1 + annual, 1 / 12) - 1;
  }

  /** "2027-03" -> absolute month number (year*12 + monthIndex). */
  function parseMonth(str) {
    if (!str || typeof str !== 'string') return null;
    const m = /^(\d{4})-(\d{1,2})$/.exec(str.trim());
    if (!m) return null;
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return Number(m[1]) * 12 + (month - 1);
  }

  function formatMonth(abs) {
    const y = Math.floor(abs / 12);
    const mo = (abs % 12) + 1;
    return `${y}-${String(mo).padStart(2, '0')}`;
  }

  /** Does a contribution-change rule fire in this absolute month? */
  function ruleFires(rule, absMonth) {
    const start = parseMonth(rule.month);
    if (start === null || absMonth < start) return false;
    if (rule.repeat === 'yearly') {
      if ((absMonth - start) % 12 !== 0) return false;
      if (rule.untilYear && Math.floor(absMonth / 12) > Number(rule.untilYear)) return false;
      return true;
    }
    return absMonth === start;
  }

  /** Annual spending (today's $) in effect at a given age, honoring expense changes. */
  function expenseAtAge(inputs, age) {
    let amount = Number(inputs.expenses) || 0;
    let bestAge = -Infinity;
    for (const c of inputs.expenseChanges || []) {
      const a = Number(c.age);
      if (Number.isFinite(a) && age >= a && a >= bestAge) {
        bestAge = a;
        amount = Number(c.amount) || 0;
      }
    }
    return amount;
  }

  /**
   * Withdraw `needNet` after-tax dollars from the balances, in place.
   * Tax-deferred withdrawals are grossed up so that `needNet` arrives after tax.
   * Returns { net: {type: $}, gross: {type: $}, tax, shortfall }.
   */
  function withdraw(balances, needNet, order, postTax) {
    const net = { taxable: 0, deferred: 0, roth: 0 };
    const gross = { taxable: 0, deferred: 0, roth: 0 };
    let tax = 0;
    const keep = (type) => (type === 'deferred' ? 1 - postTax : 1);

    const take = (type, wantNet) => {
      const k = keep(type);
      if (wantNet <= 0 || balances[type] <= 0 || k <= 0) return 0;
      const capacityNet = balances[type] * k;
      const gotNet = Math.min(wantNet, capacityNet);
      const g = gotNet / k;
      balances[type] -= g;
      if (balances[type] < 1e-9) balances[type] = 0;
      net[type] += gotNet;
      gross[type] += g;
      tax += g - gotNet;
      return gotNet;
    };

    let remaining = needNet;
    const sequence = WITHDRAWAL_ORDERS[order];
    if (sequence) {
      for (const type of sequence) remaining -= take(type, remaining);
    } else {
      // Proportional to each account's after-tax value, then mop up any remainder.
      const caps = ACCOUNT_TYPES.map((t) => Math.max(0, balances[t]) * keep(t));
      const total = caps.reduce((a, b) => a + b, 0);
      if (total > 0) {
        const shares = ACCOUNT_TYPES.map((t, i) => (remaining * caps[i]) / total);
        ACCOUNT_TYPES.forEach((t, i) => { remaining -= take(t, shares[i]); });
      }
      for (const type of ACCOUNT_TYPES) remaining -= take(type, remaining);
    }
    return { net, gross, tax, shortfall: Math.max(0, remaining) };
  }

  /**
   * Run the full projection.
   * @param {object} inputs - see defaultInputs() in app.js for the shape.
   * @param {object} [opts] - { expenseScale } multiplies every spending figure (used by the solver).
   */
  function simulate(inputs, opts = {}) {
    const expenseScale = opts.expenseScale ?? 1;
    const currentAge = Number(inputs.currentAge);
    const retireAge = Number(inputs.retirementAge);
    const planAge = Number(inputs.planToAge);
    const inflation = Number(inputs.inflation);
    const preTax = Number(inputs.preTaxRate);
    const postTax = Number(inputs.postTaxRate);
    const taxTaxableGrowth = inputs.taxTaxableGrowth !== false;
    const order = inputs.withdrawalOrder in WITHDRAWAL_ORDERS ? inputs.withdrawalOrder : 'taxable-deferred-roth';

    const startAbs = parseMonth(inputs.startMonth) ?? (() => {
      const d = new Date();
      return d.getFullYear() * 12 + d.getMonth();
    })();
    const totalMonths = Math.max(1, Math.round((planAge - currentAge) * 12));
    const retireIdx = Math.max(0, Math.round((retireAge - currentAge) * 12));

    const rPre = monthlyRate(Number(inputs.preReturn));
    const rPost = monthlyRate(Number(inputs.postReturn));
    const infM = monthlyRate(inflation);

    // Each account keeps its own balance & contribution so per-account rules work;
    // results are reported by account type.
    const accounts = (inputs.accounts || []).map((a) => ({
      id: a.id,
      type: ACCOUNT_TYPES.includes(a.type) ? a.type : 'taxable',
      balance: Math.max(0, Number(a.balance) || 0),
      monthly: Math.max(0, Number(a.monthly) || 0),
    }));
    const byId = new Map(accounts.map((a) => [a.id, a]));

    const sumByType = () => {
      const s = { taxable: 0, deferred: 0, roth: 0 };
      for (const a of accounts) s[a.type] += a.balance;
      return s;
    };

    // In retirement we pool by type (withdrawal order is by type, not by account).
    let pooled = null;

    const years = [];
    let year = null;
    let depletedAtAge = null;
    let firstShortfallAge = null;
    let balanceAtRetirement = null;
    let totalShortfall = 0;

    const newYear = (i, age, absMonth) => ({
      index: years.length,
      age: Math.floor(age + 1e-9),
      startMonth: formatMonth(absMonth),
      calendarYear: Math.floor(absMonth / 12),
      retired: i >= retireIdx,
      contributions: 0,
      growth: 0,
      growthTax: 0,
      incomeGross: 0,
      incomeNet: 0,
      incomeTax: 0,
      expenses: 0,
      withdrawNet: { taxable: 0, deferred: 0, roth: 0 },
      withdrawGross: { taxable: 0, deferred: 0, roth: 0 },
      withdrawTax: 0,
      surplusReinvested: 0,
      oneTime: 0,
      shortfall: 0,
      end: null,
      inflationFactor: 1,
    });

    for (let i = 0; i < totalMonths; i++) {
      const absMonth = startAbs + i;
      const age = currentAge + i / 12;
      const retired = i >= retireIdx;
      const inflationFactor = Math.pow(1 + infM, i);

      if (i % 12 === 0) {
        if (year) years.push(year);
        year = newYear(i, age, absMonth);
      }
      // A year that straddles retirement is labelled retired if any month is retired.
      if (retired) year.retired = true;

      if (i === retireIdx) {
        balanceAtRetirement = { ...sumByType(), inflationFactor };
        pooled = sumByType();
      }

      // --- 1. Investment growth (and tax drag on taxable growth) -------------
      const r = retired ? rPost : rPre;
      const growthTaxRate = taxTaxableGrowth ? (retired ? postTax : preTax) : 0;
      const grow = (type, bal) => {
        const g = bal * r;
        const t = type === 'taxable' && g > 0 ? g * growthTaxRate : 0;
        year.growth += g - t;
        year.growthTax += t;
        return bal + g - t;
      };
      if (pooled) {
        for (const t of ACCOUNT_TYPES) pooled[t] = grow(t, pooled[t]);
      } else {
        for (const a of accounts) a.balance = grow(a.type, a.balance);
      }

      // --- 2. One-time deposits / withdrawals --------------------------------
      for (const ev of inputs.oneTimeEvents || []) {
        if (parseMonth(ev.month) !== absMonth) continue;
        const amt = Number(ev.amount) || 0;
        const acct = byId.get(ev.accountId);
        const type = acct ? acct.type : 'taxable';
        if (pooled) {
          pooled[type] = Math.max(0, pooled[type] + amt);
        } else if (acct) {
          acct.balance = Math.max(0, acct.balance + amt);
        } else {
          continue;
        }
        year.oneTime += amt;
      }

      if (!retired) {
        // --- 3a. Contribution rule changes, then contributions ---------------
        for (const rule of inputs.contributionChanges || []) {
          const acct = byId.get(rule.accountId);
          if (!acct || !ruleFires(rule, absMonth)) continue;
          const amt = Number(rule.amount) || 0;
          acct.monthly = Math.max(0, rule.kind === 'set' ? amt : acct.monthly + amt);
        }
        for (const a of accounts) {
          a.balance += a.monthly;
          year.contributions += a.monthly;
        }
      } else {
        // --- 3b. Retirement cash flow -----------------------------------------
        let incomeGross = 0;
        let incomeNet = 0;
        for (const inc of inputs.incomes || []) {
          const s = Number(inc.startAge);
          const e = inc.endAge === '' || inc.endAge == null ? Infinity : Number(inc.endAge);
          if (!(age >= s && age < e)) continue;
          const base = (Number(inc.amount) || 0) / 12;
          const nominal = inc.cola === false ? base : base * inflationFactor;
          const tax = inc.taxable === false ? 0 : nominal * postTax;
          incomeGross += nominal;
          incomeNet += nominal - tax;
        }
        const expense = (expenseAtAge(inputs, age) * expenseScale * inflationFactor) / 12;

        year.incomeGross += incomeGross;
        year.incomeNet += incomeNet;
        year.incomeTax += incomeGross - incomeNet;
        year.expenses += expense;

        const gap = expense - incomeNet;
        if (gap > 0) {
          const w = withdraw(pooled, gap, order, postTax);
          for (const t of ACCOUNT_TYPES) {
            year.withdrawNet[t] += w.net[t];
            year.withdrawGross[t] += w.gross[t];
          }
          year.withdrawTax += w.tax;
          if (w.shortfall > 0.005) {
            year.shortfall += w.shortfall;
            totalShortfall += w.shortfall;
            if (firstShortfallAge === null) firstShortfallAge = age;
          }
        } else if (gap < 0) {
          // Income beyond spending is reinvested in the taxable account.
          pooled.taxable += -gap;
          year.surplusReinvested += -gap;
        }
      }

      const bal = pooled ? { ...pooled } : sumByType();
      const total = bal.taxable + bal.deferred + bal.roth;
      if (retired && depletedAtAge === null && total <= 0.005) depletedAtAge = age;
      year.end = { ...bal, total };
      year.inflationFactor = Math.pow(1 + infM, i + 1);
    }
    if (year) years.push(year);

    const last = years[years.length - 1];
    return {
      years,
      retireIdx,
      totalMonths,
      startMonth: formatMonth(startAbs),
      balanceAtRetirement,
      depletedAtAge,
      firstShortfallAge,
      totalShortfall,
      endBalance: last ? last.end.total : 0,
      endInflationFactor: last ? last.inflationFactor : 1,
      success: totalShortfall <= 0.01,
    };
  }

  /**
   * Largest uniform scale on every spending figure that still funds the whole plan.
   * Returns the scale (1 = current plan). Capped at 20x.
   */
  function solveSustainableScale(inputs) {
    if (!(Number(inputs.expenses) > 0)) return null;
    let lo = 0;
    let hi = 1;
    while (simulate(inputs, { expenseScale: hi }).success && hi < 20) {
      lo = hi;
      hi *= 2;
    }
    if (hi >= 20 && simulate(inputs, { expenseScale: hi }).success) return hi;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (simulate(inputs, { expenseScale: mid }).success) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  const api = { simulate, solveSustainableScale, parseMonth, formatMonth, expenseAtAge, ACCOUNT_TYPES, WITHDRAWAL_ORDERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RetirementEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
