#!/usr/bin/env python3
"""
fetch_historical.py — One-time download of free historical market data
======================================================================
Outputs: data/market_history.js  (loaded by index.html as a <script> tag)

Free data sources (no API key required):
  • S&P 500 monthly prices  — Stooq.com
  • CPI (inflation)          — FRED / St. Louis Fed
  • 10-yr Treasury yield     — FRED / St. Louis Fed
  • S&P 500 dividend yield   — FRED (MULTPL data via FRED proxy)

Usage:
    pip install pandas requests numpy
    python fetch_historical.py

The generated data/market_history.js sets window.MARKET_HISTORY and
enables historically-calibrated regime parameters in the forecast engine.
"""

import json, os, sys, math
from datetime import datetime, timedelta
from io import StringIO

try:
    import requests
    import pandas as pd
    import numpy as np
except ImportError:
    print("Installing required packages...")
    os.system(f"{sys.executable} -m pip install requests pandas numpy")
    import requests
    import pandas as pd
    import numpy as np

REGIME_NAMES = ['Bull', 'Bear', 'Crash', 'Recovery', 'Sideways', 'Stagflation']
N_REGIMES    = 6

# ─────────────────────────────────────────────
# DATA FETCHING
# ─────────────────────────────────────────────

def fetch_stooq(symbol='%5Espx', interval='m', retries=3):
    """Download monthly prices from Stooq (free, no API key)."""
    url = f'https://stooq.com/q/d/l/?s={symbol}&i={interval}'
    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=30,
                             headers={'User-Agent': 'Mozilla/5.0 (compatible)'})
            r.raise_for_status()
            df = pd.read_csv(StringIO(r.text), parse_dates=['Date'])
            df = df.sort_values('Date').set_index('Date')
            if 'Close' in df.columns and len(df) > 10:
                return df['Close']
        except Exception as e:
            print(f"  Stooq attempt {attempt+1} failed: {e}")
    return None

def fetch_fred(series_id, retries=3):
    """Download a FRED series as a monthly pandas Series (no API key)."""
    url = f'https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}'
    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=30,
                             headers={'User-Agent': 'Mozilla/5.0 (compatible)'})
            r.raise_for_status()
            df = pd.read_csv(StringIO(r.text), parse_dates=['DATE'], index_col='DATE')
            df.columns = ['value']
            df = df[df['value'] != '.'].copy()
            df['value'] = pd.to_numeric(df['value'], errors='coerce')
            return df['value'].dropna()
        except Exception as e:
            print(f"  FRED {series_id} attempt {attempt+1} failed: {e}")
    return None

# ─────────────────────────────────────────────
# REGIME CLASSIFICATION
# ─────────────────────────────────────────────

def classify_regimes(ret_monthly, inflation_monthly):
    """
    Classify each month into one of 6 regimes based on
    rolling 12-month returns, current month return, and inflation.

    Returns a pandas Series with integer regime labels 0-5.
    """
    ret12 = ret_monthly.rolling(12).sum()
    regimes = pd.Series(index=ret_monthly.index, dtype=int)

    for date in ret_monthly.index:
        r1  = ret_monthly.get(date, 0.0)
        r12 = ret12.get(date, 0.0) if not (isinstance(ret12.get(date, None), float) and math.isnan(ret12.get(date, None))) else 0.0
        inf = inflation_monthly.get(date, 0.002)  # default 2.4%/yr

        if r1 < -0.09:                        # single-month crash
            regime = 2  # Crash
        elif inf > 0.005 and r12 < 0.06:      # high inflation + low growth
            regime = 5  # Stagflation
        elif r12 < -0.18:                     # deep bear
            regime = 1  # Bear
        elif r12 > 0.14:                      # strong bull
            regime = 0  # Bull
        elif r12 > 0.04:                      # moderate positive trend
            regime = 3  # Recovery
        else:                                  # flat / range-bound
            regime = 4  # Sideways

        regimes[date] = regime

    return regimes

# ─────────────────────────────────────────────
# TRANSITION MATRIX
# ─────────────────────────────────────────────

def build_transition_matrix(regimes):
    """Build a 6×6 Markov transition matrix from regime sequence."""
    mat = np.zeros((N_REGIMES, N_REGIMES))
    vals = regimes.values
    for t in range(len(vals) - 1):
        fr, to = int(vals[t]), int(vals[t + 1])
        if 0 <= fr < N_REGIMES and 0 <= to < N_REGIMES:
            mat[fr][to] += 1

    # Normalize rows (add small prior to avoid zero rows)
    for i in range(N_REGIMES):
        row_sum = mat[i].sum()
        if row_sum == 0:
            mat[i] = np.ones(N_REGIMES) / N_REGIMES
        else:
            mat[i] = mat[i] / row_sum

    return mat

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────

def main():
    print("=" * 60)
    print("Portfolio Predictor — Historical Data Fetcher")
    print("=" * 60)

    # ── 1. S&P 500 monthly prices ──────────────────────────────
    print("\n[1/4] Downloading S&P 500 monthly prices (Stooq)...")
    spx = fetch_stooq('%5Espx', 'm')
    if spx is None:
        print("  ⚠  Stooq failed. Trying Yahoo Finance proxy...")
        # Fallback: try YF proxy
        try:
            url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1mo&range=100y'
            r = requests.get(url, timeout=30, headers={'User-Agent': 'Mozilla/5.0'})
            jd = r.json()
            ts = jd['chart']['result'][0]['timestamp']
            cl = jd['chart']['result'][0]['indicators']['quote'][0]['close']
            dates = pd.to_datetime(ts, unit='s').normalize()
            spx = pd.Series(cl, index=dates).dropna()
            print(f"  ✓ Yahoo fallback: {len(spx)} months")
        except Exception as e:
            print(f"  ✗ Yahoo fallback also failed: {e}")
            print("  Using hardcoded built-in defaults only.")
            write_fallback_js()
            return

    spx.index = spx.index.to_period('M').to_timestamp('M')
    spx = spx[~spx.index.duplicated(keep='last')]
    print(f"  ✓ {len(spx)} months  ({spx.index[0].date()} → {spx.index[-1].date()})")

    # Monthly price returns + constant ~1.9%/yr dividend (historical avg)
    price_ret = spx.pct_change()
    div_monthly = 0.019 / 12
    sp500_ret = price_ret + div_monthly

    # ── 2. CPI (inflation) ──────────────────────────────────────
    print("\n[2/4] Downloading CPI from FRED (CPIAUCSL)...")
    cpi = fetch_fred('CPIAUCSL')
    if cpi is None:
        print("  ⚠  Using constant 2.5%/yr inflation estimate.")
        inflation = pd.Series(0.025 / 12, index=sp500_ret.index)
    else:
        cpi.index = cpi.index.to_period('M').to_timestamp('M')
        inflation = cpi.pct_change()
        print(f"  ✓ {len(inflation)} months  ({cpi.index[0].date()} → {cpi.index[-1].date()})")

    # ── 3. 10-year Treasury yield ───────────────────────────────
    print("\n[3/4] Downloading 10-yr Treasury yield from FRED (GS10)...")
    t10y = fetch_fred('GS10')
    if t10y is None:
        print("  ⚠  Using constant 4.0%/yr bond yield estimate.")
        bond_yield_monthly = pd.Series(0.04 / 12, index=sp500_ret.index)
    else:
        t10y.index = t10y.index.to_period('M').to_timestamp('M')
        # Convert annual % to monthly decimal
        bond_yield_monthly = (t10y / 100.0) / 12.0
        print(f"  ✓ {len(t10y)} months  ({t10y.index[0].date()} → {t10y.index[-1].date()})")

    # ── 4. Align series ─────────────────────────────────────────
    print("\n[4/4] Processing and classifying regimes...")
    df = pd.DataFrame({
        'sp500': sp500_ret,
        'inflation': inflation,
        'bond_yield': bond_yield_monthly,
    }).dropna()

    # Trim to a reasonable start (1940+)
    df = df.loc['1940-01-01':]
    print(f"  Aligned dataset: {len(df)} months ({df.index[0].date()} → {df.index[-1].date()})")

    # Classify regimes
    regimes = classify_regimes(df['sp500'], df['inflation'])
    df['regime'] = regimes

    # ── Regime statistics ───────────────────────────────────────
    regime_stats = {}
    for i, name in enumerate(REGIME_NAMES):
        mask = df['regime'] == i
        subset = df[mask]
        if len(subset) < 2:
            # fallback for under-represented regimes
            regime_stats[name] = {'count': 0, 'pct': 0.0,
                                  'mean': 0.001, 'std': 0.04,
                                  'bond_mean': 0.003, 'bond_std': 0.01}
        else:
            regime_stats[name] = {
                'count':     int(mask.sum()),
                'pct':       round(float(mask.mean()), 4),
                'mean':      round(float(subset['sp500'].mean()), 6),
                'std':       round(float(subset['sp500'].std()),  6),
                'bond_mean': round(float(subset['bond_yield'].mean()), 6),
                'bond_std':  round(float(subset['bond_yield'].std()),  6),
            }

    # ── Transition matrix ───────────────────────────────────────
    trans_mat = build_transition_matrix(df['regime'])

    # ── Initial distribution ────────────────────────────────────
    init_dist = []
    for i in range(N_REGIMES):
        init_dist.append(round(float((df['regime'] == i).mean()), 4))
    # Normalize
    tot = sum(init_dist)
    init_dist = [round(x / tot, 4) for x in init_dist]

    # ── Recent performance for display ──────────────────────────
    recent = df.tail(360)  # last 30 years
    recent_dates   = [str(d.date()) for d in recent.index]
    recent_returns = [round(float(x), 6) for x in recent['sp500'].tolist()]
    recent_regimes = [int(x) for x in recent['regime'].tolist()]

    # ── Assemble output ─────────────────────────────────────────
    output = {
        'source':       'Stooq (S&P 500 monthly) + FRED (CPI, GS10)',
        'updated':      datetime.now().strftime('%Y-%m-%d'),
        'date_range':   [str(df.index[0].date()), str(df.index[-1].date())],
        'months_total': len(df),
        'regime_names': REGIME_NAMES,
        'regime_stats': regime_stats,
        'init_dist':    init_dist,
        'transition':   [[round(float(x), 5) for x in row] for row in trans_mat.tolist()],
        'recent': {
            'dates':   recent_dates,
            'returns': recent_returns,
            'regimes': recent_regimes,
        }
    }

    # ── Write output JS ─────────────────────────────────────────
    os.makedirs('data', exist_ok=True)
    out_path = os.path.join('data', 'market_history.js')
    with open(out_path, 'w') as f:
        f.write('// Auto-generated by fetch_historical.py — do not edit\n')
        f.write(f'// Source: {output["source"]}\n')
        f.write(f'// Updated: {output["updated"]}\n')
        f.write('window.MARKET_HISTORY = ')
        f.write(json.dumps(output, indent=2))
        f.write(';\n')

    print(f"\n{'='*60}")
    print(f"✅  Wrote: {out_path}")
    print(f"   Date range : {output['date_range'][0]}  →  {output['date_range'][1]}")
    print(f"   Total months: {output['months_total']}")
    print(f"\nRegime statistics:")
    for name, s in regime_stats.items():
        if s['count'] == 0:
            continue
        print(f"  {name:12s}: {s['count']:4d} months ({s['pct']*100:4.1f}%)  "
              f"mean={s['mean']*100:+.2f}%/mo  std={s['std']*100:.2f}%/mo")

    print(f"\nTransition matrix (rows = from, cols = to):")
    header = '             ' + '  '.join(f'{n[:4]:>6}' for n in REGIME_NAMES)
    print(header)
    for i, name in enumerate(REGIME_NAMES):
        row_str = ' '.join(f'{x*100:5.1f}%' for x in trans_mat[i])
        print(f"  {name:12s}  {row_str}")

    print(f"\nOpen portfolio_predictor/index.html in Chrome/Edge for the full simulation.")


def write_fallback_js():
    """Write a minimal JS file noting data could not be fetched."""
    os.makedirs('data', exist_ok=True)
    with open(os.path.join('data', 'market_history.js'), 'w') as f:
        f.write('// Data fetch failed — app will use built-in defaults\n')
        f.write('window.MARKET_HISTORY = null;\n')
    print("Wrote fallback market_history.js. The app still works with built-in estimates.")


if __name__ == '__main__':
    main()
