/* UI layer: state, inputs, persistence, charts, table. Engine lives in engine.js. */
(function () {
  'use strict';

  const E = window.RetirementEngine;
  const STORE_KEY = 'rie.plan.v1';
  const THEME_KEY = 'rie.theme';
  const BASIS_KEY = 'rie.basis';
  const SCENARIO_KEY = 'rie.scenario';

  const TYPE_LABELS = { taxable: 'Taxable', deferred: 'Tax-deferred', roth: 'Roth (tax-free)' };
  const TYPE_VARS = { taxable: '--s-taxable', deferred: '--s-deferred', roth: '--s-roth' };

  // Return scenarios: which state keys hold the before/after-retirement returns.
  const SCENARIOS = {
    high: { label: 'High', pre: 'preReturnHigh', post: 'postReturnHigh' },
    standard: { label: 'Standard', pre: 'preReturn', post: 'postReturn' },
    low: { label: 'Low', pre: 'preReturnLow', post: 'postReturnLow' },
  };
  // Default low/high = standard -/+ this many points (before / after retiring).
  const SPREAD = { pre: 3, post: 2 };

  const uid = () => Math.random().toString(36).slice(2, 10);
  const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function nowMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function defaultState() {
    const start = nowMonth();
    const nextJan = `${Number(start.slice(0, 4)) + 1}-01`;
    const k401 = uid();
    const roth = uid();
    const brokerage = uid();
    return {
      currentAge: 40,
      retirementAge: 62,
      planToAge: 95,
      startMonth: start,
      preReturn: 8,
      postReturn: 5,
      preReturnLow: 5,
      preReturnHigh: 11,
      postReturnLow: 3,
      postReturnHigh: 7,
      preTaxRate: 22,
      postTaxRate: 15,
      inflation: 3,
      taxTaxableGrowth: true,
      withdrawalOrder: 'taxable-deferred-roth',
      expenses: 70000,
      expenseChanges: [],
      accounts: [
        { id: k401, name: '401(k)', type: 'deferred', balance: 150000, monthly: 1500 },
        { id: roth, name: 'Roth IRA', type: 'roth', balance: 40000, monthly: 500 },
        { id: brokerage, name: 'Brokerage', type: 'taxable', balance: 25000, monthly: 300 },
      ],
      contributionChanges: [
        { id: uid(), accountId: k401, month: nextJan, kind: 'increase', amount: 100, repeat: 'yearly', untilYear: '' },
      ],
      oneTimeEvents: [],
      incomes: [
        { id: uid(), name: 'Social Security', amount: 30000, startAge: 67, endAge: '', cola: true, taxable: true },
      ],
    };
  }

  // ------------------------------------------------------------------ storage
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, v) { try { localStorage.setItem(key, v); } catch { /* storage unavailable */ } },
  };

  /** Fill any missing keys from defaults so older or partial files still load. */
  function normalize(obj) {
    const d = defaultState();
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.accounts)) return d;
    const out = { ...d, ...obj };
    for (const k of ['accounts', 'contributionChanges', 'oneTimeEvents', 'incomes', 'expenseChanges']) {
      out[k] = Array.isArray(obj[k]) ? obj[k].map((x) => ({ id: uid(), ...x })) : [];
    }
    // Plans saved before return scenarios existed: derive low/high from their own standard returns.
    for (const [key, base, delta] of [
      ['preReturnLow', 'preReturn', -SPREAD.pre], ['preReturnHigh', 'preReturn', SPREAD.pre],
      ['postReturnLow', 'postReturn', -SPREAD.post], ['postReturnHigh', 'postReturn', SPREAD.post],
    ]) {
      if (!(key in obj)) out[key] = num(out[base]) + delta;
    }
    return out;
  }

  function loadState() {
    const raw = store.get(STORE_KEY);
    if (!raw) return defaultState();
    try { return normalize(JSON.parse(raw)); } catch { return defaultState(); }
  }

  let state = loadState();
  let basis = store.get(BASIS_KEY) === 'nominal' ? 'nominal' : 'real';
  let scenario = SCENARIOS[store.get(SCENARIO_KEY)] ? store.get(SCENARIO_KEY) : 'standard';

  const save = () => store.set(STORE_KEY, JSON.stringify(state));

  function toEngine(s, sc = 'standard') {
    const { pre, post } = SCENARIOS[sc];
    return {
      ...s,
      preReturn: num(s[pre]) / 100,
      postReturn: num(s[post]) / 100,
      preTaxRate: clamp(num(s.preTaxRate), 0, 99) / 100,
      postTaxRate: clamp(num(s.postTaxRate), 0, 99) / 100,
      inflation: num(s.inflation) / 100,
    };
  }

  // --------------------------------------------------------------- formatting
  const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const usdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
  const usdCompact2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
  const fmt = (v) => usd0.format(Math.round(v || 0));
  const fmtBig = (v) => (Math.abs(v) >= 1e6 ? usdCompact2.format(v) : fmt(v));
  const fmtAge = (a) => {
    const y = Math.floor(a + 1e-9);
    const m = Math.round((a - y) * 12);
    return m && m < 12 ? `${y} and ${m} mo` : `${m === 12 ? y + 1 : y}`;
  };

  // ------------------------------------------------------------ scalar inputs
  function bindScalars() {
    document.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const evt = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        if (el.type === 'checkbox') state[key] = el.checked;
        else if (el.type === 'number') state[key] = el.value === '' ? '' : Number(el.value);
        else state[key] = el.value;
        changed();
      });
    });
  }

  function fillScalars() {
    document.querySelectorAll('[data-key]').forEach((el) => {
      const v = state[el.dataset.key];
      if (el.type === 'checkbox') el.checked = v !== false;
      else el.value = v ?? '';
    });
  }

  // --------------------------------------------------------------- list rows
  const accountOptions = () => state.accounts.map((a) => [a.id, a.name || TYPE_LABELS[a.type]]);

  const LISTS = {
    accounts: {
      empty: 'No accounts yet.',
      layout: 'row-2',
      accent: (it) => `var(${TYPE_VARS[it.type] || '--s-taxable'})`,
      fields: [
        { key: 'name', label: 'Name', type: 'text', refresh: ['contributionChanges', 'oneTimeEvents'] },
        { key: 'type', label: 'Tax treatment', type: 'select', options: () => Object.entries(TYPE_LABELS), refresh: ['accounts', 'contributionChanges', 'oneTimeEvents'] },
        { key: 'balance', label: 'Current balance', unit: '$', type: 'number', step: 1000 },
        { key: 'monthly', label: 'Monthly contribution', unit: '$', type: 'number', step: 50 },
      ],
      make: () => ({ name: 'New account', type: 'taxable', balance: 0, monthly: 0 }),
      onRemove: (it) => {
        state.contributionChanges = state.contributionChanges.filter((c) => c.accountId !== it.id);
        state.oneTimeEvents = state.oneTimeEvents.filter((c) => c.accountId !== it.id);
        renderList('contributionChanges');
        renderList('oneTimeEvents');
      },
    },
    contributionChanges: {
      empty: 'No scheduled changes.',
      layout: 'row-2',
      fields: [
        { key: 'accountId', label: 'Account', type: 'select', options: accountOptions, cls: 'span-all' },
        { key: 'kind', label: 'Change', type: 'select', options: () => [['increase', 'Increase by'], ['set', 'Set to']] },
        { key: 'amount', label: 'Amount per month', unit: '$', type: 'number', step: 25 },
        { key: 'month', label: 'Starting', type: 'month' },
        { key: 'repeat', label: 'Repeat', type: 'select', options: () => [['once', 'Once'], ['yearly', 'Every year that month']], refresh: ['contributionChanges'] },
        { key: 'untilYear', label: 'Last year (blank = until retirement)', type: 'number', step: 1, cls: 'span-all', show: (it) => it.repeat === 'yearly' },
      ],
      make: () => ({
        accountId: state.accounts[0]?.id || '',
        kind: 'increase',
        amount: 100,
        month: `${Number(String(state.startMonth || nowMonth()).slice(0, 4)) + 1}-01`,
        repeat: 'yearly',
        untilYear: '',
      }),
    },
    oneTimeEvents: {
      empty: 'None.',
      layout: 'row-2',
      fields: [
        { key: 'note', label: 'Description', type: 'text', cls: 'span-all' },
        { key: 'accountId', label: 'Account', type: 'select', options: accountOptions },
        { key: 'month', label: 'Month', type: 'month' },
        { key: 'amount', label: 'Amount (− to withdraw)', unit: '$', type: 'number', step: 1000, cls: 'span-all' },
      ],
      make: () => ({
        note: 'Bonus',
        accountId: state.accounts[0]?.id || '',
        month: E.formatMonth((E.parseMonth(state.startMonth) ?? E.parseMonth(nowMonth())) + 12),
        amount: 10000,
      }),
    },
    expenseChanges: {
      empty: 'Spending stays the same throughout retirement.',
      layout: 'row-2',
      fields: [
        { key: 'age', label: 'From age', type: 'number', step: 1 },
        { key: 'amount', label: 'Annual spending', unit: "today's $", type: 'number', step: 1000 },
        { key: 'note', label: 'Note', type: 'text', cls: 'span-all' },
      ],
      make: () => ({ age: num(state.retirementAge) + 10, amount: Math.round(num(state.expenses) * 0.85), note: '' }),
    },
    incomes: {
      empty: 'No retirement income.',
      layout: 'row-3',
      fields: [
        { key: 'name', label: 'Source', type: 'text', cls: 'span-all' },
        { key: 'amount', label: 'Per year', unit: "today's $", type: 'number', step: 1000 },
        { key: 'startAge', label: 'From age', type: 'number', step: 1 },
        { key: 'endAge', label: 'Until age', unit: 'blank = life', type: 'number', step: 1 },
        { key: 'cola', label: 'Rises with inflation', type: 'checkbox' },
        { key: 'taxable', label: 'Taxable', type: 'checkbox' },
      ],
      make: () => ({ name: 'Pension', amount: 20000, startAge: num(state.retirementAge), endAge: '', cola: false, taxable: true }),
    },
  };

  function renderList(name) {
    const def = LISTS[name];
    const host = document.getElementById(`list-${name}`);
    host.replaceChildren();
    const items = state[name];
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = def.empty;
      host.append(p);
      return;
    }
    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = `row ${def.layout}`;
      if (def.accent) row.style.borderLeft = `4px solid ${def.accent(item)}`;

      const checks = [];
      for (const f of def.fields) {
        if (f.show && !f.show(item)) continue;
        const label = document.createElement('label');
        let input;
        if (f.type === 'select') {
          input = document.createElement('select');
          for (const [value, text] of f.options()) {
            const o = document.createElement('option');
            o.value = value;
            o.textContent = text;
            input.append(o);
          }
          input.value = item[f.key] ?? '';
        } else {
          input = document.createElement('input');
          input.type = f.type;
          if (f.step) input.step = f.step;
          if (f.type === 'checkbox') input.checked = item[f.key] !== false;
          else input.value = item[f.key] ?? '';
        }

        const evt = f.type === 'select' || f.type === 'checkbox' ? 'change' : 'input';
        input.addEventListener(evt, () => {
          if (f.type === 'checkbox') item[f.key] = input.checked;
          else if (f.type === 'number') item[f.key] = input.value === '' ? '' : Number(input.value);
          else item[f.key] = input.value;
          changed();
        });
        if (f.refresh) {
          // Re-render dependent lists after the edit is committed, so typing keeps focus.
          input.addEventListener('change', () => f.refresh.forEach(renderList));
        }

        if (f.type === 'checkbox') {
          label.className = 'check';
          label.append(input, document.createTextNode(f.label));
          checks.push(label);
          continue;
        }
        const text = document.createElement('span');
        text.textContent = f.label + ' ';
        if (f.unit) {
          const u = document.createElement('span');
          u.className = 'unit';
          u.textContent = f.unit;
          text.append(u);
        }
        label.append(text, input);
        if (f.cls) label.classList.add(f.cls);
        row.append(label);
      }
      if (checks.length) {
        const wrap = document.createElement('div');
        wrap.className = 'checks span-all';
        wrap.append(...checks);
        row.append(wrap);
      }

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-icon';
      del.title = 'Remove';
      del.setAttribute('aria-label', 'Remove');
      del.textContent = '×';
      del.addEventListener('click', () => {
        state[name] = state[name].filter((x) => x !== item);
        def.onRemove?.(item);
        renderList(name);
        changed();
      });
      row.append(del);
      host.append(row);
    });
  }

  function renderAllLists() {
    Object.keys(LISTS).forEach(renderList);
  }

  document.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.add;
      state[name].push({ id: uid(), ...LISTS[name].make() });
      renderList(name);
      if (name === 'accounts') { renderList('contributionChanges'); renderList('oneTimeEvents'); }
      changed();
    });
  });

  // ----------------------------------------------------------------- compute
  let pending = false;
  function changed() {
    save();
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      update();
    });
  }

  function validate() {
    const msgs = [];
    const c = num(state.currentAge), r = num(state.retirementAge), p = num(state.planToAge);
    if (r < c) msgs.push('Retirement age is before your current age, so the projection treats you as already retired.');
    if (p <= r) msgs.push('"Plan to age" must be later than your retirement age to project retirement years.');
    if (p <= c) msgs.push('"Plan to age" must be later than your current age.');
    const w = document.getElementById('age-warning');
    w.hidden = !msgs.length;
    w.textContent = msgs.join(' ');

    const ordered = ['pre', 'post'].every((p) =>
      num(state[SCENARIOS.low[p]]) <= num(state[SCENARIOS.standard[p]])
      && num(state[SCENARIOS.standard[p]]) <= num(state[SCENARIOS.high[p]]));
    const rw = document.getElementById('return-warning');
    rw.hidden = ordered;
    rw.textContent = ordered ? '' : 'Low returns should be at or below standard, and high at or above it.';
  }

  function update() {
    validate();
    const runs = {};
    for (const sc of Object.keys(SCENARIOS)) {
      const inputs = toEngine(state, sc);
      runs[sc] = { result: E.simulate(inputs), scale: E.solveSustainableScale(inputs) };
    }
    const { result, scale } = runs[scenario];
    renderStatus(result, scale, runs);
    renderTiles(result, scale);
    renderScenarioTable(runs);
    renderCharts(result, runs);
    renderTable(result);
  }

  // Divide nominal values by these to get today's dollars.
  const balFactor = (y) => (basis === 'real' ? y.inflationFactor : 1);
  const flowFactor = (y) => (basis === 'real' ? y.inflationFactor / Math.sqrt(1 + num(state.inflation) / 100) : 1);

  function firstFullRetiredYear(result) {
    return result.years.find((y) => y.index * 12 >= result.retireIdx) || result.years.find((y) => y.retired);
  }

  // ------------------------------------------------------------------ status
  function renderStatus(result, scale, runs) {
    const el = document.getElementById('status');
    el.replaceChildren();
    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'title';
    const detail = document.createElement('div');
    detail.className = 'detail';
    body.append(title, detail);
    el.append(icon, body);

    const planAge = num(state.planToAge);
    const endReal = result.endBalance / result.endInflationFactor;
    const which = scenario === 'standard' ? '' : ` with ${SCENARIOS[scenario].label.toLowerCase()} returns`;
    if (result.success) {
      el.className = 'status good';
      icon.textContent = '✓';
      title.textContent = `On track${which}: your savings last through age ${planAge}`;
      detail.textContent = `You'd still have ${fmtBig(endReal)} in today's dollars at the end of the plan.`;
    } else {
      el.className = 'status bad';
      icon.textContent = '!';
      title.textContent = `Shortfall${which}: savings run out at age ${fmtAge(result.firstShortfallAge)}`;
      const sustain = scale != null ? ` You could spend about ${fmt(scale * num(state.expenses))} a year (today's dollars) and last to ${planAge}.` : '';
      detail.textContent = `After that, your retirement income covers only part of your spending.${sustain} Retiring later, saving more, or spending less would close the gap.`;
    }

    // How the other return scenarios turn out.
    const outcome = (r) => (r.success ? `last through age ${planAge}` : `run out at age ${fmtAge(r.firstShortfallAge)}`);
    const others = Object.keys(SCENARIOS).filter((k) => k !== scenario);
    const parts = others.map((k, i) =>
      `${i ? 'with' : 'With'} ${SCENARIOS[k].label.toLowerCase()} returns, ${i ? 'they' : 'savings'} ${outcome(runs[k].result)}`);
    detail.textContent += ` ${parts.join('; ')}.`;
  }

  // ------------------------------------------------------------------- tiles
  function setTile(id, value, sub) {
    document.getElementById(id).textContent = value;
    document.getElementById(`${id}-sub`).textContent = sub;
  }

  function renderTiles(result, scale) {
    const basisWord = basis === 'real' ? "today's dollars" : 'future dollars';
    const other = basis === 'real' ? 'future dollars' : "today's dollars";

    const b = result.balanceAtRetirement;
    if (b) {
      const total = b.taxable + b.deferred + b.roth;
      const shown = basis === 'real' ? total / b.inflationFactor : total;
      const alt = basis === 'real' ? total : total / b.inflationFactor;
      setTile('t-nestegg', fmtBig(shown), `At age ${num(state.retirementAge)} in ${basisWord} · ${fmtBig(alt)} in ${other}`);
    } else {
      setTile('t-nestegg', '–', 'Retirement falls after the end of the plan');
    }

    if (scale != null) {
      const base = num(state.expenses);
      const s = scale * base;
      const diff = s - base;
      const vs = Math.abs(diff) < 50 ? 'matches your plan' : `${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff))} vs. your plan`;
      const changes = state.expenseChanges.length ? ', with your spending changes scaled to match' : '';
      setTile('t-sustain', `${fmt(s)}/yr`, `Today's dollars, lasting to age ${num(state.planToAge)} · ${vs}${changes}`);
    } else {
      setTile('t-sustain', '–', 'Enter annual living expenses');
    }

    const last = result.years[result.years.length - 1];
    if (last) {
      setTile('t-end', fmtBig(last.end.total / balFactor(last)), `At age ${num(state.planToAge)} in ${basisWord}`);
    }

    // Coverage once every income source that starts in retirement has begun.
    const retireAge = num(state.retirementAge);
    const planAge = num(state.planToAge);
    const starts = state.incomes.map((i) => num(i.startAge)).filter((a) => a < planAge);
    const allInAge = Math.max(retireAge, ...starts);
    const y = result.years.find((yr) => yr.retired && yr.age >= Math.ceil(allInAge - 1e-9) && yr.expenses > 0) || firstFullRetiredYear(result);
    if (y && y.expenses > 0) {
      const pct = Math.round((y.incomeNet / y.expenses) * 100);
      const f = flowFactor(y);
      let sub = `At age ${y.age}: ${fmt(y.incomeNet / f)} after-tax income toward ${fmt(y.expenses / f)} spending`;
      if (y.age > Math.ceil(retireAge)) sub += `. Before that, from age ${fmtAge(retireAge)}, savings carry more of the load`;
      setTile('t-cover', `${pct}%`, sub);
    } else {
      setTile('t-cover', '–', 'No retirement years in the plan');
    }

    const sc = SCENARIOS[scenario];
    const basisText = basis === 'real'
      ? `Future amounts adjusted back by ${num(state.inflation)}% yearly inflation`
      : 'Amounts as they will appear in each future year';
    document.getElementById('basis-note').textContent =
      `${sc.label} returns: ${num(state[sc.pre])}% before, ${num(state[sc.post])}% after retiring · ${basisText}`;
  }

  // -------------------------------------------------------- scenario summary
  function renderScenarioTable(runs) {
    const tbody = document.querySelector('#scenario-table tbody');
    const planAge = num(state.planToAge);
    const color = css('--s-range');
    const frag = document.createDocumentFragment();
    for (const [key, sc] of Object.entries(SCENARIOS)) {
      const { result, scale } = runs[key];
      const tr = document.createElement('tr');
      if (key === scenario) tr.className = 'is-selected';

      const name = document.createElement('td');
      const k = document.createElement('span');
      k.className = 'line-key';
      k.style.background = key === 'standard' ? color : alpha(color, 0.55);
      name.append(k, document.createTextNode(sc.label));

      const b = result.balanceAtRetirement;
      const nest = b ? (b.taxable + b.deferred + b.roth) / (basis === 'real' ? b.inflationFactor : 1) : null;
      const last = result.years[result.years.length - 1];
      const lasts = document.createElement('td');
      lasts.textContent = result.success ? `Through age ${planAge}` : `Run out at ${fmtAge(result.firstShortfallAge)}`;
      if (!result.success) lasts.className = 'short';

      const cells = [
        `${num(state[sc.pre])}% / ${num(state[sc.post])}%`,
        nest == null ? '–' : fmtBig(nest),
        null,
        scale == null ? '–' : `${fmt(scale * num(state.expenses))}/yr`,
        last ? fmtBig(last.end.total / balFactor(last)) : '–',
      ];
      tr.append(name);
      for (const c of cells) {
        if (c === null) { tr.append(lasts); continue; }
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      frag.append(tr);
    }
    tbody.replaceChildren(frag);
  }

  // ------------------------------------------------------------------ charts
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const alpha = (hex, a) => {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };
  const charts = {};

  /** Direct labels at the right end of each line, dropping any that would collide. */
  const endLabelPlugin = {
    id: 'endLabels',
    defaults: { enabled: false },
    afterDatasetsDraw(chart, _args, opts) {
      if (!opts.enabled) return;
      const { ctx } = chart;
      const items = chart.data.datasets.map((ds, i) => {
        const meta = chart.getDatasetMeta(i);
        if (!ds.endLabel || meta.hidden || !meta.data.length) return null;
        const pt = meta.data[meta.data.length - 1];
        return { text: ds.endLabel, x: pt.x, y: pt.y, priority: ds.labelPriority ?? i };
      }).filter(Boolean).sort((a, b) => a.priority - b.priority);
      const placed = [];
      ctx.save();
      ctx.font = `11px ${css('--font')}`;
      ctx.fillStyle = opts.textColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (const it of items) {
        if (placed.some((p) => Math.abs(p.y - it.y) < 14)) continue;
        placed.push(it);
        ctx.fillText(it.text, it.x + 6, it.y);
      }
      ctx.restore();
    },
  };

  /** Vertical marker lines (retirement, depletion) drawn at fractional category positions. */
  const markerPlugin = {
    id: 'markers',
    afterDatasetsDraw(chart, _args, opts) {
      const markers = opts.items || [];
      if (!markers.length) return;
      const { ctx, chartArea, scales: { x } } = chart;
      const n = chart.data.labels.length;
      if (!n) return;
      const step = n > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : chartArea.width;
      ctx.save();
      for (const m of markers) {
        const px = x.getPixelForValue(0) - step / 2 + m.pos * step;
        if (px < chartArea.left - 1 || px > chartArea.right + 1) continue;
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, chartArea.top + 14);
        ctx.lineTo(px, chartArea.bottom);
        ctx.stroke();
        ctx.fillStyle = opts.textColor;
        ctx.font = `600 11px ${css('--font')}`;
        const w = ctx.measureText(m.label).width;
        const right = px + 4 + w <= chartArea.right;
        ctx.textAlign = right ? 'left' : 'right';
        ctx.fillText(m.label, right ? px + 4 : px - 4, chartArea.top + 10);
      }
      ctx.restore();
    },
  };

  function baseOptions(stackedTooltipFooter) {
    const ink2 = css('--ink-2');
    const muted = css('--muted');
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { color: css('--axis') },
          ticks: { color: muted, autoSkip: true, maxRotation: 0, font: { family: css('--font') } },
          title: { display: true, text: 'Age', color: muted, font: { family: css('--font'), size: 11 } },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: css('--grid'), lineWidth: 1 },
          border: { display: false },
          ticks: { color: muted, callback: (v) => usdCompact.format(v), font: { family: css('--font') } },
        },
      },
      plugins: {
        legend: {
          position: 'top',
          align: 'start',
          labels: {
            color: ink2, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyleWidth: 12,
            font: { family: css('--font'), size: 12 },
            sort: (a, b) => a.datasetIndex - b.datasetIndex,
          },
        },
        tooltip: {
          backgroundColor: css('--surface'),
          titleColor: css('--ink'),
          bodyColor: css('--ink'),
          footerColor: ink2,
          borderColor: css('--axis'),
          borderWidth: 1,
          padding: 10,
          boxWidth: 10,
          boxHeight: 2,
          usePointStyle: false,
          titleFont: { family: css('--font'), weight: '600' },
          bodyFont: { family: css('--font') },
          footerFont: { family: css('--font'), weight: '400' },
          callbacks: {
            title: (items) => `Age ${items[0].label}`,
            label: (item) => `${fmt(item.raw)}  ${item.dataset.label}`,
            footer: stackedTooltipFooter,
          },
        },
        markers: { items: [], textColor: ink2 },
      },
    };
  }

  function barDataset(label, data, color) {
    return {
      type: 'bar',
      label,
      data,
      backgroundColor: color,
      borderColor: css('--surface'),
      borderWidth: { top: 2 },
      borderSkipped: 'start',
      borderRadius: 4,
      maxBarThickness: 24,
      categoryPercentage: 0.9,
      barPercentage: 0.9,
      stack: 'money',
      order: 1,
      pointStyle: 'rect',
    };
  }

  function retirementMarkers(result, offsetYears) {
    const items = [];
    const ret = result.retireIdx / 12 - offsetYears;
    if (result.retireIdx < result.totalMonths) items.push({ pos: ret, label: 'Retire', color: css('--ink-2') });
    if (result.firstShortfallAge != null) {
      const pos = result.firstShortfallAge - num(state.currentAge) - offsetYears;
      items.push({ pos, label: 'Savings run out', color: css('--critical') });
    }
    return items;
  }

  function upsertChart(key, canvasId, config) {
    if (charts[key]) charts[key].destroy();
    charts[key] = new Chart(document.getElementById(canvasId), config);
  }

  function renderRangeChart(runs) {
    const color = css('--s-range');
    const years = runs.standard.result.years;
    const totals = (sc) => runs[sc].result.years.map((y) => Math.round(y.end.total / balFactor(y)));
    const line = (sc, extra) => {
      const data = totals(sc);
      return {
        type: 'line',
        label: `${SCENARIOS[sc].label} returns`,
        data,
        endLabel: `${SCENARIOS[sc].label} ${usdCompact.format(data[data.length - 1] || 0)}`,
        borderColor: sc === 'standard' ? color : alpha(color, 0.55),
        backgroundColor: sc === 'standard' ? color : alpha(color, 0.55),
        borderWidth: sc === 'standard' ? 2.5 : 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBorderColor: css('--surface'),
        pointHoverBorderWidth: 2,
        borderJoinStyle: 'round',
        borderCapStyle: 'round',
        pointStyle: 'line',
        fill: false,
        ...extra,
      };
    };
    const opts = baseOptions(null);
    opts.scales.x.stacked = false;
    opts.scales.y.stacked = false;
    opts.layout = { padding: { right: 112 } };
    opts.plugins.endLabels = { enabled: true, textColor: css('--ink-2') };
    opts.plugins.markers.items = retirementMarkers(runs.standard.result, 0).filter((m) => m.label === 'Retire');
    upsertChart('range', 'chart-range', {
      data: {
        labels: years.map((y) => y.age),
        datasets: [
          line('high', { labelPriority: 1 }),
          line('standard', { labelPriority: 0 }),
          // Shade the band between the low line and the high line (dataset 0).
          line('low', { labelPriority: 2, fill: { target: 0 }, backgroundColor: alpha(color, 0.12) }),
        ],
      },
      options: opts,
    });
  }

  function renderCharts(result, runs) {
    if (typeof Chart === 'undefined') {
      document.querySelectorAll('.chart-box').forEach((b) => {
        b.textContent = 'Charts need an internet connection to load Chart.js. The table below still has every number.';
      });
      return;
    }
    if (!markerPlugin.registered) { Chart.register(markerPlugin, endLabelPlugin); markerPlugin.registered = true; }
    renderRangeChart(runs);
    const years = result.years;

    // --- Balance chart
    const labels = years.map((y) => y.age);
    const bal = (t) => years.map((y) => Math.round(y.end[t] / balFactor(y)));
    const balOpts = baseOptions((items) => `Total ${fmt(items.reduce((s, i) => s + i.raw, 0))}`);
    balOpts.plugins.markers.items = retirementMarkers(result, 0);
    upsertChart('balance', 'chart-balance', {
      data: {
        labels,
        datasets: [
          barDataset(TYPE_LABELS.taxable, bal('taxable'), css('--s-taxable')),
          barDataset(TYPE_LABELS.deferred, bal('deferred'), css('--s-deferred')),
          barDataset(TYPE_LABELS.roth, bal('roth'), css('--s-roth')),
        ],
      },
      options: balOpts,
    });

    // --- Retirement cash-flow chart
    const ry = years.filter((y) => y.retired);
    const offset = ry.length ? ry[0].index : 0;
    const flow = (fn) => ry.map((y) => Math.round(fn(y) / flowFactor(y)));
    const flowOpts = baseOptions((items) => {
      const y = ry[items[0].dataIndex];
      if (!y) return '';
      const f = flowFactor(y);
      const lines = [`Taxes paid ${fmt((y.incomeTax + y.withdrawTax + y.growthTax) / f)}`];
      if (y.surplusReinvested > 1) lines.push(`Surplus reinvested ${fmt(y.surplusReinvested / f)}`);
      return lines;
    });
    flowOpts.plugins.tooltip.filter = (item) => !(item.dataset.hideZero && item.raw === 0);
    flowOpts.plugins.markers.items = retirementMarkers(result, offset).filter((m) => m.label !== 'Retire' || m.pos > 0.01);

    const datasets = [
      barDataset('Retirement income (after tax)', flow((y) => y.incomeNet), css('--s-income')),
      barDataset(`${TYPE_LABELS.taxable} withdrawals`, flow((y) => y.withdrawNet.taxable), css('--s-taxable')),
      barDataset(`${TYPE_LABELS.deferred} withdrawals (after tax)`, flow((y) => y.withdrawNet.deferred), css('--s-deferred')),
      barDataset(`${TYPE_LABELS.roth} withdrawals`, flow((y) => y.withdrawNet.roth), css('--s-roth')),
    ];
    if (result.totalShortfall > 0.01) {
      const d = barDataset('Unfunded spending', flow((y) => y.shortfall), css('--critical'));
      d.hideZero = true;
      datasets.push(d);
    }
    datasets.push({
      type: 'line',
      label: 'Spending target',
      data: flow((y) => y.expenses),
      borderColor: css('--ink'),
      backgroundColor: css('--ink'),
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      borderJoinStyle: 'round',
      borderCapStyle: 'round',
      stepped: 'middle',
      stack: 'target',
      order: 0,
      pointStyle: 'line',
    });
    upsertChart('flow', 'chart-flow', { data: { labels: ry.map((y) => y.age), datasets }, options: flowOpts });
  }

  // ------------------------------------------------------------------- table
  function renderTable(result) {
    const tbody = document.querySelector('#table tbody');
    const frag = document.createDocumentFragment();
    let marked = false;
    for (const y of result.years) {
      const f = flowFactor(y);
      const bf = balFactor(y);
      const tr = document.createElement('tr');
      const isRetireStart = y.retired && !marked;
      if (isRetireStart) { tr.className = 'retire-start'; marked = true; }
      const wGross = y.withdrawGross.taxable + y.withdrawGross.deferred + y.withdrawGross.roth;
      const taxes = y.growthTax + y.incomeTax + y.withdrawTax;
      const cells = [
        y.calendarYear,
        isRetireStart ? `${y.age} · retire` : y.age,
        fmt(y.contributions / f),
        fmt(y.growth / f),
        fmt(y.incomeGross / f),
        fmt(y.expenses / f),
        fmt(wGross / f),
        fmt(taxes / f),
        y.shortfall > 0.5 ? fmt(y.shortfall / f) : '–',
        fmt(y.end.taxable / bf),
        fmt(y.end.deferred / bf),
        fmt(y.end.roth / bf),
        fmt(y.end.total / bf),
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        td.textContent = String(c);
        if (i === 8 && y.shortfall > 0.5) td.className = 'short';
        tr.append(td);
      });
      frag.append(tr);
    }
    tbody.replaceChildren(frag);
  }

  // --------------------------------------------------------- header controls
  function setBasis(b) {
    basis = b;
    store.set(BASIS_KEY, b);
    document.querySelectorAll('[data-basis]').forEach((btn) => btn.setAttribute('aria-checked', String(btn.dataset.basis === b)));
    update();
  }
  document.querySelectorAll('[data-basis]').forEach((btn) => btn.addEventListener('click', () => setBasis(btn.dataset.basis)));

  function setScenario(sc, render = true) {
    scenario = sc;
    store.set(SCENARIO_KEY, sc);
    document.querySelectorAll('[data-scenario]').forEach((btn) => btn.setAttribute('aria-checked', String(btn.dataset.scenario === sc)));
    if (render) update();
  }
  document.querySelectorAll('[data-scenario]').forEach((btn) => btn.addEventListener('click', () => setScenario(btn.dataset.scenario)));

  const THEMES = ['auto', 'light', 'dark'];
  function applyTheme(t) {
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    document.getElementById('btn-theme').textContent = `Theme: ${t}`;
  }
  let theme = THEMES.includes(store.get(THEME_KEY)) ? store.get(THEME_KEY) : 'auto';
  applyTheme(theme);
  document.getElementById('btn-theme').addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    store.set(THEME_KEY, theme);
    applyTheme(theme);
    update();
  });
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (theme === 'auto') update(); });
  } catch { /* old browser */ }

  document.getElementById('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `retirement-plan-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  document.getElementById('file-import').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    file.text().then((text) => {
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.accounts)) throw new Error('Not a plan file');
      state = normalize(parsed);
      save();
      fillScalars();
      renderAllLists();
      update();
    }).catch(() => alert("That file couldn't be read as a retirement plan.")).finally(() => { e.target.value = ''; });
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    if (!confirm('Replace your current plan with the sample plan? Export first if you want to keep it.')) return;
    state = defaultState();
    save();
    fillScalars();
    renderAllLists();
    update();
  });

  // -------------------------------------------------------------------- boot
  bindScalars();
  fillScalars();
  renderAllLists();
  setScenario(scenario, false);
  setBasis(basis);
})();
