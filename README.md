# Retirement Income Estimator

A personal, month-by-month retirement projection with charts. Plain HTML/CSS/JS with no build step.

## Run it

Open `index.html` in a browser. Charts load Chart.js from a CDN, so they need an internet connection. The year-by-year table works without one.

Your plan saves automatically in the browser's local storage. Use **Export** to save it as a JSON file (a backup, or a second scenario) and **Import** to load one.

## What it models

- **Accounts** of three tax types: tax-deferred (401(k)/traditional IRA), Roth, and taxable, each with a balance and a monthly contribution.
- **Contribution changes**: increase an account's contribution by, or set it to, an amount in a given month, either once or every year in that month (optionally until a set year). Contributions stop at retirement.
- **One-time deposits and withdrawals** in a given month.
- **Retirement spending** in today's dollars, with optional changes from a given age.
- **Retirement income** (Social Security, pensions, and so on): start and end ages, whether it rises with inflation, and whether it's taxable.
- **Assumptions**: low, standard, and high investment returns (before and after retirement), tax rates before and after retirement, inflation, and withdrawal order.

### Taxes

- Tax-deferred withdrawals are taxed at the after-retirement rate. Each withdrawal is enlarged so the after-tax amount covers spending.
- Roth withdrawals are tax-free.
- Taxable-account growth is taxed as it's earned, at the before- or after-retirement rate (this can be turned off).
- Taxable retirement income is taxed at the after-retirement rate.
- Income above spending is reinvested in the taxable account.

Not modeled: RMDs, tax brackets, partial Social Security taxation, early-withdrawal penalties, or market volatility (returns are steady averages).

### Outputs

- A **Low / Standard / High returns** switch that drives the tiles, account charts, and table.
- A **range of outcomes** chart and table comparing all three return scenarios side by side.
- An on-track or shortfall status.
- Nest egg at retirement.
- **Sustainable spending**: the highest annual spending, scaling every spending figure, that lasts to the plan age. It's found by binary search.
- Ending balance, and how much of your spending income covers.
- Charts of balance by account type and of where retirement spending comes from.
- A year-by-year table, viewable in today's or future dollars.

## Files

- `engine.js`: the simulation, pure functions with no DOM, also usable from Node: `require('./engine.js').simulate(inputs)`.
- `app.js`: UI, persistence, charts, table.
- `index.html`, `styles.css`: layout and theming (light and dark).
