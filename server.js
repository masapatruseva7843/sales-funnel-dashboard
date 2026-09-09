const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const VIBE_APP_KEY = process.env.VIBE_APP_KEY;
const VIBE_API_BASE = 'https://vibecode.bitrix24.tech/v1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_LAST_DEALS = 20;
const RETRY_DELAYS = [1000, 2000, 4000];
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  // The dashboard is intentionally framed only by its Bitrix24 portal.
  'Content-Security-Policy': "frame-ancestors 'self' https://7843.bitrix24.ru",
};

class PublicError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
  });
  response.end(JSON.stringify(body));
}

function sendText(response, status, contentType, body) {
  response.writeHead(status, {
    'Content-Type': contentType,
    ...SECURITY_HEADERS,
  });
  response.end(body);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getGatewayAuthorization(request) {
  const value = request.headers['x-vibe-authorization'];
  if (typeof value !== 'string' || !/^Bearer\s+vibe_session_/i.test(value)) {
    throw new PublicError(
      401,
      'AUTH_REQUIRED',
      'Откройте дашборд внутри Битрикс24, чтобы подтвердить вашу сессию.'
    );
  }
  return value;
}

function createApiHeaders(authorization) {
  if (!VIBE_APP_KEY) {
    throw new PublicError(503, 'CONFIGURATION_ERROR', 'Приложение временно недоступно.');
  }
  return {
    'X-Api-Key': VIBE_APP_KEY,
    Authorization: authorization,
    Accept: 'application/json',
  };
}

function apiErrorFrom(status, payload) {
  const code = payload?.error?.code || 'VIBE_API_ERROR';
  if (status === 401) return new PublicError(401, 'AUTH_EXPIRED', 'Сессия истекла. Обновите страницу в Битрикс24.');
  if (status === 403) return new PublicError(403, 'ACCESS_DENIED', 'У вас нет прав для просмотра данных CRM.');
  if (status === 429) return new PublicError(429, 'RATE_LIMITED', 'Слишком много запросов. Повторите попытку через несколько секунд.');
  if (status === 502) return new PublicError(502, 'CRM_UNAVAILABLE', 'Битрикс24 временно недоступен. Повторите попытку позже.');
  return new PublicError(502, code, 'Не удалось получить данные для дашборда.');
}

async function vibeRequest(authorization, pathname, options = {}) {
  const method = options.method || 'GET';
  const headers = createApiHeaders(authorization);
  let attempt = 0;

  while (true) {
    const response = await fetch(`${VIBE_API_BASE}${pathname}`, {
      method,
      headers: {
        ...headers,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(25000),
    }).catch(() => {
      throw new PublicError(502, 'VIBE_UNAVAILABLE', 'Сервис аналитики временно недоступен.');
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw new PublicError(502, 'VIBE_INVALID_RESPONSE', 'Сервис аналитики вернул некорректный ответ.');
    }

    if (response.status === 429 && attempt < RETRY_DELAYS.length) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after') || '', 10);
      const delay = Number.isFinite(retryAfter)
        ? Math.min(retryAfter * 1000, RETRY_DELAYS[attempt])
        : RETRY_DELAYS[attempt];
      attempt += 1;
      await sleep(delay);
      continue;
    }

    if (!response.ok || payload?.success === false) throw apiErrorFrom(response.status, payload);
    return payload.data;
  }
}

function parseDate(value, label) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PublicError(400, 'INVALID_DATE', `${label}: используйте формат ГГГГ-ММ-ДД.`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new PublicError(400, 'INVALID_DATE', `${label}: укажите существующую дату.`);
  }
  return value;
}

const DATE_FILTERS = [
  { key: 'created', field: 'createdAt', label: 'создания' },
  { key: 'closed', field: 'closedAt', label: 'закрытия' },
];

function readDateFilters(url) {
  const filter = {};
  const ranges = {};

  for (const { key, field, label } of DATE_FILTERS) {
    // The aliases keep existing bookmarks with ?from=…&to=… working as a creation-date filter.
    const fromValue = url.searchParams.get(`${key}From`) ?? (key === 'created' ? url.searchParams.get('from') : null);
    const toValue = url.searchParams.get(`${key}To`) ?? (key === 'created' ? url.searchParams.get('to') : null);
    const from = parseDate(fromValue, `Дата начала периода ${label}`);
    const to = parseDate(toValue, `Дата окончания периода ${label}`);
    if (from && to && from > to) {
      throw new PublicError(400, 'INVALID_PERIOD', `Дата начала периода ${label} не может быть позже даты окончания.`);
    }

    ranges[key] = { from, to };
    if (from || to) {
      filter[field] = {};
      if (from) filter[field].$gte = `${from}T00:00:00`;
      if (to) filter[field].$lte = `${to}T23:59:59`;
    }
  }

  return { ranges, filter };
}

function readCategoryId(url) {
  const rawValue = url.searchParams.get('categoryId');
  if (rawValue === null || rawValue === '') return 0;
  if (!/^\d+$/.test(rawValue)) {
    throw new PublicError(400, 'INVALID_CATEGORY', 'Направление сделки указано некорректно.');
  }
  return Number(rawValue);
}

function combineFilters(base, additional) {
  return { ...base, ...additional };
}

function displayUser(user) {
  if (!user) return 'Не назначен';
  return [user.name, user.secondName, user.lastName].filter(Boolean).join(' ') || 'Не назначен';
}

async function fetchCategories(authorization) {
  const categories = await vibeRequest(authorization, '/categories/2');
  return (Array.isArray(categories) ? categories : [])
    .filter((category) => Number.isInteger(Number(category?.id)))
    .map((category) => ({
      id: Number(category.id),
      name: category.name || `Направление ${category.id}`,
      sort: Number(category.sort || 0),
      isDefault: Boolean(category.isDefault),
    }))
    .sort((left, right) => left.sort - right.sort || left.id - right.id);
}

async function fetchStages(authorization, categoryId) {
  const entityId = categoryId === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${categoryId}`;
  const stages = await vibeRequest(
    authorization,
    `/statuses?filter[entityId]=${encodeURIComponent(entityId)}&limit=100&withTotal=false`
  );
  return (Array.isArray(stages) ? stages : [])
    .filter((stage) => stage?.statusId)
    .map((stage) => ({
      id: stage.statusId,
      name: stage.name || stage.statusId,
      sort: Number(stage.sort || 0),
    }))
    .sort((left, right) => left.sort - right.sort || left.id.localeCompare(right.id));
}

async function fetchUsers(authorization, assignedIds) {
  if (!assignedIds.length) return new Map();
  const calls = [{
    id: 'responsibles',
    entity: 'users',
    action: 'list',
    params: {
      filter: { id: { $in: assignedIds.slice(0, 50) } },
      select: ['id', 'name', 'secondName', 'lastName'],
      limit: 50,
      withTotal: false,
    },
  }];
  const result = await vibeRequest(authorization, '/batch', { method: 'POST', body: { calls } });
  const map = new Map();
  for (const user of result.results?.responsibles || []) {
    if (user?.id) map.set(Number(user.id), user);
  }
  return map;
}

async function loadDashboard(authorization, dateFilters, categoryId) {
  await vibeRequest(authorization, '/me');

  const categories = await fetchCategories(authorization);
  const selectedCategory = categories.find((category) => category.id === categoryId);
  if (!selectedCategory) {
    throw new PublicError(400, 'CATEGORY_NOT_FOUND', 'Выбранное направление сделок не найдено.');
  }

  const baseFilter = combineFilters(dateFilters.filter, { categoryId });
  const [stageSummary, openedSummary, wonSummary, latestResult, stages] = await Promise.all([
    vibeRequest(authorization, '/deals/aggregate', {
      method: 'POST',
      body: {
        aggregate: [{ field: 'amount', function: 'sum' }],
        filter: baseFilter,
        groupBy: 'stageId',
      },
    }),
    vibeRequest(authorization, '/deals/aggregate', {
      method: 'POST',
      body: {
        aggregate: [{ field: 'amount', function: 'sum' }],
        filter: combineFilters(baseFilter, { closed: false }),
      },
    }),
    vibeRequest(authorization, '/deals/aggregate', {
      method: 'POST',
      body: {
        aggregate: [{ field: 'amount', function: 'avg' }],
        filter: combineFilters(baseFilter, { stageSemanticId: 'S' }),
      },
    }),
    vibeRequest(authorization, '/deals/search', {
      method: 'POST',
      body: {
        filter: baseFilter,
        limit: MAX_LAST_DEALS,
        order: { createdAt: 'desc' },
        select: ['id', 'title', 'amount', 'currency', 'stageId', 'assignedById', 'createdAt'],
      },
    }),
    fetchStages(authorization, categoryId),
  ]);

  const rawDeals = Array.isArray(latestResult) ? latestResult : [];
  const assignedIds = [...new Set(rawDeals.map((deal) => Number(deal.assignedById)).filter(Number.isFinite))];
  const users = await fetchUsers(authorization, assignedIds);

  const stageGroups = new Map((stageSummary.groups || []).map((group) => [group.stageId, group]));
  const funnel = stages.map((stage) => {
    const group = stageGroups.get(stage.id);
    return {
      stageId: stage.id,
      name: stage.name,
      count: Number(group?.count || 0),
      amount: Number(group?.aggregates?.amount?.sum || 0),
    };
  });
  const stageNames = new Map(stages.map((stage) => [stage.id, stage.name]));

  return {
    dateFilters: dateFilters.ranges,
    categories,
    selectedCategory: { id: selectedCategory.id, name: selectedCategory.name },
    metrics: {
      openAmount: Number(openedSummary.aggregates?.amount?.sum || 0),
      wonCount: Number(wonSummary.count || 0),
      wonAverage: Number(wonSummary.aggregates?.amount?.avg || 0),
    },
    funnel,
    deals: rawDeals.map((deal) => ({
      id: deal.id,
      title: deal.title || 'Без названия',
      amount: Number(deal.amount || 0),
      currency: deal.currency || 'RUB',
      stage: stageNames.get(deal.stageId) || deal.stageId || 'Не указана',
      responsible: displayUser(users.get(Number(deal.assignedById))),
      createdAt: deal.createdAt || null,
    })),
    notices: stageSummary.meta?.truncated ? ['Часть сумм по стадиям не была рассчитана полностью. Сузьте период.'] : [],
  };
}

const MIME_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };

async function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(response, 404, 'text/plain; charset=utf-8', 'Not found');
  try {
    const contents = await fs.readFile(filePath);
    sendText(response, 200, MIME_TYPES[path.extname(filePath)] || 'application/octet-stream', contents);
  } catch {
    sendText(response, 404, 'text/plain; charset=utf-8', 'Not found');
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { ok: true });

  if (request.method === 'GET' && url.pathname === '/api/dashboard') {
    try {
      const authorization = getGatewayAuthorization(request);
      const data = await loadDashboard(authorization, readDateFilters(url), readCategoryId(url));
      return sendJson(response, 200, { success: true, data });
    } catch (error) {
      if (error instanceof PublicError) {
        return sendJson(response, error.status, { success: false, error: { code: error.code, message: error.message } });
      }
      return sendJson(response, 502, { success: false, error: { code: 'DASHBOARD_UNAVAILABLE', message: 'Дашборд временно недоступен.' } });
    }
  }

  if (request.method === 'GET') return serveStatic(request, response, url.pathname);
  return sendJson(response, 405, { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Метод не поддерживается.' } });
});

server.listen(PORT, '0.0.0.0');
