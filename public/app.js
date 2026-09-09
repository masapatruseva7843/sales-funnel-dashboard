const state = { data: null };
const formatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

const status = document.querySelector('#status');
const metrics = document.querySelector('#metrics');
const funnel = document.querySelector('#funnel');
const deals = document.querySelector('#deals');
const form = document.querySelector('#period-form');
const category = document.querySelector('#category');
const dateFilters = [
  { key: 'created', from: document.querySelector('#created-from'), to: document.querySelector('#created-to') },
  { key: 'closed', from: document.querySelector('#closed-from'), to: document.querySelector('#closed-to') },
];

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function money(value, currency = 'RUB') {
  try { return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value || 0); }
  catch { return `${formatter.format(value || 0)} ${currency}`; }
}

function dateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' }).format(date);
}

function setStatus(type, message) {
  status.className = `status ${type || ''}`;
  status.textContent = message || '';
}

function render(data) {
  state.data = data;
  setStatus('', '');
  const selectedCategoryId = String(data.selectedCategory.id);
  category.innerHTML = data.categories.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
  category.value = selectedCategoryId;
  metrics.innerHTML = [
    ['Сумма открытых', money(data.metrics.openAmount), 'Открытые сделки с учётом фильтров'],
    ['Выиграно', formatter.format(data.metrics.wonCount), 'Выигранные сделки с учётом фильтров'],
    ['Средний чек', money(data.metrics.wonAverage), 'По выигранным сделкам с учётом фильтров'],
  ].map(([title, value, hint]) => `<article class="metric"><span>${title}</span><strong>${value}</strong><small>${hint}</small></article>`).join('');

  const maximum = Math.max(...data.funnel.map((row) => row.amount), 1);
  document.querySelector('#funnel-total').textContent = `${formatter.format(data.funnel.reduce((sum, row) => sum + row.count, 0))} сделок`;
  funnel.innerHTML = data.funnel.length ? data.funnel.map((row) => `
    <article class="stage">
      <div class="stage-copy"><strong>${esc(row.name)}</strong><span>${formatter.format(row.count)} ${plural(row.count, 'сделка', 'сделки', 'сделок')}</span></div>
      <div class="bar"><i style="width:${Math.max(4, row.amount / maximum * 100)}%"></i></div>
      <strong class="stage-amount">${money(row.amount)}</strong>
    </article>`).join('') : document.querySelector('#empty').innerHTML;

  deals.innerHTML = data.deals.length ? data.deals.map((deal) => `<tr>
    <td><strong>${esc(deal.title)}</strong></td><td>${money(deal.amount, deal.currency)}</td><td><span class="pill">${esc(deal.stage)}</span></td><td>${esc(deal.responsible)}</td><td>${dateTime(deal.createdAt)}</td>
  </tr>`).join('') : '<tr><td colspan="5"><div class="table-empty">За выбранный период сделок нет.</div></td></tr>';
  if (data.notices?.length) setStatus('notice', data.notices.join(' '));
}

function plural(number, one, few, many) {
  const mod10 = number % 10; const mod100 = number % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return few;
  return many;
}

async function load() {
  const query = new URLSearchParams();
  query.set('categoryId', category.value || '0');
  for (const item of dateFilters) {
    if (item.from.value) query.set(`${item.key}From`, item.from.value);
    if (item.to.value) query.set(`${item.key}To`, item.to.value);
  }
  setStatus('loading', 'Загружаем данные CRM…');
  metrics.innerHTML = '<article class="metric skeleton"></article><article class="metric skeleton"></article><article class="metric skeleton"></article>';
  funnel.innerHTML = '<div class="loading-lines"><i></i><i></i><i></i></div>';
  deals.innerHTML = '<tr><td colspan="5"><div class="table-empty">Загрузка…</div></td></tr>';
  try {
    const response = await fetch(`/api/dashboard?${query}`, { credentials: 'same-origin' });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error?.message || 'Не удалось загрузить данные.');
    render(payload.data);
  } catch (error) { setStatus('error', error.message || 'Дашборд временно недоступен.'); }
}

form.addEventListener('submit', (event) => { event.preventDefault(); load(); });
category.addEventListener('change', load);
load();
