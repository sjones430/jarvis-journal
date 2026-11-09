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
const RISK_MODE = 'per-entry-v1';

const S = window.JarvisStorage;
const U = window.JarvisUtil;
const { num, clamp, safeStr } = U;
const $ = id => document.getElementById(id);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
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

function entryCount(trade) {
  const n = Number.parseInt(trade?.numberEntries, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 99) : 1;
}

function totalRisk(t) {
  const risk = Math.max(0, num(t?.risk));
  return t?.riskMode === RISK_MODE
    ? risk * entryCount(t)
    : risk;
}

function pnl(t) {
  const risk = totalRisk(t);
  if (t.result === 'WIN') return risk * clamp(num(t.payout), 0, 1000) / 100;
  if (t.result === 'LOSS') return -risk;
  return 0;
}

const resolved = () =>
  state.trades.filter(t => ['WIN', 'LOSS', 'DRAW'].includes(t.result));

const winRate = arr => {
  const decisive = arr.filter(t => t.result === 'WIN' || t.result === 'LOSS');
  return decisive.length
    ? decisive.filter(t => t.result === 'WIN').length / decisive.length * 100
    : 0;
};

const reasonById = id => state.reasons.find(r => r.id === id);

function displayDirection(value) {
  const v = String(value || '').toUpperCase();
  return v === 'PUT' || v === 'SELL' ? 'SELL' : 'BUY';
}

function storageDirection(value) {
  return displayDirection(value) === 'SELL' ? 'PUT' : 'CALL';
}

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
  n < 100 ? 'Stronger evidence' : 'Larger sample';
function isDecreaseAdjustment(t) {
  return t && t.type === 'Adjustment' &&
    String(t.note || '').startsWith(DECREASE_ADJUSTMENT_MARKER);
}

function transactionEffect(t) {
  const amount = Math.abs(num(t.amount));
  return t.type === 'Withdrawal' || isDecreaseAdjustment(t) ? -amount : amount;
}

function transactionDisplayType(t) {
  return isDecreaseAdjustment(t) ? 'Adjustment (Decrease)' : t.type;
}

function transactionDisplayNote(t) {
  return String(t.note || '').replace(DECREASE_ADJUSTMENT_MARKER, '').trim();
}

function ensureAdjustmentOptions() {
  const select = $('txType');
  if (!select) return;
  const exists = [...select.options].some(o =>
    o.value === 'Adjustment (Decrease)' || o.textContent === 'Adjustment (Decrease)'
  );
  if (!exists) {
    const option = document.createElement('option');
    option.value = 'Adjustment (Decrease)';
    option.textContent = 'Adjustment (Decrease)';
    select.appendChild(option);
  }
}

function renderScreenshotThumbs(t) {
  const shots = Array.isArray(t.screenshots) ? t.screenshots : [];
  if (!shots.length) return '<span class="muted">—</span>';
  return `<div class="thumbs">
    ${shots.map((s, i) => `
      <img data-lightbox src="${esc(s.data)}" alt="Trade screenshot ${i + 1}"
        title="${esc((s.tf || 'Unspecified timeframe') +
          (s.reasonIds?.length ? ' · ' + s.reasonIds.map(id =>
            reasonById(id)?.name || t.reasonNames?.[id] || 'Archived reason'
          ).join(', ') : ''))}">
    `).join('')}
  </div>`;
}

function showError(msg) {
  const b = $('errorBanner');
  if (!b) { console.error(msg); return; }
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

const TITLES = {
  dashboard: ['Dashboard', 'Your trading performance at a glance.'],
  log: ['Log Trade', 'Record a trade with all its context.'],
  history: ['Trade History', 'Review and edit every recorded trade.'],
  setups: ['Setups', 'See which exact setups perform best.'],
  analytics: ['Analytics', 'Understand what your journal data shows.'],
  settings: ['Settings', 'Account preferences, reasons, and backups.']
};

function nav(page) {
  document.querySelectorAll('.section').forEach(x => x.classList.remove('active'));
  const sec = $(page);
  if (sec) sec.classList.add('active');
  document.querySelectorAll('#nav button').forEach(b =>
    b.classList.toggle('active', b.dataset.page === page)
  );
  const [h, p] = TITLES[page] || ['Jarvis', ''];
  if ($('pageTitle')) $('pageTitle').textContent = h;
  if ($('pageSub')) $('pageSub').textContent = p;
}

function renderChecks() {
  const active = state.reasons.filter(r => r.active);
  $('reasonChecks').innerHTML = active.map(r =>
    `<label class="check"><input type="checkbox" name="reason" value="${esc(r.id)}">${esc(r.name)}</label>`
  ).join('') || '<span class="muted">No active reasons. Add some in Settings.</span>';

  $('tfChecks').innerHTML = TIMEFRAMES.map(t =>
    `<label class="check"><input type="checkbox" name="tf" value="${esc(t)}">${esc(t)}</label>`
  ).join('');
}
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
    `<div class="stat"><label>${esc(label)}</label><strong class="${cls}">${esc(val)}</strong></div>`
  ).join('');

  const cache = new Map();
  const recent = [...state.trades]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 6);

  $('recent').innerHTML = recent.length
    ? `<div class="tablewrap"><table>
        <thead><tr><th>Pair</th><th>Result</th><th>Reasons</th><th>P/L</th></tr></thead>
        <tbody>${recent.map(t => `
          <tr>
            <td>${esc(t.pair)}</td>
            <td><span class="pill ${t.result.toLowerCase()}">${esc(t.result)}</span></td>
            <td>${reasonsOf(t, cache).length}</td>
            <td class="${pnl(t) >= 0 ? 'green' : 'red'}">${money(pnl(t))}</td>
          </tr>`).join('')}
        </tbody></table></div>`
    : '<div class="empty">No trades yet. Log your first trade to begin building your journal.</div>';

  $('snapshot').innerHTML =
    `<div class="mini"><span class="muted">Winning trades</span><b class="green">${wins}</b></div>` +
    `<div class="mini"><span class="muted">Losing trades</span><b class="red">${losses}</b></div>` +
    `<div class="mini"><span class="muted">Multi-TF trades</span><b>${state.trades.filter(t => t.category === 'Multi-timeframe').length}</b></div>`;

  renderCount($('reasonCount'), r, cache);

  const pairMap = {};
  r.forEach(t => (pairMap[t.pair] ??= []).push(t));
  const best = Object.entries(pairMap).sort((a, b) => winRate(b[1]) - winRate(a[1]))[0];

  $('bestPair').innerHTML = best
    ? `<b>${esc(best[0])}</b><div class="muted">${winRate(best[1]).toFixed(1)}% win rate · ${best[1].length} trades · ${sampleLabel(best[1].length)}</div>`
    : '<span class="muted">No pair data yet.</span>';

  const comboMap = {};
  r.forEach(t => {
    const k = [...reasonsOf(t, cache)].sort().join(' + ') || 'No reasons';
    (comboMap[k] ??= []).push(t);
  });
  const top = Object.entries(comboMap).sort((a, b) => winRate(b[1]) - winRate(a[1]))[0];

  $('topSetup').innerHTML = top
    ? `<b>${esc(top[0])}</b><div class="muted">${winRate(top[1]).toFixed(1)}% win rate · ${top[1].length} trades · ${sampleLabel(top[1].length)}</div>`
    : '<span class="muted">No setup data yet.</span>';

  updateBalance();
}

function renderCount(elNode, arr) {
  const groups = {};
  arr.forEach(t => {
    const n = (t.reasonIds || []).length;
    (groups[n] ??= []).push(t);
  });
  const keys = Object.keys(groups).sort((a, b) => a - b);

  elNode.innerHTML = keys.length
    ? keys.map(k => `
        <div style="margin:12px 0">
          <div class="row between">
            <span>${k} reason${k === '1' ? '' : 's'} · ${groups[k].length} trades</span>
            <b>${winRate(groups[k]).toFixed(1)}%</b>
          </div>
          <div class="bar"><i style="width:${winRate(groups[k])}%"></i></div>
        </div>`).join('')
    : '<div class="empty">No resolved trades to analyze yet.</div>';
}

function renderHistory() {
  const q = ($('historySearch')?.value || '').trim().toLowerCase();
  const pair = $('historyPairFilter')?.value || 'ALL';
  const direction = $('historyDirectionFilter')?.value || 'ALL';
  const entryTf = $('historyEntryTfFilter')?.value || 'ALL';
  const session = $('historySessionFilter')?.value || 'ALL';
  const from = $('historyFromDate')?.value || '';
  const to = $('historyToDate')?.value || '';
  const cache = new Map();

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
    .filter(t => direction === 'ALL' || displayDirection(t.direction) === direction)
    .filter(t => entryTf === 'ALL' || (entryTf === 'NONE' ? !t.entryTimeframe : t.entryTimeframe === entryTf))
    .filter(t => session === 'ALL' || t.session === session)
    .filter(t => !from || String(t.date || '').slice(0, 10) >= from)
    .filter(t => !to || String(t.date || '').slice(0, 10) <= to)
    .filter(t => !q || [t.pair, t.notes, ...reasonsOf(t, cache)].join(' ').toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt);

  $('historyTable').innerHTML = arr.length
    ? `<div class="tablewrap"><table>
        <thead><tr>
          <th>Date</th><th>Pair</th><th>Dir</th><th>Entries</th><th>Entry TF</th>
          <th>Result</th><th>Reasons</th><th>Cat</th><th>Screenshots</th><th>P/L</th><th>Actions</th>
        </tr></thead>
        <tbody>${arr.map(t => `
          <tr>
            <td>${esc(new Date(t.date).toLocaleString())}</td>
            <td>${esc(t.pair)}</td>
            <td>${esc(displayDirection(t.direction))}</td>
            <td>${entryCount(t)}</td>
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
          </tr>`).join('')}
        </tbody></table></div>`
    : '<div class="empty">No trades match those filters. Try clearing one or more filters.</div>';
                      }
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
    ? `<div class="tablewrap"><table>
        <thead><tr><th>Date</th><th>Pair</th><th>Entry TF</th><th>Analysis timeframes</th><th>Reasons</th><th>Screenshots</th><th>Result</th><th>P/L</th><th>Edit</th></tr></thead>
        <tbody>${a.slice().sort((x, y) => y.createdAt - x.createdAt).map(t => `
          <tr>
            <td>${esc(new Date(t.date).toLocaleString())}</td>
            <td>${esc(t.pair)}</td>
            <td>${esc(t.entryTimeframe || 'Not recorded')}</td>
            <td>${esc((t.timeframes || []).join(' + '))}</td>
            <td>${reasonsOf(t, cache).length}</td>
            <td>${renderScreenshotThumbs(t)}</td>
            <td><span class="pill ${t.result.toLowerCase()}">${esc(t.result)}</span></td>
            <td class="${pnl(t) >= 0 ? 'green' : 'red'}">${money(pnl(t))}</td>
            <td><button class="btn small" data-action="edit" data-id="${esc(t.id)}">✎</button></td>
          </tr>`).join('')}
        </tbody></table></div>`
    : '<div class="empty">No multi-timeframe trades yet. Select "Multi-timeframe" when logging a trade.</div>';
}

function profitFactor(a) {
  const wins = a.filter(t => pnl(t) > 0).reduce((s, t) => s + pnl(t), 0);
  const losses = Math.abs(a.filter(t => pnl(t) < 0).reduce((s, t) => s + pnl(t), 0));
  return losses ? (wins / losses).toFixed(2) : wins ? '∞' : '—';
}

function avgOf(a, result) {
  const x = a.filter(t => t.result === result);
  return x.length ? x.reduce((s, t) => s + Math.abs(pnl(t)), 0) / x.length : 0;
}

function renderDailyTradePerformance() {
  const days = new Map();
  state.trades.forEach(t => {
    const date = String(t.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(t);
  });

  const groups = new Map([
    ['1 trade', []], ['2 trades', []], ['3 trades', []],
    ['4 trades', []], ['5+ trades', []]
  ]);

  days.forEach(trades => {
    const count = trades.length;
    const label = count >= 5 ? '5+ trades' : `${count} ${count === 1 ? 'trade' : 'trades'}`;
    groups.get(label).push(trades);
  });

  const rows = [...groups.entries()].filter(([, d]) => d.length).map(([label, dayGroups]) => {
    const completed = dayGroups.flat().filter(t => ['WIN', 'LOSS', 'DRAW'].includes(t.result));
    const decisive = completed.filter(t => t.result === 'WIN' || t.result === 'LOSS');
    const totalPL = completed.reduce((sum, t) => sum + pnl(t), 0);
    return {
      label,
      days: dayGroups.length,
      tradeCount: dayGroups.reduce((sum, day) => sum + day.length, 0),
      resolvedCount: completed.length,
      winRate: winRate(decisive),
      avgDailyPL: totalPL / dayGroups.length,
      totalPL
    };
  });

  const target = $('dailyTradePerformance');
  if (!target) return;

  target.innerHTML = rows.length
    ? `<div class="tablewrap"><table>
        <thead><tr><th>Trades/day</th><th>Days</th><th>Total trades</th><th>Resolved</th><th>Win rate</th><th>Avg daily P/L</th><th>Total P/L</th></tr></thead>
        <tbody>${rows.map(r => `
          <tr>
            <td>${esc(r.label)}</td><td>${r.days}</td><td>${r.tradeCount}</td><td>${r.resolvedCount}</td>
            <td>${r.resolvedCount ? r.winRate.toFixed(1) + '%' : '—'}</td>
            <td class="${r.avgDailyPL >= 0 ? 'green' : 'red'}">${money(r.avgDailyPL)}</td>
            <td class="${r.totalPL >= 0 ? 'green' : 'red'}">${money(r.totalPL)}</td>
          </tr>`).join('')}
        </tbody></table></div>`
    : '<div class="empty">Log trades on different days to compare daily performance.</div>';
}

function renderEntryCountPerformance() {
  const groups = new Map();
  state.trades.forEach(t => {
    const count = entryCount(t);
    if (!groups.has(count)) groups.set(count, []);
    groups.get(count).push(t);
  });

  const rows = [...groups.entries()].sort((a, b) => a[0] - b[0]);
  const target = $('entryCountPerformance');
  if (!target) return;

  target.innerHTML = rows.length
    ? `<div class="tablewrap"><table>
        <thead><tr><th>Entries</th><th>Sample</th><th>Wins</th><th>Losses</th><th>Draws</th><th>Open</th><th>Win rate</th><th>Loss rate</th></tr></thead>
        <tbody>${rows.map(([count, trades]) => {
          const wins = trades.filter(t => t.result === 'WIN').length;
          const losses = trades.filter(t => t.result === 'LOSS').length;
          const draws = trades.filter(t => t.result === 'DRAW').length;
          const open = trades.filter(t => t.result === 'OPEN').length;
          const decisive = wins + losses;
          const wr = decisive ? wins / decisive * 100 : 0;
          const lr = decisive ? losses / decisive * 100 : 0;
          return `<tr>
            <td>${count}</td><td>${trades.length}</td>
            <td class="green">${wins}</td><td class="red">${losses}</td>
            <td>${draws}</td><td>${open}</td>
            <td>${decisive ? wr.toFixed(1) + '%' : '—'}</td>
            <td>${decisive ? lr.toFixed(1) + '%' : '—'}</td>
          </tr>`;
        }).join('')}</tbody></table></div>
        <p class="muted" style="font-size:10px;margin:8px 0 0">
          Win and loss rates use wins + losses as the denominator. Draws and open trades are counted separately and excluded from those percentages.
        </p>`
    : '<div class="empty">No trades recorded yet.</div>';
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
  renderEntryCountPerformance();
  renderCount($('byCount'), r, cache);

  $('byCategory').innerHTML = ['Single-timeframe', 'Multi-timeframe'].map(c => {
    const a = r.filter(t => t.category === c);
    return `<div style="margin:13px 0">
      <div class="row between"><span>${esc(c)} (${a.length})</span><b>${winRate(a).toFixed(1)}%</b></div>
      <div class="bar"><i style="width:${winRate(a)}%"></i></div>
    </div>`;
  }).join('');

  const comboMap = {};
  r.forEach(t => {
    const k = [...reasonsOf(t, cache)].sort().join(' + ') || 'No reasons';
    (comboMap[k] ??= []).push(t);
  });

  const combos = Object.entries(comboMap).sort((a, b) => b[1].length - a[1].length);
  $('byCombo').innerHTML = combos.length
    ? `<div class="tablewrap"><table>
        <thead><tr><th>Exact combination</th><th>Trades</th><th>Win rate</th><th>Net P/L</th></tr></thead>
        <tbody>${combos.map(([k, a]) => `
          <tr><td>${esc(k)}</td><td>${a.length}</td><td>${winRate(a).toFixed(1)}%</td>
          <td>${money(a.reduce((s, t) => s + pnl(t), 0))}</td></tr>`).join('')}
        </tbody></table></div>`
    : '<div class="empty">No resolved trades yet.</div>';

  const dims = [
    ['Currency pair', t => t.pair],
    ['Session', t => t.session],
    ['Direction', t => displayDirection(t.direction)],
    ['Market condition', t => t.condition]
  ];

  $('dimensions').innerHTML = dims.map(([label, get]) => {
    const m = {};
    r.forEach(t => (m[get(t)] ??= []).push(t));
    const rows = Object.entries(m).map(([k, a]) =>
      `<div class="row between" style="padding:5px 0"><span>${esc(k)} · ${a.length} trades</span><b>${winRate(a).toFixed(1)}%</b></div>`
    ).join('');
    return `<h4>${esc(label)}</h4>${rows || '<span class="muted">No data</span>'}`;
  }).join('<hr style="border-color:#20344d">');

  const individual = {};
  r.forEach(t => (t.reasonIds || []).forEach(id => (individual[id] ??= []).push(t)));

  $('individualReasons').innerHTML = Object.keys(individual).length
    ? Object.entries(individual).map(([id, a]) => {
        const nm = reasonById(id)?.name || a[0].reasonNames?.[id] || 'Archived reason';
        return `<div style="margin:10px 0">
          <div class="row between"><span>${esc(nm)} · ${a.length} trades</span><b>${winRate(a).toFixed(1)}%</b></div>
          <div class="bar"><i style="width:${winRate(a)}%"></i></div>
        </div>`;
      }).join('')
    : '<span class="muted">No reason data yet.</span>';

  const tf = {};
  r.forEach(t => (t.timeframes || []).forEach(k => (tf[k] ??= []).push(t)));
  const entryTf = {};
  r.forEach(t => {
    if (t.entryTimeframe) (entryTf[t.entryTimeframe] ??= []).push(t);
  });

  const analysisTfHtml = Object.keys(tf).length
    ? Object.entries(tf).sort((a, b) => TIMEFRAMES.indexOf(a[0]) - TIMEFRAMES.indexOf(b[0]))
        .map(([k, a]) => `<div class="row between" style="padding:6px 0"><span>${esc(k)} · ${a.length} trades</span><b>${winRate(a).toFixed(1)}%</b></div>`).join('')
    : '<span class="muted">No analysis timeframe data yet.</span>';

  $('timeframeStats').innerHTML = analysisTfHtml;

  const entryTfHtml = Object.keys(entryTf).length
    ? Object.entries(entryTf).sort((a, b) => TIMEFRAMES.indexOf(a[0]) - TIMEFRAMES.indexOf(b[0]))
        .map(([k, a]) => `<div class="row between" style="padding:6px 0"><span>${esc(k)} · ${a.length} trades</span><b>${winRate(a).toFixed(1)}%</b></div>`).join('')
    : '<span class="muted">No actual entry timeframe data yet.</span>';

  $('entryTimeframeStats').innerHTML = entryTfHtml;

  const avgRating = key => {
    const a = r.filter(t => Number(t[key]) > 0);
    return a.length ? (a.reduce((s, t) => s + Number(t[key]), 0) / a.length).toFixed(1) + ' / 10' : '—';
  };

  $('qualityStats').innerHTML =
    `<div class="row between"><span>Average setup quality</span><b>${esc(avgRating('setupQuality'))}</b></div>` +
    `<div class="row between" style="margin-top:10px"><span>Average execution quality</span><b>${esc(avgRating('executionQuality'))}</b></div>`;

  let streak = 0, maxStreak = 0;
  [...r].sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(t => {
    if (t.result === 'LOSS') {
      streak++;
      maxStreak = Math.max(maxStreak, streak);
    } else streak = 0;
  });

  const avgRisk = r.length
    ? r.reduce((s, t) => s + totalRisk(t), 0) / r.length
    : 0;

  $('riskStats').innerHTML =
    `<div class="row between"><span>Longest consecutive losing streak</span><b>${maxStreak}</b></div>` +
    `<div class="row between" style="margin-top:10px"><span>Average total risk per trade</span><b>${money(avgRisk)}</b></div>`;
}

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

  const arr = Object.values(groups).sort((a, b) => b.trades.length - a.trades.length);
  $('setupCards').innerHTML = arr.length
    ? arr.map(g => {
        const wr = winRate(g.trades);
        const wins = g.trades.filter(t => t.result === 'WIN').length;
        const losses = g.trades.filter(t => t.result === 'LOSS').length;
        const draws = g.trades.filter(t => t.result === 'DRAW').length;
        return `<div class="setup-card">
          <div><b>${esc(g.name)}</b><small class="muted">${g.trades.length} trades · ${wins}W / ${losses}L / ${draws}D · ${sampleLabel(g.trades.length)}</small></div>
          <div class="ring">${wr.toFixed(1)}%</div><div class="trades muted">${g.trades.length}</div>
        </div>`;
      }).join('')
    : '<div class="empty">Log trades with reasons selected to build your setup library.</div>';
}

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
          <span style="min-width:0;flex:1"><b>${esc(transactionDisplayType(t))}</b> · ${esc(t.date)}<br>
            <small class="muted">${esc(transactionDisplayNote(t) || 'No note')}</small></span>
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
  const txTotal = state.transactions.reduce((s, t) => s + transactionEffect(t), 0);
  const balance = start + tradePL + txTotal;
  $('accountBalance').textContent = money(balance);
  $('balanceChange').textContent =
    (balance - start >= 0 ? '▲ +' : '▼ ') + money(balance - start) + ' since starting balance';
}

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

function nowLocalInput() {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function setTradeResult(value) {
  $('result').value = value;
  document.querySelectorAll('[data-result]').forEach(button => {
    button.classList.toggle('active', button.dataset.result === value);
  });
}

function setTradeDirection(value) {
  const direction = displayDirection(value);
  $('direction').value = direction;
  document.querySelectorAll('[data-direction]').forEach(button => {
    button.classList.toggle('active', button.dataset.direction === direction);
  });
}

function clearForm() {
  $('tradeForm').reset();
  $('tradeDate').value = nowLocalInput();
  $('session').value = state.settings.defaultSession || 'New York';
  $('editId').value = '';
  $('formTitle').textContent = 'Log a Trade';
  $('payout').value = state.settings.defaultPayout ?? 80;
  $('numberEntries').value = '1';
  setTradeResult('WIN');
  setTradeDirection('BUY');
  state.pendingShots = [];
  $('shotMeta').innerHTML = '';
  renderChecks();
}

function renderShotMeta() {
  $('shotMeta').innerHTML = state.pendingShots.map((s, i) => `
    <div class="mini" style="margin-top:8px">
      <div class="row between">
        <b>${esc(s.name)}</b>
        <button type="button" class="btn small danger" data-action="remove-shot" data-idx="${i}">Remove</button>
      </div>
      <div class="formgrid">
        <div class="field">
          <label>Screenshot timeframe</label>
          <select data-action="shot-tf" data-idx="${i}">
            <option value="">Select</option>
            ${TIMEFRAMES.map(t => `<option value="${esc(t)}" ${s.tf === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
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
      <img data-lightbox src="${esc(s.data)}" alt="Screenshot preview"
        title="Tap to enlarge" style="max-width:160px;max-height:90px;border-radius:7px;cursor:zoom-in">
    </div>
  `).join('');
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function saveTrade(e) {
  e.preventDefault();

  if (!state.writable) {
    return showError('Storage is not available; cannot save.');
  }

  const requestedEntries = Number($('numberEntries').value);
  if (!Number.isInteger(requestedEntries) || requestedEntries < 1 || requestedEntries > 99) {
    $('numberEntries').focus();
    return showError('Number of entries must be a whole number from 1 to 99.');
  }

  const perEntryRisk = Number($('risk').value);
  if (!Number.isFinite(perEntryRisk) || perEntryRisk < 0) {
    $('risk').focus();
    return showError('Enter a valid amount risked per entry.');
  }

  const id = $('editId').value || U.uid();
  const old = state.trades.find(t => t.id === id);

  const reasonIds = [...document.querySelectorAll('input[name="reason"]:checked')]
    .map(x => x.value);
  const tfs = [...document.querySelectorAll('input[name="tf"]:checked')]
    .map(x => x.value);

  const reasonNames = {};
  state.reasons.forEach(r => { reasonNames[r.id] = r.name; });
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
    direction: storageDirection($('direction').value),
    result: $('result').value,
    risk: perEntryRisk,
    numberEntries: requestedEntries,
    riskMode: RISK_MODE,
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

  trade.numberEntries = requestedEntries;
  trade.riskMode = RISK_MODE;

  try {
    await S.putTrade(trade);
  } catch (err) {
    return showError('Could not save
