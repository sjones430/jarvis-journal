'use strict';

const DEFAULT_REASONS = [
  "Doji Break","QM","Trendline","Pattern that needs retracement",
  "Common point of rejection (CPR)","Demand become supply (DBS)","Supply become demand (SBD)",
  "Resistance become support (RBS)","Support become Resistance (SBR)","Exhaustion candle",
  "Supply","Demand","OrderBlock (OB)","Marubozu candle","Third Touch Breakout (3TBO)",
  "Gap Up/Gap Down","ABC break","Round Number","Closed on Support","Closed on Resistance"
];

const TIMEFRAMES = ["1M","2M","3M","5M","10M","15M","30M","1H","2H","4H","1D"];

const DECREASE_ADJUSTMENT_MARKER = '[JARVIS_ADJUSTMENT_DECREASE]';

const S = window.JarvisStorage;
const U = window.JarvisUtil;
const { num, clamp, safeStr } = U;

const $ = id => document.getElementById(id);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;',
  '<':'&lt;',
  '>':'&gt;',
  '"':'&quot;',
  "'":'&#39;'
}[c]));

const state = {
  trades: [],
  reasons: [],
  transactions: [],
  settings: {
    startingBalance: 70,
    defaultPayout: 80,
    currency: 'USD',
    defaultSession: 'New York'
  },
  pendingShots: [],
  historyFilter: 'ALL',
  writable: false
};

/* ---------- helpers ---------- */

const money = n => {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: state.settings.currency || 'USD'
    }).format(v);
  } catch {
    return '$' + v.toFixed(2);
  }
};

const pnl = t => {
  if (t.result === 'WIN') {
    return num(t.risk) * clamp(num(t.payout), 0, 1000) / 100;
  }

  if (t.result === 'LOSS') {
    return -clamp(num(t.risk), 0, 1e9);
  }

  return 0;
};

const resolved = () =>
  state.trades.filter(t => ['WIN', 'LOSS', 'DRAW'].includes(t.result));

// Draws are completed trades, but are excluded from the win-rate denominator.
const winRate = arr => {
  const decisive = arr.filter(t => t.result === 'WIN' || t.result === 'LOSS');
  return decisive.length
    ? decisive.filter(t => t.result === 'WIN').length / decisive.length * 100
    : 0;
};

const reasonById = id =>
  state.reasons.find(r => r.id === id);

const reasonsOf = (t, cache) => {
  if (cache && cache.has(t.id)) return cache.get(t.id);

  const names = (t.reasonIds || []).map(id => {
    const live = reasonById(id);

    if (live) return live.name;
    if (t.reasonNames && t.reasonNames[id]) return t.reasonNames[id];

    return 'Archived reason';
  });

  if (cache) cache.set(t.id, names);

  return names;
};

const sampleLabel = n =>
  n < 10 ? 'Insufficient sample' :
  n < 30 ? 'Preliminary' :
  n < 50 ? 'Developing' :
  n < 100 ? 'Stronger evidence' :
  'Larger sample';

/* ---------- transaction helpers ---------- */

function isDecreaseAdjustment(t) {
  return t &&
    t.type === 'Adjustment' &&
    String(t.note || '').startsWith(DECREASE_ADJUSTMENT_MARKER);
}

function transactionEffect(t) {
  const amount = Math.abs(num(t.amount));

  if (t.type === 'Withdrawal' || isDecreaseAdjustment(t)) {
    return -amount;
  }

  return amount;
}

function transactionDisplayType(t) {
  return isDecreaseAdjustment(t)
    ? 'Adjustment (Decrease)'
    : t.type;
}

function transactionDisplayNote(t) {
  return String(t.note || '')
    .replace(DECREASE_ADJUSTMENT_MARKER, '')
    .trim();
}

function ensureAdjustmentOptions() {
  const select = $('txType');
  if (!select) return;

  const exists = [...select.options].some(
    o => o.value === 'Adjustment (Decrease)' ||
         o.textContent === 'Adjustment (Decrease)'
  );

  if (!exists) {
    const option = document.createElement('option');
    option.value = 'Adjustment (Decrease)';
    option.textContent = 'Adjustment (Decrease)';
    select.appendChild(option);
  }
}

/* ---------- screenshot helpers ---------- */

function renderScreenshotThumbs(t) {
  const shots = Array.isArray(t.screenshots) ? t.screenshots : [];

  if (!shots.length) {
    return '<span class="muted">—</span>';
  }

  return `<div class="thumbs" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
    ${shots.map((s, i) => `
      <img
        data-lightbox
        src="${esc(s.data)}"
        alt="Trade screenshot ${i + 1}"
        title="${esc(
          (s.tf || 'Unspecified timeframe') +
          (s.reasonIds?.length ? ' · ' + s.reasonIds.map(id =>
            reasonById(id)?.name || t.reasonNames?.[id] || 'Archived reason'
          ).join(', ') : '')
        )}"
        style="width:58px;height:44px;object-fit:cover;border-radius:6px;border:1px solid #263653;cursor:zoom-in"
      >
    `).join('')}
  </div>`;
}

function showError(msg) {
  const b = $('errorBanner');

  if (!b) {
    console.error(msg);
    return;
  }

  b.textContent = msg;
  b.classList.add('show');
}

function clearError() {
  const b = $('errorBanner');
  if (b) b.classList.remove('show');
}

function setWritable(v) {
  state.writable = v;

  document.querySelectorAll(
    '#tradeForm button[type=submit], #saveSettings, #exportBtn, #reasonForm button, #txForm button'
  ).forEach(b => {
    b.disabled = !v;
    b.style.opacity = v ? '' : '.5';
  });
}

/* ---------- navigation ---------- */

const TITLES = {
  dashboard: ['Dashboard', 'Your trading performance at a glance.'],
  log: ['Log Trade', 'Record a trade with all its context.'],
  history: ['Trade History', 'Review and edit every recorded trade.'],
  setups: ['Setups', 'See which exact setups perform best.'],
  analytics: ['Analytics', 'Understand what your journal data shows.'],
  settings: ['Settings', 'Account preferences, reasons, and backups.']
};

function nav(page) {
  document.querySelectorAll('.section').forEach(x =>
    x.classList.remove('active')
  );

  const sec = $(page);
  if (sec) sec.classList.add('active');

  document.querySelectorAll('#nav button').forEach(b =>
    b.classList.toggle('active', b.dataset.page === page)
  );

  const [h, p] = TITLES[page] || ['Jarvis', ''];

  if ($('pageTitle')) $('pageTitle').textContent = h;
  if ($('pageSub')) $('pageSub').textContent = p;
}

/* ---------- reason & timeframe checks ---------- */

function renderChecks() {
  const active = state.reasons.filter(r => r.active);

  $('reasonChecks').innerHTML = active.map(r =>
    `<label class="check">
      <input type="checkbox" name="reason" value="${esc(r.id)}">
      ${esc(r.name)}
    </label>`
  ).join('') || '<span class="muted">No active reasons. Add some in Settings.</span>';

  $('tfChecks').innerHTML = TIMEFRAMES.map(t =>
    `<label class="check">
      <input type="checkbox" name="tf" value="${esc(t)}">
      ${esc(t)}
    </label>`
  ).join('');
}

/* ---------- dashboard ---------- */

function renderDashboard() {
  const r = resolved();
  const wins = r.filter(t => t.result === 'WIN').length;
  const losses = r.filter(t => t.result === 'LOSS').length;
  const profit = r.reduce((s, t) => s + pnl(t), 0);

  const statsData = [
    ['Resolved trades', r.length, ''],
    ['Win rate', winRate(r).toFixed(1) + '%', 'blue'],
    ['Trading P/L', money(profit), profit >= 0 ? 'green' : 'red'],
    ['Open trades', state.trades.filter(t => t.result === 'OPEN').length, '']
  ];

  $('stats').innerHTML = statsData.map(([label, val, cls]) =>
    `<div class="stat">
      <label>${esc(label)}</label>
      <strong class="${cls}">${esc(val)}</strong>
    </div>`
  ).join('');

  const cache = new Map();

  const recent = [...state.trades]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 6);

  $('recent').innerHTML = recent.length
    ? `<div class="tablewrap">
        <table>
          <thead>
            <tr><th>Pair</th><th>Result</th><th>Reasons</th><th>P/L</th></tr>
          </thead>
          <tbody>
            ${recent.map(t =>
              `<tr>
                <td>${esc(t.pair)}</td>
                <td><span class="pill ${t.result.toLowerCase()}">${esc(t.result)}</span></td>
                <td>${reasonsOf(t, cache).length}</td>
                <td class="${pnl(t) >= 0 ? 'green' : 'red'}">${money(pnl(t))}</td>
              </tr>`
            ).join('')}
          </tbody>
        </table>
      </div>`
    : `<div class="empty">No trades yet. Log your first trade to begin building your journal.</div>`;

  $('snapshot').innerHTML =
    `<div class="mini"><span class="muted">Winning trades</span><b class="green">${wins}</b></div>` +
    `<div class="mini"><span class="muted">Losing trades</span><b class="red">${losses}</b></div>` +
    `<div class="mini"><span class="muted">Multi-TF trades</span><b>${state.trades.filter(t => t.category === 'Multi-timeframe').length}</b></div>`;

  renderCount($('reasonCount'), r, cache);

  const pairMap = {};

  r.forEach(t => (pairMap[t.pair] ??= []).push(t));

  const best = Object.entries(pairMap)
    .sort((a, b) => winRate(b[1]) - winRate(a[1]))[0];

  $('bestPair').innerHTML = best
    ? `<b>${esc(best[0])}</b>
       <div class="muted">${winRate(best[1]).toFixed(1)}% win rate · ${best[1].length} trades · ${sampleLabel(best[1].length)}</div>`
    : '<span class="muted">No pair data yet.</span>';

  const comboMap = {};

  r.forEach(t => {
    const k = [...reasonsOf(t, cache)].sort().join(' + ') || 'No reasons';
    (comboMap[k] ??= []).push(t);
  });

  const top = Object.entries(comboMap)
    .sort((a, b) => winRate(b[1]) - winRate(a[1]))[0];

  $('topSetup').innerHTML = top
    ? `<b>${esc(top[0])}</b>
       <div class="muted">${winRate(top[1]).toFixed(1)}% win rate · ${top[1].length} trades · ${sampleLabel(top[1].length)}</div>`
    : '<span class="muted">No setup data yet.</span>';

  updateBalance();
}

function renderCount(elNode, arr, cache) {
  const groups = {};

  arr.forEach(t => {
    const n = (t.reasonIds || []).length;
    (groups[n] ??= []).push(t);
  });

  const keys = Object.keys(groups).sort((a, b) => a - b);

  elNode.innerHTML = keys.length
    ? keys.map(k =>
        `<div style="margin:12px 0">
          <div class="row between">
            <span>${k} reason${k === '1' ? '' : 's'} · ${groups[k].length} trades</span>
            <b>${winRate(groups[k]).toFixed(1)}%</b>
          </div>
          <div class="bar"><i style="width:${winRate(groups[k])}%"></i></div>
        </div>`
      ).join('')
    : '<div class="empty">No resolved trades to analyze yet.</div>';
}

/* ---------- history ---------- */

function renderHistory() {
  const q = ($('historySearch')?.value || '').trim().toLowerCase();
  const pair = $('historyPairFilter')?.value || 'ALL';
  const direction = $('historyDirectionFilter')?.value || 'ALL';
  const entryTf = $('historyEntryTfFilter')?.value || 'ALL';
  const session = $('historySessionFilter')?.value || 'ALL';
  const from = $('historyFromDate')?.value || '';
  const to = $('historyToDate')?.value || '';
  const cache = new Map();

  // Keep the pair list synchronized with the trades without resetting the user's choice.
  const pairSelect = $('historyPairFilter');
  if (pairSelect) {
    const selected = pairSelect.value || 'ALL';
    const pairs = [...new Set(state.trades.map(t => t.pair).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    pairSelect.innerHTML = '<option value="ALL">All pairs</option>' +
      pairs.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    pairSelect.value = pairs.includes(selected) ? selected : 'ALL';
  }

  const arr = [...state.trades]
    .filter(t => state.historyFilter === 'ALL' || t.result === state.historyFilter)
    .filter(t => pair === 'ALL' || t.pair === pair)
    .filter(t => direction === 'ALL' || t.direction === direction)
    .filter(t => entryTf === 'ALL' || (entryTf === 'NONE' ? !t.entryTimeframe : t.entryTimeframe === entryTf))
    .filter(t => session === 'ALL' || t.session === session)
    .filter(t => !from || String(t.date || '').slice(0, 10) >= from)
    .filter(t => !to || String(t.date || '').slice(0, 10) <= to)
    .filter(t => !q || [t.pair, t.notes, ...reasonsOf(t, cache)]
      .join(' ').toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt);

  $('historyTable').innerHTML = arr.length
    ? `<div class="tablewrap">
        <table>
          <thead><tr>
            <th>Date</th><th>Pair</th><th>Dir</th><th>Entry TF</th>
            <th>Result</th><th>Reasons</th><th>Cat</th><th>Screenshots</th><th>P/L</th><th>Actions</th>
          </tr></thead>
          <tbody>${arr.map(t =>
            `<tr>
              <td>${esc(new Date(t.date).toLocaleString())}</td>
              <td>${esc(t.pair)}</td>
              <td>${esc(t.direction)}</td>
              <td>${esc(t.entryTimeframe || '—')}</td>
              <td><span class="pill ${t.result.toLowerCase()}">${esc(t.result)}</span></td>
              <td>${reasonsOf(t, cache).length}</td>
              <td>${t.category === 'Multi-timeframe' ? 'Multi-TF' : 'Single-TF'}</td>
              <td>${renderScreenshotThumbs(t)}</td>
              <td class="${pnl(t) > 0 ? 'green' : pnl(t) < 0 ? 'red' : ''}">${money(pnl(t))}</td>
              <td>
                <button class="btn small" data-action="edit" data-id="${esc(t.id)}">✎</button>
                <button class="btn small danger" data-action="delete" data-id="${esc(t.id)}">×</button>
              </td>
            </tr>`
          ).join('')}
          </tbody>
        </table>
      </div>`
    : '<div class="empty">No trades match those filters. Try clearing one or more filters.</div>';
}
/* ---------- multi-timeframe ---------- */

function renderMulti() {
  const a = state.trades.filter(t => t.category === 'Multi-timeframe');
  const r = a.filter(t => ['WIN', 'LOSS', 'DRAW'].includes(t.result));
  const profit = r.reduce((s, t) => s + pnl(t), 0);

  $('multiStats').innerHTML = [
    ['Total trades', a.length],
    ['Resolved', r.length],
    ['Win rate', winRate(r).toFixed(1) + '%'],
    ['Net P/L', money(profit)]
  ].map(([l, v]) =>
    `<div class="mini"><span class="muted">${esc(l)}</span><b>${esc(v)}</b></div>`
  ).join('');

  const cache = new Map();

  $('multiHistory').innerHTML = a.length

    ? `<div class="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Pair</th>
              <th>Entry TF</th>
              <th>Analysis timeframes</th>
              <th>Reasons</th>
              <th>Screenshots</th>
              <th>Result</th>
              <th>P/L</th>
              <th>Edit</th>
            </tr>
          </thead>
          <tbody>
            ${a.slice()
              .sort((x, y) => y.createdAt - x.createdAt)
              .map(t =>
                `<tr>
                  <td>${esc(new Date(t.date).toLocaleString())}</td>
                  <td>${esc(t.pair)}</td>
                  <td>${esc(t.entryTimeframe || 'Not recorded')}</td>
                  <td>${esc((t.timeframes || []).join(' + '))}</td>
                  <td>${reasonsOf(t, cache).length}</td>
                  <td>${renderScreenshotThumbs(t)}</td>
                  <td><span class="pill ${t.result.toLowerCase()}">${esc(t.result)}</span></td>
                  <td class="${pnl(t) >= 0 ? 'green' : 'red'}">${money(pnl(t))}</td>
                  <td><button class="btn small" data-action="edit" data-id="${esc(t.id)}">✎</button></td>
                </tr>`
              ).join('')}
          </tbody>
        </table>
      </div>`
    : '<div class="empty">No multi-timeframe trades yet. Select "Multi-timeframe" when logging a trade.</div>';
}

/* ---------- analytics ---------- */

function profitFactor(a) {
  const w = a.filter(t => pnl(t) > 0)
    .reduce((s, t) => s + pnl(t), 0);

  const l = Math.abs(
    a.filter(t => pnl(t) < 0)
      .reduce((s, t) => s + pnl(t), 0)
  );

  return l ? (w / l).toFixed(2) : w ? '∞' : '—';
}

function avgOf(a, result) {
  const x = a.filter(t => t.result === result);

  return x.length
    ? x.reduce((s, t) => s + Math.abs(pnl(t)), 0) / x.length
    : 0;
}

function renderDailyTradePerformance() {
  const days = new Map();

  state.trades.forEach(t => {
    // Trade date is stored as a local datetime-local value (YYYY-MM-DDTHH:mm).
    const date = String(t.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(t);
  });

  const groups = new Map([
    ['1 trade', []],
    ['2 trades', []],
    ['3 trades', []],
    ['4 trades', []],
    ['5+ trades', []]
  ]);

  days.forEach(trades => {
    const count = trades.length;
    const label = count >= 5 ? '5+ trades' : `${count} ${count === 1 ? 'trade' : 'trades'}`;
    groups.get(label).push(trades);
  });

  const rows = [...groups.entries()]
    .filter(([, dayGroups]) => dayGroups.length)
    .map(([label, dayGroups]) => {
      const completed = dayGroups.flat().filter(t =>
        ['WIN', 'LOSS', 'DRAW'].includes(t.result)
      );
      const decisive = completed.filter(t => t.result === 'WIN' || t.result === 'LOSS');
      const totalPL = completed.reduce((sum, t) => sum + pnl(t), 0);
      const avgDailyPL = totalPL / dayGroups.length;
      const tradeCount = dayGroups.reduce((sum, day) => sum + day.length, 0);

      return {
        label,
        days: dayGroups.length,
        tradeCount,
        resolvedCount: completed.length,
        winRate: winRate(decisive),
        avgDailyPL,
        totalPL
      };
    });

  const target = $('dailyTradePerformance');
  if (!target) return;

  target.innerHTML = rows.length
    ? `<div class="tablewrap">
        <table>
          <thead><tr>
            <th>Trades/day</th><th>Days</th><th>Total trades</th>
            <th>Resolved</th><th>Win rate</th><th>Avg daily P/L</th><th>Total P/L</th>
          </tr></thead>
          <tbody>${rows.map(r => `
            <tr>
              <td>${esc(r.label)}</td>
              <td>${r.days}</td>
              <td>${r.tradeCount}</td>
              <td>${r.resolvedCount}</td>
              <td>${r.resolvedCount ? r.winRate.toFixed(1) + '%' : '—'}</td>
              <td class="${r.avgDailyPL >= 0 ? 'green' : 'red'}">${money(r.avgDailyPL)}</td>
              <td class="${r.totalPL >= 0 ? 'green' : 'red'}">${money(r.totalPL)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : '<div class="empty">Log trades on different days to compare daily performance.</div>';
}

function renderAnalytics() {
  const r = resolved();
  const cache = new Map();

  $('analyticsTop').innerHTML = [
    ['Profit factor', profitFactor(r)],
    ['Average win', money(avgOf(r, 'WIN'))],
    ['Average loss', money(avgOf(r, 'LOSS'))]
  ].map(([l, v]) =>
    `<div class="mini"><span class="muted">${esc(l)}</span><b>${esc(v)}</b></div>`
  ).join('');

  renderDailyTradePerformance();
  renderCount($('byCount'), r, cache);

  $('byCategory').innerHTML = [
    'Single-timeframe',
    'Multi-timeframe'
  ].map(c => {
    const a = r.filter(t => t.category === c);

    return `<div style="margin:13px 0">
      <div class="row between">
        <span>${esc(c)} (${a.length})</span>
        <b>${winRate(a).toFixed(1)}%</b>
      </div>
      <div class="bar"><i style="width:${winRate(a)}%"></i></div>
    </div>`;
  }).join('');

  const comboMap = {};

  r.forEach(t => {
    const k = [...reasonsOf(t, cache)].sort().join(' + ') || 'No reasons';
    (comboMap[k] ??= []).push(t);
  });

  const combos = Object.entries(comboMap)
    .sort((a, b) => b[1].length - a[1].length);

  $('byCombo').innerHTML = combos.length
    ? `<div class="tablewrap">
        <table>
          <thead><tr><th>Exact combination</th><th>Trades</th><th>Win rate</th><th>Net P/L</th></tr></thead>
          <tbody>
            ${combos.map(([k, a]) =>
              `<tr>
                <td>${esc(k)}</td>
                <td>${a.length}</td>
                <td>${winRate(a).toFixed(1)}%</td>
                <td>${money(a.reduce((s, t) => s + pnl(t), 0))}</td>
              </tr>`
            ).join('')}
          </tbody>
        </table>
      </div>`
    : '<div class="empty">No resolved trades yet.</div>';

  const dims = [
    ['Currency pair', t => t.pair],
    ['Session', t => t.session],
    ['Direction', t => t.direction],
    ['Market condition', t => t.condition]
  ];

  $('dimensions').innerHTML = dims.map(([label, get]) => {
    const m = {};

    r.forEach(t => (m[get(t)] ??= []).push(t));

    const rows = Object.entries(m).map(([k, a]) =>
      `<div class="row between" style="padding:5px 0">
        <span>${esc(k)} · ${a.length} trades</span>
        <b>${winRate(a).toFixed(1)}%</b>
      </div>`
    ).join('');

    return `<h4>${esc(label)}</h4>${rows || '<span class="muted">No data</span>'}`;
  }).join('<hr style="border-color:#20344d">');

  const individual = {};

  r.forEach(t =>
    (t.reasonIds || []).forEach(id =>
      (individual[id] ??= []).push(t)
    )
  );

  $('individualReasons').innerHTML = Object.keys(individual).length
    ? Object.entries(individual).map(([id, a]) => {
        const nm =
          reasonById(id)?.name ||
          a[0].reasonNames?.[id] ||
          'Archived reason';

        return `<div style="margin:10px 0">
          <div class="row between">
            <span>${esc(nm)} · ${a.length} trades</span>
            <b>${winRate(a).toFixed(1)}%</b>
          </div>
          <div class="bar"><i style="width:${winRate(a)}%"></i></div>
        </div>`;
      }).join('')
    : '<span class="muted">No reason data yet.</span>';

  const tf = {};

  r.forEach(t =>
    (t.timeframes || []).forEach(k =>
      (tf[k] ??= []).push(t)
    )
  );

  const entryTf = {};
  r.forEach(t => {
    if (t.entryTimeframe) (entryTf[t.entryTimeframe] ??= []).push(t);
  });

  const analysisTfHtml = Object.keys(tf).length
    ? Object.entries(tf)
        .sort((a, b) => TIMEFRAMES.indexOf(a[0]) - TIMEFRAMES.indexOf(b[0]))
        .map(([k, a]) =>
          `<div class="row between" style="padding:6px 0">
            <span>${esc(k)} · ${a.length} trades</span>
            <b>${winRate(a).toFixed(1)}%</b>
          </div>`
        ).join('')
    : '<span class="muted">No analysis timeframe data yet.</span>';

  const entryTfHtml = Object.keys(entryTf).length
    ? Object.entries(entryTf)
        .sort((a, b) => TIMEFRAMES.indexOf(a[0]) - TIMEFRAMES.indexOf(b[0]))
        .map(([k, a]) =>
          `<div class="row between" style="padding:6px 0">
            <span>${esc(k)} · ${a.length} entries</span>
            <b>${winRate(a).toFixed(1)}%</b>
          </div>`
        ).join('')
    : '<span class="muted">No actual entry timeframe data yet.</span>';

  $('timeframeStats').innerHTML =
    '<h4>Analysis timeframes</h4>' + analysisTfHtml +
    '<hr style="border-color:#20344d;margin:12px 0">' +
    '<h4>Actual entry timeframe</h4>' + entryTfHtml;

  const avgRating = key => {
    const a = r.filter(t => Number(t[key]) > 0);

    return a.length
      ? (a.reduce((s, t) => s + Number(t[key]), 0) / a.length).toFixed(1) + ' / 10'
      : '—';
  };

  $('qualityStats').innerHTML =
    `<div class="row between">
      <span>Average setup quality</span>
      <b>${esc(avgRating('setupQuality'))}</b>
    </div>` +
    `<div class="row between" style="margin-top:10px">
      <span>Average execution quality</span>
      <b>${esc(avgRating('executionQuality'))}</b>
    </div>`;

  let streak = 0;
  let maxStreak = 0;

  [...r].sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(t => {
    if (t.result === 'LOSS') {
      streak++;
      maxStreak = Math.max(maxStreak, streak);
    } else {
      streak = 0;
    }
  });

  const avgRisk = r.length
    ? r.reduce((s, t) => s + num(t.risk), 0) / r.length
    : 0;

  $('riskStats').innerHTML =
    `<div class="row between">
      <span>Longest consecutive losing streak</span>
      <b>${maxStreak}</b>
    </div>` +
    `<div class="row between" style="margin-top:10px">
      <span>Average amount risked</span>
      <b>${money(avgRisk)}</b>
    </div>`;
}

/* ---------- setups ---------- */

function renderSetups() {
  const cache = new Map();
  const groups = {};

  resolved().forEach(t => {
    const ids = [...(t.reasonIds || [])].sort();
    const key = ids.join('|') || 'No reasons';

    if (!groups[key]) {
      groups[key] = {
        name: [...reasonsOf(t, cache)].sort().join(' + ') || 'No reasons',
        trades: []
      };
    }

    groups[key].trades.push(t);
  });

  const arr = Object.values(groups)
    .sort((a, b) => b.trades.length - a.trades.length);

  $('setupCards').innerHTML = arr.length
    ? arr.map(g => {
        const wr = winRate(g.trades);
        const wins = g.trades.filter(t => t.result === 'WIN').length;
        const losses = g.trades.filter(t => t.result === 'LOSS').length;
        const draws = g.trades.filter(t => t.result === 'DRAW').length;

        return `<div class="setup-card">
          <div>
            <b>${esc(g.name)}</b>
            <small class="muted">${g.trades.length} trades · ${wins}W / ${losses}L / ${draws}D · ${sampleLabel(g.trades.length)}</small>
          </div>
          <div class="ring">${wr.toFixed(1)}%</div>
          <div class="trades muted">${g.trades.length}</div>
        </div>`;
      }).join('')
    : '<div class="empty">Log trades with reasons selected to build your setup library.</div>';
}

/* ---------- settings & reasons & transactions ---------- */

function loadSettingsUI() {
  $('startingBalance').value = state.settings.startingBalance ?? 70;
  $('defaultPayout').value = state.settings.defaultPayout ?? 80;
  $('currency').value = state.settings.currency || 'USD';
  $('defaultSession').value = state.settings.defaultSession || 'New York';
}

function renderReasons() {
  $('reasonList').innerHTML = state.reasons.map(r =>
    `<div class="row between" style="padding:9px;border-bottom:1px solid #20344d">
      <span>${esc(r.name)} ${r.active ? '' : '<span class="muted">(archived)</span>'}</span>
      <span>
        <button class="btn small" type="button" data-action="rename-reason" data-id="${esc(r.id)}">Rename</button>
        <button class="btn small" type="button" data-action="archive-reason" data-id="${esc(r.id)}">${r.active ? 'Archive' : 'Reactivate'}</button>
      </span>
    </div>`
  ).join('') || '<div class="empty">No reasons yet.</div>';
}

function renderTx() {
  $('txList').innerHTML = state.transactions.length
    ? [...state.transactions].reverse().map(t => {
        const effect = transactionEffect(t);
        const sign = effect < 0 ? '−' : '+';
        return `<div class="row between" style="padding:8px;border-bottom:1px solid #20344d;gap:8px">
          <span style="min-width:0;flex:1">
            <b>${esc(transactionDisplayType(t))}</b> · ${esc(t.date)}<br>
            <small class="muted">${esc(transactionDisplayNote(t) || 'No note')}</small>
          </span>
          <b class="${effect < 0 ? 'red' : 'green'}">${sign}${money(Math.abs(effect))}</b>
          <button type="button" class="btn small danger" data-action="delete-transaction" data-id="${esc(t.id)}" aria-label="Delete transaction">×</button>
        </div>`;
      }).join('')
    : '<div class="empty">No account transactions recorded.</div>';
}

async function deleteTransaction(id) {
  const transaction = state.transactions.find(t => t.id === id);
  if (!transaction) return;
  if (!confirm(`Delete this ${transactionDisplayType(transaction).toLowerCase()} of ${money(transaction.amount)}? The account balance will be recalculated.`)) return;
  try {
    await S.deleteTransaction(id);
    state.transactions = state.transactions.filter(t => t.id !== id);
    renderTx();
    updateBalance();
  } catch (err) {
    showError('Could not delete transaction: ' + err.message);
  }
}

function updateBalance() {
  const start = num(state.settings.startingBalance, 70);
  const tradePL = resolved().reduce((s, t) => s + pnl(t), 0);

  const txTotal = state.transactions.reduce(
    (s, t) => s + transactionEffect(t),
    0
  );

  const balance = start + tradePL + txTotal;

  $('accountBalance').textContent = money(balance);

  $('balanceChange').textContent =
    (balance - start >= 0 ? '▲ +' : '▼ ') +
    money(balance - start) +
    ' since starting balance';
}

/* ---------- render all ---------- */

function renderAll() {
  loadSettingsUI();
  renderChecks();
  renderDashboard();
  renderHistory();
  renderMulti();
  renderAnalytics();
  renderSetups();
  renderReasons();
  renderTx();
}

/* ---------- form ---------- */

function nowLocalInput() {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function setTradeDirection(value) {
  const direction = value === 'PUT' ? 'PUT' : 'CALL';
  $('direction').value = direction;
  document.querySelectorAll('[data-direction]').forEach(button => {
    button.classList.toggle('active', button.dataset.direction === direction);
  });
}

function setTradeResult(value) {
  $('result').value = value;
  document.querySelectorAll('[data-result]').forEach(button => {
    button.classList.toggle('active', button.dataset.result === value);
  });
}

function clearForm() {
  $('tradeForm').reset();
  $('tradeDate').value = nowLocalInput();
  $('session').value = state.settings.defaultSession || 'New York';
  $('editId').value = '';
  $('formTitle').textContent = 'Log a Trade';
  $('payout').value = state.settings.defaultPayout ?? 80;
  setTradeDirection('CALL');
  setTradeResult('WIN');

  state.pendingShots = [];

  $('shotMeta').innerHTML = '';

  renderChecks();
}

function renderShotMeta() {
  $('shotMeta').innerHTML = state.pendingShots.map((s, i) =>
    `<div class="mini" style="margin-top:8px">
      <div class="row between">
        <b>${esc(s.name)}</b>
        <button type="button" class="btn small danger" data-action="remove-shot" data-idx="${i}">Remove</button>
      </div>

      <div class="formgrid">
        <div class="field">
          <label>Screenshot timeframe</label>
          <select data-action="shot-tf" data-idx="${i}">
            <option value="">Select</option>
            ${TIMEFRAMES.map(t =>
              `<option value="${esc(t)}" ${s.tf === t ? 'selected' : ''}>${esc(t)}</option>`
            ).join('')}
          </select>
        </div>

        <div class="field">
          <label>Associated reasons</label>
          <select multiple size="3" data-action="shot-reasons" data-idx="${i}">
            ${state.reasons.filter(r => r.active).map(r =>
              `<option value="${esc(r.id)}" ${s.reasonIds.includes(r.id) ? 'selected' : ''}>${esc(r.name)}</option>`
            ).join('')}
          </select>
        </div>
      </div>

      <img
        data-lightbox
        src="${esc(s.data)}"
        alt="Screenshot preview"
        title="Tap to enlarge"
        style="max-width:160px;max-height:90px;border-radius:7px;cursor:zoom-in"
      >
    </div>`
  ).join('');
}

function readFileAsDataURL(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();

    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);

    r.readAsDataURL(f);
  });
}

/* ---------- save trade ---------- */

async function saveTrade(e) {
  e.preventDefault();

  if (!state.writable) {
    return showError('Storage is not available; cannot save.');
  }

  const id = $('editId').value || U.uid();
  const old = state.trades.find(t => t.id === id);

  // These selections belong only to the trade itself.
  const reasonIds = [
    ...document.querySelectorAll('input[name="reason"]:checked')
  ].map(x => x.value);

  const tfs = [
    ...document.querySelectorAll('input[name="tf"]:checked')
  ].map(x => x.value);

  // IMPORTANT:
  // Screenshot timeframe and reason selections stay on each screenshot.
  // They are deliberately NOT merged into trade-level timeframes/reasons.

  const reasonNames = {};

  state.reasons.forEach(r => {
    reasonNames[r.id] = r.name;
  });

  state.pendingShots.forEach(s => {
    (s.reasonIds || []).forEach(rid => {
      const r = reasonById(rid);
      if (r) reasonNames[rid] = r.name;
    });
  });

  const trade = U.sanitizeTrade({
    id,
    pair: $('pair').value,
    date: $('tradeDate').value,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    direction: $('direction').value,
    result: $('result').value,
    risk: $('risk').value,
    payout: $('payout').value,
    confidence: $('confidence').value,
    session: $('session').value,
    condition: $('condition').value,
    category: $('category').value,
    entryTimeframe: $('entryTimeframe').value,
    setupQuality: $('setupQuality').value,
    executionQuality: $('executionQuality').value,
    reasonIds,
    timeframes: tfs,
    screenshots: state.pendingShots,
    notes: $('notes').value,
    createdAt: old?.createdAt || Date.now(),
    updatedAt: Date.now(),
    reasonNames
  }, new Set(state.reasons.map(r => r.id)));

  try {
    await S.putTrade(trade);
  } catch (err) {
    return showError('Could not save trade: ' + err.message);
  }

  if (old) {
    state.trades = state.trades.map(x => x.id === id ? trade : x);
  } else {
    state.trades.push(trade);
  }

  clearForm();
  renderAll();
  nav('history');
}

function editTrade(id) {
  const t = state.trades.find(x => x.id === id);
  if (!t) return;

  nav('log');

  $('editId').value = id;
  $('formTitle').textContent = 'Edit Trade';

  [
    'pair',
    'direction',
    'result',
    'risk',
    'payout',
    'confidence',
    'session',
    'condition',
    'category',
    'entryTimeframe',
    'setupQuality',
    'executionQuality',
    'notes'
  ].forEach(k => {
    if (k !== 'result') $(k).value = t[k] ?? '';
  });
  setTradeDirection(t.direction || 'CALL');
  setTradeResult(t.result || 'OPEN');

  $('tradeDate').value = t.date;

  renderChecks();

  document.querySelectorAll('input[name="reason"]').forEach(x => {
    x.checked = (t.reasonIds || []).includes(x.value);
  });

  document.querySelectorAll('input[name="tf"]').forEach(x => {
    x.checked = (t.timeframes || []).includes(x.value);
  });

  state.pendingShots = Array.isArray(t.screenshots)
    ? t.screenshots.map(s => ({
        ...s,
        reasonIds: Array.isArray(s.reasonIds) ? [...s.reasonIds] : []
      }))
    : [];

  renderShotMeta();
}

async function deleteTrade(id) {
  if (!confirm('Delete this trade and its screenshots?')) return;

  try {
    await S.deleteTrade(id);
    state.trades = state.trades.filter(t => t.id !== id);
    renderAll();
  } catch (err) {
    showError('Could not delete: ' + err.message);
  }
}

/* ---------- settings save ---------- */

async function saveSettings() {
  const s = U.sanitizeSettings({
    startingBalance: $('startingBalance').value,
    defaultPayout: $('defaultPayout').value,
    currency: $('currency').value,
    defaultSession: $('defaultSession').value
  });

  try {
    await S.putSettings(s);
    state.settings = s;
    renderAll();
    alert('Preferences saved.');
  } catch (err) {
    showError('Could not save settings: ' + err.message);
  }
}

/* ---------- reasons add/rename/archive ---------- */

async function addReason(e) {
  e.preventDefault();

  const name = $('newReason').value.trim();

  if (!name) return;

  if (
    state.reasons.some(
      r => r.name.toLowerCase() === name.toLowerCase()
    )
  ) {
    return alert('That reason already exists.');
  }

  const r = U.sanitizeReason({
    id: U.uid(),
    name,
    active: true
  });

  try {
    await S.putReason(r);
    state.reasons.push(r);
    $('newReason').value = '';
    renderAll();
  } catch (err) {
    showError('Could not add reason: ' + err.message);
  }
}

async function renameReason(id) {
  const r = reasonById(id);
  if (!r) return;

  const n = prompt('Rename reason', r.name);
  if (!n || !n.trim()) return;

  const next = U.sanitizeReason({
    ...r,
    name: n.trim()
  });

  try {
    await S.putReason(next);
    r.name = next.name;

    const updates = [];

    state.trades.forEach(t => {
      const usedOnTrade = (t.reasonIds || []).includes(id);
      const usedOnScreenshot = (t.screenshots || []).some(
        s => (s.reasonIds || []).includes(id)
      );

      if (usedOnTrade || usedOnScreenshot) {
        t.reasonNames = t.reasonNames || {};
        t.reasonNames[id] = next.name;
        t.updatedAt = Date.now();
        updates.push(S.putTrade(t));
      }
    });

    await Promise.all(updates);

    renderAll();
  } catch (err) {
    showError('Could not rename: ' + err.message);
  }
}

async function archiveReason(id) {
  const r = reasonById(id);
  if (!r) return;

  const next = {
    ...r,
    active: !r.active
  };

  try {
    await S.putReason(next);
    r.active = next.active;
    renderAll();
  } catch (err) {
    showError('Could not update reason: ' + err.message);
  }
}

/* ---------- transactions ---------- */

async function addTransaction(e) {
  e.preventDefault();

  const selectedType = $('txType').value;
  const decrease = selectedType === 'Adjustment (Decrease)';

  // Storage accepts only Deposit, Withdrawal, or Adjustment.
  // The marker preserves the decrease distinction without changing storage.js.
  const tx = U.sanitizeTransaction({
    id: U.uid(),
    type: decrease ? 'Adjustment' : selectedType,
    amount: $('txAmount').value,
    date: $('txDate').value,
    note: (decrease ? DECREASE_ADJUSTMENT_MARKER : '') +
      $('txNote').value
  });

  try {
    await S.putTransaction(tx);
    state.transactions.push(tx);
    $('txForm').reset();
    renderTx();
    updateBalance();
  } catch (err) {
    showError('Could not add transaction: ' + err.message);
  }
}

/* ---------- backup ---------- */

async function exportBackup() {
  try {
    const payload = await S.exportAll();

    const blob = new Blob(
      [JSON.stringify(payload, null, 2)],
      { type: 'application/json' }
    );

    const a = document.createElement('a');

    a.href = URL.createObjectURL(blob);
    a.download =
      'jarvis-backup-' +
      new Date().toISOString().slice(0, 10) +
      '.json';

    a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    showError('Export failed: ' + err.message);
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  return '"' + text.replace(/"/g, '""') + '"';
}

async function exportTradesCsv() {
  try {
    const cache = new Map();
    const headers = [
      'Date and Time','Currency Pair','Direction','Result','Actual Entry Timeframe',
      'Analysis Timeframes','Risk Amount','Payout Percent','Profit/Loss','Session',
      'Market Condition','Trade Category','Setup Quality','Execution Quality',
      'Reasons','Notes','Screenshot Count'
    ];
    const rows = [...state.trades]
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map(t => [
        t.date, t.pair, t.direction, t.result, t.entryTimeframe || '',
        (t.timeframes || []).join(' + '), num(t.risk), num(t.payout), Number(pnl(t).toFixed(8)),
        t.session, t.condition, t.category, t.setupQuality ?? '', t.executionQuality ?? '',
        reasonsOf(t, cache).join(' + '), t.notes || '', (t.screenshots || []).length
      ]);
    const csv = '\ufeff' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jarvis-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showError('Could not export trade data: ' + err.message);
  }
}

async function importBackup(e) {
  const f = e.target.files[0];
  if (!f) return;

  try {
    const text = await f.text();

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('File is not valid JSON.');
    }

    if (
      !parsed ||
      (parsed.app !== 'Jarvis' && parsed.app !== 'King of Snipers')
    ) {
      throw new Error('Not a Jarvis/King of Snipers backup.');
    }

    if (!parsed.data || !Array.isArray(parsed.data.trades)) {
      throw new Error('Backup has no trade data.');
    }

    if (
      !confirm(
        'Restore this backup? Current journal data will be replaced.'
      )
    ) {
      return;
    }

    await S.importAll(parsed.data, { skipValidate: false });

    await reloadState();
    renderAll();

    alert('Backup restored.');
  } catch (err) {
    showError('Could not restore: ' + err.message);
  } finally {
    e.target.value = '';
  }
}

/* ---------- lightbox ---------- */

let lbScale = 1;
let lbX = 0;
let lbY = 0;
let lbDragging = false;
let lbStart = null;

function openLightbox(src) {
  const lb = $('lightbox');
  const img = $('lbImg');

  img.src = src;

  lbScale = 1;
  lbX = 0;
  lbY = 0;

  img.style.transform = 'translate(0,0) scale(1)';

  lb.classList.add('show');
}

function closeLightbox() {
  $('lightbox').classList.remove('show');
  $('lbImg').src = '';
}

function applyLightboxTransform() {
  $('lbImg').style.transform =
    `translate(${lbX}px,${lbY}px) scale(${lbScale})`;
}

/* ---------- event wiring ---------- */

function bindEvents() {
  $('nav').addEventListener('click', e => {
    const b = e.target.closest('button[data-page]');
    if (b) nav(b.dataset.page);
  });

  document.body.addEventListener('click', e => {
    const goto = e.target.closest('[data-goto]');
    if (goto) nav(goto.dataset.goto);
  });

  $('tradeForm').addEventListener('submit', saveTrade);
  document.querySelectorAll('[data-direction]').forEach(button => {
    button.addEventListener('click', () => setTradeDirection(button.dataset.direction));
  });
  document.querySelectorAll('[data-result]').forEach(button => {
    button.addEventListener('click', () => setTradeResult(button.dataset.result));
  });
  $('clearForm').addEventListener('click', clearForm);
  $('cancelEdit').addEventListener('click', clearForm);

  $('screenshots').addEventListener('change', async e => {
    const files = [...e.target.files];

    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;

      try {
        const data = await readFileAsDataURL(f);

        if (!U.isDataImage(data)) continue;

        state.pendingShots.push({
          name: f.name,
          data,
          tf: '',
          reasonIds: []
        });
      } catch {
        // Skip unreadable files.
      }
    }

    renderShotMeta();

    // Allow selecting the same file again after removing it.
    e.target.value = '';
  });

  document.body.addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;

    const { action, id, idx } = btn.dataset;

    if (action === 'edit') {
      editTrade(id);
    } else if (action === 'delete') {
      deleteTrade(id);
    } else if (action === 'delete-transaction') {
      deleteTransaction(id);
    } else if (action === 'remove-shot') {
      state.pendingShots.splice(Number(idx), 1);
      renderShotMeta();
    } else if (action === 'rename-reason') {
      renameReason(id);
    } else if (action === 'archive-reason') {
      archiveReason(id);
    }
  });

  $('shotMeta').addEventListener('change', e => {
    const t = e.target;

    if (t.matches('select[data-action="shot-tf"]')) {
      const i = Number(t.dataset.idx);
      if (state.pendingShots[i]) {
        state.pendingShots[i].tf = t.value;
      }
    } else if (t.matches('select[data-action="shot-reasons"]')) {
      const i = Number(t.dataset.idx);

      if (state.pendingShots[i]) {
        state.pendingShots[i].reasonIds = [
          ...t.selectedOptions
        ].map(o => o.value);
      }
    }
  });

  let searchTimer = null;

  $('historySearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderHistory, 150);
  });

  ['historyPairFilter','historyDirectionFilter','historyEntryTfFilter','historySessionFilter','historyFromDate','historyToDate']
    .forEach(id => $(id).addEventListener('change', renderHistory));

  $('clearHistoryFilters').addEventListener('click', () => {
    ['historyPairFilter','historyDirectionFilter','historyEntryTfFilter','historySessionFilter'].forEach(id => { $(id).value = 'ALL'; });
    $('historyFromDate').value = '';
    $('historyToDate').value = '';
    $('historySearch').value = '';
    state.historyFilter = 'ALL';
    document.querySelectorAll('#historyTabs button').forEach(x => x.classList.toggle('active', x.dataset.filter === 'ALL'));
    renderHistory();
  });

  $('historyTabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;

    state.historyFilter = b.dataset.filter;

    document.querySelectorAll('#historyTabs button').forEach(x => {
      x.classList.toggle('active', x === b);
    });

    renderHistory();
  });

  // One delegated handler supports uploaded previews and history thumbnails.
  document.body.addEventListener('click', e => {
    const img = e.target.closest('img[data-lightbox]');
    if (img) openLightbox(img.getAttribute('src'));
  });

  $('saveSettings').addEventListener('click', saveSettings);
  $('reasonForm').addEventListener('submit', addReason);
  $('txForm').addEventListener('submit', addTransaction);

  $('exportBtn').addEventListener('click', exportBackup);
  $('exportCsvBtn').addEventListener('click', exportTradesCsv);
  $('importFile').addEventListener('change', importBackup);

  $('lbClose').addEventListener('click', closeLightbox);

  $('lightbox').addEventListener('click', e => {
    if (e.target === $('lightbox')) closeLightbox();
  });

  $('lightbox').addEventListener('wheel', e => {
    e.preventDefault();

    lbScale = clamp(
      lbScale * (e.deltaY < 0 ? 1.1 : 0.9),
      0.5,
      6
    );

    applyLightboxTransform();
  }, { passive: false });

  $('lightbox').addEventListener('pointerdown', e => {
    if (e.target !== $('lbImg')) return;

    lbDragging = true;

    lbStart = {
      x: e.clientX - lbX,
      y: e.clientY - lbY
    };

    $('lbImg').setPointerCapture(e.pointerId);
  });

  $('lightbox').addEventListener('pointermove', e => {
    if (!lbDragging) return;

    lbX = e.clientX - lbStart.x;
    lbY = e.clientY - lbStart.y;

    applyLightboxTransform();
  });

  $('lightbox').addEventListener('pointerup', () => {
    lbDragging = false;
  });

  $('lightbox').addEventListener('pointercancel', () => {
    lbDragging = false;
  });

  let lastTap = 0;

  $('lightbox').addEventListener('touchend', () => {
    const now = Date.now();

    if (now - lastTap < 300) {
      lbScale = lbScale > 1 ? 1 : 2;

      if (lbScale === 1) {
        lbX = 0;
        lbY = 0;
      }

      applyLightboxTransform();
    }

    lastTap = now;
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLightbox();
  });
}
/* ---------- load storage ---------- */

async function reloadState() {
  const [
    trades,
    reasons,
    transactions,
    settings
  ] = await Promise.all([
    S.getAllTrades(),
    S.getAllReasons(),
    S.getAllTransactions(),
    S.getSettings()
  ]);

  state.trades = trades || [];

  state.reasons = (reasons && reasons.length)
    ? reasons
    : DEFAULT_REASONS.map((name, i) =>
        U.sanitizeReason({
          id: 'r' + i,
          name,
          active: true
        })
      );

  state.transactions = transactions || [];

  state.settings = settings || U.sanitizeSettings({});

  if (!reasons || reasons.length === 0) {
    try {
      await S.putReasons(state.reasons);
    } catch {
      // Non-fatal.
    }
  }
}

/* ---------- boot ---------- */

async function boot() {
  ensureAdjustmentOptions();
  bindEvents();

  try {
    await S.init();
    await reloadState();

    setWritable(true);
    clearError();
  } catch (err) {
    setWritable(false);

    showError(
      'Storage could not be opened: ' +
      err.message +
      ' — writes are disabled to protect your data.'
    );
  }

  clearForm();
  renderAll();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('service-worker.js')
        .catch(() => {});
    });
  }
}

/* ---------- application startup ---------- */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

/* ---------- public app interface ---------- */

window.JarvisApp = {
  state,
  nav,
  renderAll,
  saveTrade,
  editTrade,
  deleteTrade,
  exportBackup,
  importBackup
};
