// phone-sms/providers/smspool.js - SMSPool native API adapter
(function attachSmsPoolProvider(root, factory) {
  root.PhoneSmsPoolProvider = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function createSmsPoolProviderModule(_root) {
  const PROVIDER_ID = 'smspool';
  const DEFAULT_BASE_URL = 'https://api.smspool.net';
  const DEFAULT_COMPAT_BASE_URL = 'https://api.smspool.net/stubs/handler_api.php?setting=smspool';
  const DEFAULT_SERVICE_CODE = '671';
  const DEFAULT_SERVICE_LABEL = 'OpenAI / ChatGPT';
  const DEFAULT_COUNTRY_ID = 1;
  const DEFAULT_COUNTRY_LABEL = 'United States';
  const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
  const DEFAULT_ACTIVATION_RETRY_ROUNDS = 3;
  const ACTIVATION_RETRY_ROUNDS_MIN = 1;
  const ACTIVATION_RETRY_ROUNDS_MAX = 10;
  const DEFAULT_ACTIVATION_RETRY_DELAY_MS = 2000;
  const SMSPOOL_HISTORY_MAX_USES_EXCEEDED_PREFIX = 'SMSPOOL_HISTORY_MAX_USES_EXCEEDED::';

  function normalizeCountryId(value, fallback = DEFAULT_COUNTRY_ID) {
    const parsed = Math.floor(Number(value));
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    const fallbackParsed = Math.floor(Number(fallback));
    return Number.isFinite(fallbackParsed) && fallbackParsed > 0 ? fallbackParsed : DEFAULT_COUNTRY_ID;
  }

  function normalizeCountryLabel(value = '', fallback = DEFAULT_COUNTRY_LABEL) {
    return String(value || '').trim() || fallback;
  }

  function normalizeCountryFallback(value = []) {
    const source = Array.isArray(value)
      ? value
      : String(value || '')
        .split(/[\r\n,，;；]+/)
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
    const seen = new Set();
    const normalized = [];
    for (const entry of source) {
      let id = 0;
      let label = '';
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        id = normalizeCountryId(entry.id ?? entry.countryId, 0);
        label = String((entry.label ?? entry.countryLabel) || '').trim();
      } else {
        const text = String(entry || '').trim();
        const structured = text.match(/^(\d+)\s*(?:[:|/-]\s*(.+))?$/);
        id = normalizeCountryId(structured?.[1] || text, 0);
        label = String(structured?.[2] || '').trim();
      }
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      normalized.push({ id, label: label || `Country #${id}` });
      if (normalized.length >= 20) {
        break;
      }
    }
    return normalized;
  }

  function normalizeMaxPrice(value = '') {
    const rawValue = String(value ?? '').trim();
    if (!rawValue) {
      return '';
    }
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return '';
    }
    return String(Math.round(numeric * 10000) / 10000);
  }

  function normalizeServiceCode(value = '', fallback = DEFAULT_SERVICE_CODE) {
    const normalized = String(value || '').trim();
    if (normalized) {
      return normalized;
    }
    return String(fallback || '').trim() || DEFAULT_SERVICE_CODE;
  }

  function normalizeBaseUrl(value = '') {
    const trimmed = String(value || '').trim() || DEFAULT_BASE_URL;
    try {
      const url = new URL(trimmed);
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      return DEFAULT_BASE_URL;
    }
  }

  function normalizeCompatBaseUrl(value = '') {
    const trimmed = String(value || '').trim() || DEFAULT_COMPAT_BASE_URL;
    try {
      return new URL(trimmed).toString();
    } catch {
      return DEFAULT_COMPAT_BASE_URL;
    }
  }

  function buildCompatUrl(config = {}, query = {}) {
    const url = new URL(normalizeCompatBaseUrl(config.compatBaseUrl));
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') {
        return;
      }
      url.searchParams.set(key, String(value));
    });
    return url.toString();
  }

  function parsePayload(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
      return '';
    }
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }

  function describePayload(raw) {
    if (typeof raw === 'string') {
      return raw.trim();
    }
    if (raw && typeof raw === 'object') {
      const direct = String(
        raw.message
        || raw.msg
        || raw.error
        || raw.title
        || raw.status
        || raw.statusText
        || ''
      ).trim();
      if (direct) {
        return direct;
      }
      try {
        return JSON.stringify(raw);
      } catch {
        return String(raw);
      }
    }
    return String(raw || '').trim();
  }

  function resolveConfig(state = {}, deps = {}) {
    const configuredBaseUrl = String(state.smsPoolBaseUrl || '').trim();
    const normalizedConfiguredBaseUrl = normalizeBaseUrl(configuredBaseUrl || DEFAULT_BASE_URL);
    const normalizedConfiguredCompatBaseUrl = normalizeCompatBaseUrl(configuredBaseUrl || DEFAULT_COMPAT_BASE_URL);
    const baseUrlLooksLikeCompat = /\/stubs\/handler_api(?:\.php)?/i.test(normalizedConfiguredBaseUrl);
    return {
      apiKey: String(state.smsPoolApiKey || '').trim(),
      baseUrl: baseUrlLooksLikeCompat ? DEFAULT_BASE_URL : normalizedConfiguredBaseUrl,
      compatBaseUrl: baseUrlLooksLikeCompat ? normalizedConfiguredCompatBaseUrl : DEFAULT_COMPAT_BASE_URL,
      fetchImpl: deps.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null),
      requestTimeoutMs: deps.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
    };
  }

  function normalizeActivationRetryRounds(value, fallback = DEFAULT_ACTIVATION_RETRY_ROUNDS) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return Math.max(ACTIVATION_RETRY_ROUNDS_MIN, Math.min(ACTIVATION_RETRY_ROUNDS_MAX, Math.floor(Number(fallback) || DEFAULT_ACTIVATION_RETRY_ROUNDS)));
    }
    return Math.max(ACTIVATION_RETRY_ROUNDS_MIN, Math.min(ACTIVATION_RETRY_ROUNDS_MAX, parsed));
  }

  function normalizeActivationRetryDelayMs(value, fallback = DEFAULT_ACTIVATION_RETRY_DELAY_MS) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return Math.max(500, Math.min(30000, Math.floor(Number(fallback) || DEFAULT_ACTIVATION_RETRY_DELAY_MS)));
    }
    return Math.max(500, Math.min(30000, parsed));
  }

  function normalizePhoneSmsReuseEnabled(state = {}) {
    if (Object.prototype.hasOwnProperty.call(state || {}, 'phoneSmsReuseEnabled')) {
      return Boolean(state.phoneSmsReuseEnabled);
    }
    if (Object.prototype.hasOwnProperty.call(state || {}, 'heroSmsReuseEnabled')) {
      return Boolean(state.heroSmsReuseEnabled);
    }
    return false;
  }

  function normalizePhoneDigits(value = '') {
    return String(value || '').replace(/\D+/g, '');
  }

  function phoneNumbersMatch(left = '', right = '') {
    const leftDigits = normalizePhoneDigits(left);
    const rightDigits = normalizePhoneDigits(right);
    if (!leftDigits || !rightDigits) {
      return false;
    }
    return leftDigits === rightDigits
      || leftDigits.endsWith(rightDigits)
      || rightDigits.endsWith(leftDigits);
  }

  function normalizeExcludedPhoneNumbers(value = []) {
    const source = Array.isArray(value) ? value : [];
    const normalized = [];
    source.forEach((entry) => {
      const phoneNumber = String(
        entry?.phoneNumber
        ?? entry?.number
        ?? entry?.phone
        ?? entry
        ?? ''
      ).trim();
      if (phoneNumber && !normalized.some((saved) => phoneNumbersMatch(saved, phoneNumber))) {
        normalized.push(phoneNumber);
      }
    });
    return normalized;
  }

  function normalizeServiceText(value = '') {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function isConfiguredSmsPoolServiceOrder(record = {}, state = {}) {
    const configuredServiceCode = normalizeServiceCode(state.smsPoolServiceCode, DEFAULT_SERVICE_CODE);
    const rawServiceCode = String(
      record.serviceCode
      ?? record.service_id
      ?? record.serviceid
      ?? record.serviceID
      ?? record.service_code
      ?? ''
    ).trim();
    if (rawServiceCode) {
      return rawServiceCode === configuredServiceCode;
    }
    const serviceText = normalizeServiceText(record.service ?? record.service_name ?? record.serviceName ?? record.short_name);
    if (!serviceText) {
      return false;
    }
    if (/^\d+$/.test(serviceText)) {
      return serviceText === configuredServiceCode;
    }
    const configuredLabel = normalizeServiceText(state.smsPoolServiceLabel || DEFAULT_SERVICE_LABEL);
    return serviceText === configuredLabel
      || serviceText.includes('openai')
      || serviceText.includes('chatgpt');
  }

  function isConfiguredSmsPoolCountryOrder(record = {}, state = {}) {
    const rawCountryId = record.countryId ?? record.country_id ?? record.countryid ?? record.countryID;
    const countryId = normalizeCountryId(rawCountryId, 0);
    const configuredCountryId = normalizeCountryId(state.smsPoolCountryId, DEFAULT_COUNTRY_ID);
    if (countryId > 0) {
      return countryId === configuredCountryId;
    }
    const countryText = normalizeServiceText(record.countryLabel || record.country || record.short_name || record.shortName);
    if (!countryText) {
      return true;
    }
    const configuredLabel = normalizeServiceText(state.smsPoolCountryLabel || DEFAULT_COUNTRY_LABEL);
    if (countryText === configuredLabel) {
      return true;
    }
    const configuredCountryAliases = configuredCountryId === DEFAULT_COUNTRY_ID
      ? ['us', 'usa', 'united states', 'united states of america']
      : [configuredLabel].filter(Boolean);
    return configuredCountryAliases.includes(countryText);
  }

  function isCompletedSmsPoolHistoryOrder(record = {}) {
    const statusText = normalizeServiceText(record.status || record.statusText || record.state);
    if (statusText && !/completed|complete|received|success|done|finished/.test(statusText)) {
      return false;
    }
    return Boolean(extractCodeFromSmsPoolPayload(record));
  }

  function hasSmsPoolServiceDescriptor(record = {}) {
    return Boolean(String(
      record.serviceCode
      ?? record.service_id
      ?? record.serviceid
      ?? record.serviceID
      ?? record.service_code
      ?? record.service
      ?? record.service_name
      ?? record.serviceName
      ?? record.short_name
      ?? ''
    ).trim());
  }

  function isConfiguredSmsPoolActiveServiceOrder(record = {}, state = {}) {
    if (!hasSmsPoolServiceDescriptor(record)) {
      return true;
    }
    return isConfiguredSmsPoolServiceOrder(record, state);
  }

  function isReusableSmsPoolActiveOrder(record = {}) {
    const statusText = normalizeServiceText(record.status || record.statusText || record.state);
    return !/cancel|expired|timeout|closed|invalid|banned|refund/.test(statusText);
  }

  function isSmsPoolOrderWaitingForCode(record = {}) {
    const statusText = normalizeServiceText(record.status || record.statusText || record.state);
    return /pending|waiting|wait code|wait sms|active|processing|prepare|ready|retry|resend/.test(statusText);
  }

  function findMatchingSmsPoolOrder(payload, activation = {}) {
    const normalizedActivation = normalizeActivation(activation, activation);
    if (!normalizedActivation) {
      return null;
    }
    return collectSmsPoolHistoryOrders(payload).find((record) => {
      const orderId = String(record?.order_code || record?.orderid || record?.order_id || record?.id || '').trim();
      const phoneNumber = String(record?.phonenumber || record?.phoneNumber || record?.number || record?.phone || '').trim();
      return orderId === normalizedActivation.activationId
        || phoneNumbersMatch(phoneNumber, normalizedActivation.phoneNumber);
    }) || null;
  }

  async function confirmSmsPoolActivationWaiting(state = {}, activation, deps = {}) {
    const normalizedActivation = normalizeActivation(activation, activation);
    if (!normalizedActivation) {
      throw new Error('SMSPool 缺少需要确认等待状态的接码订单。');
    }
    const config = resolveConfig(state, deps);
    const maxRounds = normalizeActivationRetryRounds(
      state?.heroSmsActivationRetryRounds,
      DEFAULT_ACTIVATION_RETRY_ROUNDS
    );
    const retryDelayMs = normalizeActivationRetryDelayMs(
      state?.heroSmsActivationRetryDelayMs,
      DEFAULT_ACTIVATION_RETRY_DELAY_MS
    );
    let lastStatus = '';

    for (let round = 1; round <= maxRounds; round += 1) {
      const payload = await postForm(config, '/request/active', {
        key: config.apiKey,
      }, 'SMSPool confirm waiting order');
      const matchedOrder = findMatchingSmsPoolOrder(payload, normalizedActivation);
      lastStatus = matchedOrder
        ? (normalizeServiceText(matchedOrder.status || matchedOrder.statusText || matchedOrder.state) || 'unknown')
        : 'not found in active orders';
      if (matchedOrder && isSmsPoolOrderWaitingForCode(matchedOrder)) {
        return matchedOrder;
      }
      if (round < maxRounds) {
        await deps.sleepWithStop?.(retryDelayMs);
      }
    }

    throw new Error(
      `SMSPool 订单 ${normalizedActivation.activationId} 未进入等待验证码状态（最后状态：${lastStatus}）。`
    );
  }

  function normalizeSmsPoolTimestamp(record = {}) {
    const raw = record.timestamp ?? record.created_at ?? record.createdAt ?? record.date ?? record.time;
    if (raw === undefined || raw === null || raw === '') {
      return 0;
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 100000000000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(String(raw));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeSmsPoolCost(record = {}) {
    const raw = record.cost
      ?? record.Cost
      ?? record.cots
      ?? record.Cots
      ?? record.price
      ?? record.Price
      ?? record.amount
      ?? record.Amount;
    if (raw === undefined || raw === null || raw === '') {
      return null;
    }
    const text = String(raw).trim();
    const matched = text.match(/-?\d+(?:[.,]\d+)?/);
    const numeric = matched ? Number(String(matched[0]).replace(',', '.')) : Number(text);
    return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric * 10000) / 10000) : null;
  }

  function normalizeSmsPoolReuseCostFilter(value = null) {
    if (value === undefined || value === null || value === '') {
      return ['0.14', '0.00'];
    }
    const source = Array.isArray(value)
      ? value
      : String(value ?? '')
        .split(/[\s,，|/]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    const normalized = [];
    source.forEach((entry) => {
      const numeric = Number(entry);
      const key = Number.isFinite(numeric) && Math.abs(numeric) < 0.000001
        ? '0.00'
        : (Number.isFinite(numeric) && (Math.abs(numeric - 0.12) < 0.000001 || Math.abs(numeric - 0.14) < 0.000001) ? '0.14' : String(entry || '').trim());
      if ((key === '0.14' || key === '0.00') && !normalized.includes(key)) {
        normalized.push(key);
      }
    });
    return normalized;
  }

  function getSmsPoolReuseCostBucket(record = {}) {
    const cost = normalizeSmsPoolCost(record);
    if (cost === null) {
      return '';
    }
    if (cost <= 0) {
      return '0.00';
    }
    return Math.abs(cost - 0.12) < 0.000001 || Math.abs(cost - 0.14) < 0.000001
      ? '0.14'
      : '';
  }

  function getSmsPoolActivationMaxUses(activation = {}) {
    return Math.max(1, Math.floor(Number(activation?.maxUses) || 3));
  }

  async function postForm(config, path, body = {}, actionLabel = 'SMSPool request', requireApiKey = true) {
    if (requireApiKey && !config.apiKey) {
      throw new Error('SMSPool API Key 缺失，请先在侧边栏保存接码 API Key。');
    }
    if (!config.fetchImpl) {
      throw new Error('SMSPool 网络请求实现不可用。');
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), Number(config.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS)
      : null;
    try {
      const formData = new URLSearchParams();
      Object.entries(body || {}).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') {
          return;
        }
        formData.set(key, String(value));
      });
      const response = await config.fetchImpl(`${normalizeBaseUrl(config.baseUrl)}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'application/json, text/plain, */*',
        },
        body: formData.toString(),
        signal: controller?.signal,
      });
      const text = await response.text();
      const payload = parsePayload(text);
      if (!response.ok) {
        const error = new Error(`${actionLabel}失败：${describePayload(payload) || response.status}`);
        error.payload = payload;
        error.status = response.status;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`${actionLabel}超时。`);
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  async function fetchCompatPayload(config, query = {}, actionLabel = 'SMSPool compat request') {
    if (!config.apiKey) {
      throw new Error('SMSPool API Key 缺失，请先在侧边栏保存接码 API Key。');
    }
    if (!config.fetchImpl) {
      throw new Error('SMSPool 网络请求实现不可用。');
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), Number(config.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS)
      : null;
    try {
      const response = await config.fetchImpl(buildCompatUrl(config, {
        api_key: config.apiKey,
        ...query,
      }), {
        method: 'GET',
        signal: controller?.signal,
      });
      const text = await response.text();
      const payload = parsePayload(text);
      if (!response.ok) {
        const error = new Error(`${actionLabel}失败：${describePayload(payload) || response.status}`);
        error.payload = payload;
        error.status = response.status;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`${actionLabel}超时。`);
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  function normalizeActivation(record, fallback = {}) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return null;
    }
    const activationId = String(
      record.activationId
      ?? record.orderid
      ?? record.order_id
      ?? record.order_code
      ?? record.orderCode
      ?? record.id
      ?? ''
    ).trim();
    const phoneNumber = String(
      record.phoneNumber
      ?? record.phonenumber
      ?? record.number
      ?? record.phone
      ?? ''
    ).trim();
    if (!activationId || !phoneNumber) {
      return null;
    }
    const activationCost = normalizeSmsPoolCost(record);
    return {
      activationId,
      phoneNumber,
      provider: PROVIDER_ID,
      serviceCode: normalizeServiceCode(record.serviceCode || fallback.serviceCode || DEFAULT_SERVICE_CODE),
      countryId: normalizeCountryId(record.countryId ?? fallback.countryId, DEFAULT_COUNTRY_ID),
      countryLabel: normalizeCountryLabel(record.countryLabel || record.country || fallback.countryLabel, DEFAULT_COUNTRY_LABEL),
      successfulUses: Math.max(0, Math.floor(Number(record.successfulUses ?? fallback.successfulUses) || 0)),
      maxUses: Math.max(1, Math.floor(Number(record.maxUses ?? fallback.maxUses) || 3)),
      ...(Number.isFinite(Number(record.smsPoolResendPreparedAt ?? fallback.smsPoolResendPreparedAt))
        ? { smsPoolResendPreparedAt: Math.max(0, Number(record.smsPoolResendPreparedAt ?? fallback.smsPoolResendPreparedAt) || 0) }
        : {}),
      ...(Array.isArray(record.smsPoolIgnoredCodes) || Array.isArray(fallback.smsPoolIgnoredCodes)
        ? {
          smsPoolIgnoredCodes: Array.from(new Set(
            (Array.isArray(record.smsPoolIgnoredCodes) ? record.smsPoolIgnoredCodes : fallback.smsPoolIgnoredCodes)
              .map((entry) => extractVerificationCode(entry))
              .filter(Boolean)
          )),
        }
        : {}),
      ...(activationCost !== null ? { price: activationCost } : {}),
      ...(record.pool !== undefined ? { pool: record.pool } : {}),
    };
  }

  function isSuccessPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return false;
    }
    return Number(payload.success) === 1;
  }

  function extractVerificationCode(rawCodeOrText) {
    const trimmed = String(rawCodeOrText || '').trim();
    if (!trimmed) {
      return '';
    }
    const digitMatch = trimmed.match(/\b(\d{4,8})\b/);
    return digitMatch?.[1] || '';
  }

  function extractCodeFromSmsPoolPayload(payload) {
    if (!payload) {
      return '';
    }
    if (Array.isArray(payload)) {
      for (let index = payload.length - 1; index >= 0; index -= 1) {
        const code = extractCodeFromSmsPoolPayload(payload[index]);
        if (code) {
          return code;
        }
      }
      return '';
    }
    if (typeof payload === 'string') {
      return extractVerificationCode(payload);
    }
    if (typeof payload === 'object') {
      const directFields = [
        payload.code,
        payload.full_code,
        payload.sms_code,
        payload.otp,
        payload.verification_code,
        payload.sms,
        payload.sms_text,
        payload.message,
        payload.text,
      ];
      for (const field of directFields) {
        const code = extractVerificationCode(field);
        if (code) {
          return code;
        }
      }
      const nestedArrays = [
        payload.sms,
        payload.messages,
        payload.history,
      ];
      for (const items of nestedArrays) {
        if (!Array.isArray(items)) {
          continue;
        }
        for (let index = items.length - 1; index >= 0; index -= 1) {
          const code = extractCodeFromSmsPoolPayload(items[index]);
          if (code) {
            return code;
          }
        }
      }
    }
    return '';
  }

  function collectCodesFromSmsPoolPayload(payload, codes = new Set()) {
    if (!payload) {
      return codes;
    }
    if (Array.isArray(payload)) {
      payload.forEach((entry) => collectCodesFromSmsPoolPayload(entry, codes));
      return codes;
    }
    if (typeof payload === 'string') {
      const code = extractVerificationCode(payload);
      if (code) {
        codes.add(code);
      }
      return codes;
    }
    if (typeof payload === 'object') {
      const directFields = [
        payload.code,
        payload.full_code,
        payload.sms_code,
        payload.otp,
        payload.verification_code,
        payload.sms,
        payload.sms_text,
        payload.message,
        payload.text,
      ];
      directFields.forEach((field) => {
        const code = extractVerificationCode(field);
        if (code) {
          codes.add(code);
        }
      });
      [
        payload.sms,
        payload.messages,
        payload.history,
      ].forEach((items) => collectCodesFromSmsPoolPayload(items, codes));
    }
    return codes;
  }

  function resolveIgnoredCodeSet(activation) {
    const codes = Array.isArray(activation?.smsPoolIgnoredCodes) ? activation.smsPoolIgnoredCodes : [];
    return new Set(codes.map((entry) => extractVerificationCode(entry)).filter(Boolean));
  }

  function extractFreshCodeFromSmsPoolPayload(payload, ignoredCodes = null) {
    const code = extractCodeFromSmsPoolPayload(payload);
    if (!code) {
      return '';
    }
    if (ignoredCodes && ignoredCodes.has(code)) {
      return '';
    }
    return code;
  }

  async function captureExistingCodesForActivation(config, activation) {
    const existingCodes = new Set();
    try {
      const checkPayload = await postForm(config, '/sms/check', {
        key: config.apiKey,
        orderid: activation.activationId,
      }, 'SMSPool capture existing sms');
      collectCodesFromSmsPoolPayload(checkPayload, existingCodes);
    } catch {}

    try {
      const activePayload = await postForm(config, '/request/active', {
        key: config.apiKey,
      }, 'SMSPool capture active orders');
      const activeOrders = Array.isArray(activePayload) ? activePayload : [];
      const matchedOrder = activeOrders.find((entry) => {
        const orderCode = String(entry?.order_code || entry?.orderid || entry?.order_id || '').trim();
        const phoneNumber = String(entry?.phonenumber || entry?.phoneNumber || entry?.number || '').trim();
        return orderCode === activation.activationId || phoneNumber === activation.phoneNumber;
      });
      if (matchedOrder) {
        collectCodesFromSmsPoolPayload(matchedOrder, existingCodes);
      }
    } catch {}

    return Array.from(existingCodes);
  }

  function collectSmsPoolHistoryOrders(payload, orders = []) {
    if (!payload) {
      return orders;
    }
    if (Array.isArray(payload)) {
      payload.forEach((entry) => collectSmsPoolHistoryOrders(entry, orders));
      return orders;
    }
    if (typeof payload !== 'object') {
      return orders;
    }
    const normalized = normalizeActivation(payload, payload);
    if (normalized) {
      orders.push(payload);
    }
    [
      payload.data,
      payload.orders,
      payload.history,
      payload.results,
      payload.items,
      payload.records,
    ].forEach((items) => collectSmsPoolHistoryOrders(items, orders));
    return orders;
  }

  function buildSmsPoolHistoryUsageStats(records = [], state = {}) {
    const statsByPhone = new Map();
    const seenOrders = new Set();
    (Array.isArray(records) ? records : []).forEach((record) => {
      const activation = normalizeActivation(record, {
        serviceCode: normalizeServiceCode(state.smsPoolServiceCode, DEFAULT_SERVICE_CODE),
        countryId: normalizeCountryId(state.smsPoolCountryId, DEFAULT_COUNTRY_ID),
        countryLabel: normalizeCountryLabel(state.smsPoolCountryLabel, DEFAULT_COUNTRY_LABEL),
        successfulUses: 1,
      });
      if (
        !activation
        || !isCompletedSmsPoolHistoryOrder(record)
        || !isConfiguredSmsPoolServiceOrder(record, state)
        || !isConfiguredSmsPoolCountryOrder(record, state)
      ) {
        return;
      }
      const phoneKey = normalizePhoneDigits(activation.phoneNumber);
      if (!phoneKey) {
        return;
      }
      const orderKey = `${activation.activationId || ''}::${phoneKey}`;
      if (seenOrders.has(orderKey)) {
        return;
      }
      seenOrders.add(orderKey);
      const stat = statsByPhone.get(phoneKey) || {
        phoneKey,
        phoneNumber: activation.phoneNumber,
        count: 0,
        records: [],
        activationIds: [],
      };
      stat.count += 1;
      stat.records.push(record);
      stat.activationIds.push(activation.activationId);
      statsByPhone.set(phoneKey, stat);
    });
    return statsByPhone;
  }

  function findSmsPoolHistoryUsageStat(statsByPhone, phoneNumber = '') {
    const phoneKey = normalizePhoneDigits(phoneNumber);
    if (!phoneKey || !(statsByPhone instanceof Map)) {
      return null;
    }
    if (statsByPhone.has(phoneKey)) {
      return statsByPhone.get(phoneKey);
    }
    for (const stat of statsByPhone.values()) {
      if (phoneNumbersMatch(stat.phoneNumber, phoneNumber)) {
        return stat;
      }
    }
    return null;
  }

  function buildSmsPoolHistoryMaxUsesError(activation, historyCount, maxUses) {
    const phoneNumber = String(activation?.phoneNumber || '').trim() || 'unknown';
    return new Error(
      `${SMSPOOL_HISTORY_MAX_USES_EXCEEDED_PREFIX}SMSPool 号码 ${phoneNumber} 历史已成功接码 ${historyCount}/${maxUses} 次，已达到复用上限，将从复用候选中移除。`
    );
  }

  async function assertSmsPoolHistoryReuseLimit(state = {}, activation, deps = {}) {
    const normalizedActivation = normalizeActivation(activation, activation);
    if (!normalizedActivation?.phoneNumber) {
      return normalizedActivation;
    }
    const maxUses = getSmsPoolActivationMaxUses(normalizedActivation);
    const config = resolveConfig(state, deps);
    let payload = null;
    try {
      payload = await postForm(config, '/request/history', {
        key: config.apiKey,
      }, 'SMSPool history usage lookup');
    } catch (error) {
      await deps.addLog?.(`步骤 9：SMSPool 历史成功次数查询失败，将继续按原复用逻辑尝试。${error?.message || error}`, 'warn');
      return normalizedActivation;
    }
    const historyRecords = collectSmsPoolHistoryOrders(payload);
    const usageStat = findSmsPoolHistoryUsageStat(
      buildSmsPoolHistoryUsageStats(historyRecords, state),
      normalizedActivation.phoneNumber
    );
    const historyCount = Math.max(0, Number(usageStat?.count) || 0);
    return {
      ...normalizedActivation,
      successfulUses: Math.max(normalizedActivation.successfulUses, historyCount),
      maxUses,
    };
  }

  async function fetchCompletedHistoryReuseCandidates(state = {}, options = {}, deps = {}) {
    if (
      !normalizePhoneSmsReuseEnabled(state)
      || options?.skipSmsPoolReuse === true
      || options?.skipSmsPoolHistoryReuse === true
    ) {
      return [];
    }
    const config = resolveConfig(state, deps);
    let payload = null;
    try {
      payload = await postForm(config, '/request/history', {
        key: config.apiKey,
      }, 'SMSPool history');
    } catch (error) {
      await deps.addLog?.(`步骤 9：SMSPool 历史订单查询失败，将继续正常取号。${error?.message || error}`, 'warn');
      return [];
    }

    const historyRecords = collectSmsPoolHistoryOrders(payload);
    const usageStatsByPhone = buildSmsPoolHistoryUsageStats(historyRecords, state);
    const excludedPhoneNumbers = normalizeExcludedPhoneNumbers(options?.excludedPhoneNumbers);
    const allowedCostBuckets = options?.reuseCostFilter !== undefined
      ? normalizeSmsPoolReuseCostFilter(options.reuseCostFilter)
      : normalizeSmsPoolReuseCostFilter(state.smsPoolReuseCostFilter);
    const seen = new Set();
    const skippedMaxUsePhones = new Set();
    const candidates = historyRecords
      .map((record, index) => {
        const normalized = normalizeActivation(record, {
          serviceCode: normalizeServiceCode(state.smsPoolServiceCode, DEFAULT_SERVICE_CODE),
          countryId: normalizeCountryId(state.smsPoolCountryId, DEFAULT_COUNTRY_ID),
          countryLabel: normalizeCountryLabel(state.smsPoolCountryLabel, DEFAULT_COUNTRY_LABEL),
          successfulUses: 1,
        });
        const usageStat = normalized
          ? findSmsPoolHistoryUsageStat(usageStatsByPhone, normalized.phoneNumber)
          : null;
        return normalized ? { record, activation: normalized, usageStat, index } : null;
      })
      .filter(Boolean)
      .filter(({ record, activation, usageStat }) => {
        const key = `${activation.activationId}::${activation.phoneNumber}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return isCompletedSmsPoolHistoryOrder(record)
          && isConfiguredSmsPoolServiceOrder(record, state)
          && isConfiguredSmsPoolCountryOrder(record, state)
          && allowedCostBuckets.includes(getSmsPoolReuseCostBucket(record))
          && !excludedPhoneNumbers.some((entry) => phoneNumbersMatch(entry, activation.phoneNumber));
      })
      .sort((left, right) => {
        const leftCost = normalizeSmsPoolCost(left.record);
        const rightCost = normalizeSmsPoolCost(right.record);
        const leftHasPaidCost = leftCost !== null && leftCost > 0;
        const rightHasPaidCost = rightCost !== null && rightCost > 0;
        if (leftHasPaidCost !== rightHasPaidCost) {
          return leftHasPaidCost ? -1 : 1;
        }
        const rightTime = normalizeSmsPoolTimestamp(right.record);
        const leftTime = normalizeSmsPoolTimestamp(left.record);
        if (rightTime !== leftTime) {
          return rightTime - leftTime;
        }
        return left.index - right.index;
      })
      .map(({ activation, record, usageStat }) => ({
        ...activation,
        successfulUses: Math.max(1, Number(usageStat?.count) || activation.successfulUses || 0),
        maxUses: getSmsPoolActivationMaxUses(activation),
        smsPoolIgnoredCodes: Array.from(collectCodesFromSmsPoolPayload(record)),
      }));

    if (skippedMaxUsePhones.size) {
      await deps.addLog?.(
        `步骤 9：SMSPool 已跳过历史成功次数达到上限的号码：${Array.from(skippedMaxUsePhones).join(' / ')}。`,
        'warn'
      );
    }
    if (candidates.length) {
      await deps.addLog?.(`步骤 9：SMSPool 找到 ${candidates.length} 个已收短信历史订单，优先尝试复用。`, 'info');
    }
    return candidates;
  }

  async function fetchActiveReuseCandidates(state = {}, options = {}, deps = {}) {
    if (!normalizePhoneSmsReuseEnabled(state) || options?.skipSmsPoolReuse === true) {
      return [];
    }
    const config = resolveConfig(state, deps);
    let payload = null;
    try {
      payload = await postForm(config, '/request/active', {
        key: config.apiKey,
      }, 'SMSPool active orders');
    } catch (error) {
      await deps.addLog?.(`步骤 9：SMSPool 待处理订单查询失败，将继续尝试历史订单或正常取号。${error?.message || error}`, 'warn');
      return [];
    }

    const activeRecords = collectSmsPoolHistoryOrders(payload);
    const excludedPhoneNumbers = normalizeExcludedPhoneNumbers(options?.excludedPhoneNumbers);
    const allowedCostBuckets = options?.reuseCostFilter !== undefined
      ? normalizeSmsPoolReuseCostFilter(options.reuseCostFilter)
      : normalizeSmsPoolReuseCostFilter(state.smsPoolReuseCostFilter);
    const seen = new Set();
    const candidates = activeRecords
      .map((record, index) => {
        const activation = normalizeActivation(record, {
          serviceCode: normalizeServiceCode(state.smsPoolServiceCode, DEFAULT_SERVICE_CODE),
          countryId: normalizeCountryId(state.smsPoolCountryId, DEFAULT_COUNTRY_ID),
          countryLabel: normalizeCountryLabel(state.smsPoolCountryLabel, DEFAULT_COUNTRY_LABEL),
        });
        return activation ? { activation, record, index } : null;
      })
      .filter(Boolean)
      .filter(({ activation, record }) => {
        const key = `${activation.activationId}::${activation.phoneNumber}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return isReusableSmsPoolActiveOrder(record)
          && isConfiguredSmsPoolActiveServiceOrder(record, state)
          && isConfiguredSmsPoolCountryOrder(record, state)
          && allowedCostBuckets.includes(getSmsPoolReuseCostBucket(record))
          && !excludedPhoneNumbers.some((entry) => phoneNumbersMatch(entry, activation.phoneNumber));
      })
      .sort((left, right) => {
        const rightTime = normalizeSmsPoolTimestamp(right.record);
        const leftTime = normalizeSmsPoolTimestamp(left.record);
        if (rightTime !== leftTime) {
          return rightTime - leftTime;
        }
        return left.index - right.index;
      })
      .map(({ activation, record }) => ({
        ...activation,
        smsPoolIgnoredCodes: Array.from(collectCodesFromSmsPoolPayload(record)),
      }));

    if (candidates.length) {
      await deps.addLog?.(`步骤 9：SMSPool 找到 ${candidates.length} 个待处理订单，优先尝试复用。`, 'info');
    }
    return candidates;
  }

  async function reuseActiveActivation(state = {}, activation, deps = {}) {
    try {
      const additionalResult = await requestAdditionalSms(state, activation, deps);
      const additionalActivation = normalizeActivation(additionalResult?.activation, activation);
      if (additionalActivation) {
        return additionalActivation;
      }
    } catch (additionalError) {
      await deps.addLog?.(
        `步骤 9：SMSPool 待处理订单 ${activation.phoneNumber} 重发准备失败，尝试重新激活。${additionalError?.message || additionalError}`,
        'warn'
      );
    }
    return reuseActivation(state, activation, deps);
  }

  async function findReusableActiveActivation(state = {}, options = {}, deps = {}) {
    const candidates = await fetchActiveReuseCandidates(state, options, deps);
    let failedAttempts = 0;
    for (const candidate of candidates) {
      deps.throwIfStopped?.();
      try {
        const activation = await reuseActiveActivation(state, candidate, deps);
        await deps.addLog?.(
          `步骤 9：SMSPool 已优先复用待处理号码 ${activation.phoneNumber}（订单 #${activation.activationId}）。`,
          'info'
        );
        return activation;
      } catch (error) {
        failedAttempts += 1;
        await deps.addLog?.(
          `步骤 9：SMSPool 待处理号码 ${candidate.phoneNumber} 复用失败，将尝试下一个待处理订单或历史订单。${error?.message || error}`,
          'warn'
        );
      }
    }
    if (failedAttempts > 0) {
      await deps.addLog?.(
        `步骤 9：SMSPool 待处理订单复用已尝试 ${failedAttempts} 次未成功，继续尝试历史订单或正常取号。`,
        'warn'
      );
    }
    return null;
  }

  async function reuseHistoryActivation(state = {}, activation, deps = {}) {
    try {
      const additionalResult = await requestAdditionalSms(state, activation, deps);
      const additionalActivation = normalizeActivation(additionalResult?.activation, activation);
      if (additionalActivation) {
        return additionalActivation;
      }
    } catch (additionalError) {
      await deps.addLog?.(
        `步骤 9：SMSPool 历史订单 ${activation.phoneNumber} 重发准备失败，尝试重新激活。${additionalError?.message || additionalError}`,
        'warn'
      );
    }
    return reuseActivation(state, activation, deps);
  }

  async function findReusableHistoryActivation(state = {}, options = {}, deps = {}) {
    const candidates = await fetchCompletedHistoryReuseCandidates(state, options, deps);
    let failedAttempts = 0;
    for (const candidate of candidates) {
      deps.throwIfStopped?.();
      try {
        const activation = await reuseHistoryActivation(state, candidate, deps);
        await deps.addLog?.(
          `步骤 9：SMSPool 已优先复用历史已收短信号码 ${activation.phoneNumber}（订单 #${activation.activationId}）。`,
          'info'
        );
        return {
          ...activation,
          successfulUses: Math.max(1, Number(candidate.successfulUses) || 1),
        };
      } catch (error) {
        failedAttempts += 1;
        await deps.addLog?.(
          `步骤 9：SMSPool 历史号码 ${candidate.phoneNumber} 复用失败，将尝试下一个历史订单或正常取号。${error?.message || error}`,
          'warn'
        );
      }
    }
    if (failedAttempts > 0) {
      await deps.addLog?.(
        `步骤 9：SMSPool 历史订单复用已尝试 ${failedAttempts} 次未成功，放弃历史复用，继续正常取号。`,
        'warn'
      );
    }
    return null;
  }

  async function findActiveActivationByPhoneNumber(state = {}, phoneNumber = '', deps = {}) {
    const normalizedPhoneNumber = String(phoneNumber || '').trim();
    if (!normalizedPhoneNumber) {
      return null;
    }
    const config = resolveConfig(state, deps);
    let payload = null;
    try {
      payload = await postForm(config, '/request/active', {
        key: config.apiKey,
      }, 'SMSPool active phone lookup');
    } catch (error) {
      await deps.addLog?.(`步骤 9：SMSPool 按手机号查询待处理订单失败。${error?.message || error}`, 'warn');
      return null;
    }
    const matches = collectSmsPoolHistoryOrders(payload)
      .map((record, index) => {
        const activation = normalizeActivation(record, {
          serviceCode: normalizeServiceCode(state.smsPoolServiceCode, DEFAULT_SERVICE_CODE),
          countryId: normalizeCountryId(state.smsPoolCountryId, DEFAULT_COUNTRY_ID),
          countryLabel: normalizeCountryLabel(state.smsPoolCountryLabel, DEFAULT_COUNTRY_LABEL),
        });
        return activation ? { activation, record, index } : null;
      })
      .filter(Boolean)
      .filter(({ activation, record }) => (
        phoneNumbersMatch(activation.phoneNumber, normalizedPhoneNumber)
        && isReusableSmsPoolActiveOrder(record)
        && isConfiguredSmsPoolActiveServiceOrder(record, state)
        && isConfiguredSmsPoolCountryOrder(record, state)
      ))
      .sort((left, right) => {
        const rightTime = normalizeSmsPoolTimestamp(right.record);
        const leftTime = normalizeSmsPoolTimestamp(left.record);
        if (rightTime !== leftTime) {
          return rightTime - leftTime;
        }
        return left.index - right.index;
      });
    if (!matches.length) {
      return null;
    }
    const { activation, record } = matches[0];
    await deps.addLog?.(
      `步骤 9：SMSPool 已按手机号 ${normalizedPhoneNumber} 找到待处理订单 #${activation.activationId}，将自动请求 Resend。`,
      'info'
    );
    return {
      ...activation,
      smsPoolIgnoredCodes: Array.from(collectCodesFromSmsPoolPayload(record)),
    };
  }

  async function findHistoryActivationByPhoneNumber(state = {}, phoneNumber = '', deps = {}) {
    const normalizedPhoneNumber = String(phoneNumber || '').trim();
    if (!normalizedPhoneNumber) {
      return null;
    }
    const config = resolveConfig(state, deps);
    let payload = null;
    try {
      payload = await postForm(config, '/request/history', {
        key: config.apiKey,
      }, 'SMSPool history phone lookup');
    } catch (error) {
      await deps.addLog?.(`步骤 9：SMSPool 按手机号查询历史订单失败。${error?.message || error}`, 'warn');
      return null;
    }
    const matches = collectSmsPoolHistoryOrders(payload)
      .map((record, index) => {
        const activation = normalizeActivation(record, {
          serviceCode: normalizeServiceCode(state.smsPoolServiceCode, DEFAULT_SERVICE_CODE),
          countryId: normalizeCountryId(state.smsPoolCountryId, DEFAULT_COUNTRY_ID),
          countryLabel: normalizeCountryLabel(state.smsPoolCountryLabel, DEFAULT_COUNTRY_LABEL),
          successfulUses: 1,
        });
        return activation ? { activation, record, index } : null;
      })
      .filter(Boolean)
      .filter(({ activation, record }) => (
        phoneNumbersMatch(activation.phoneNumber, normalizedPhoneNumber)
        && isConfiguredSmsPoolServiceOrder(record, state)
        && isConfiguredSmsPoolCountryOrder(record, state)
      ))
      .sort((left, right) => {
        const rightTime = normalizeSmsPoolTimestamp(right.record);
        const leftTime = normalizeSmsPoolTimestamp(left.record);
        if (rightTime !== leftTime) {
          return rightTime - leftTime;
        }
        return left.index - right.index;
      });
    if (!matches.length) {
      return null;
    }
    const { activation, record } = matches[0];
    const usageStat = findSmsPoolHistoryUsageStat(
      buildSmsPoolHistoryUsageStats(matches.map((entry) => entry.record), state),
      activation.phoneNumber
    );
    const maxUses = getSmsPoolActivationMaxUses(activation);
    const historyCount = Math.max(0, Number(usageStat?.count) || 0);
    await deps.addLog?.(
      `步骤 9：SMSPool 已按手机号 ${normalizedPhoneNumber} 找到历史订单 #${activation.activationId}，将自动请求 Resend。`,
      'info'
    );
    return {
      ...activation,
      successfulUses: Math.max(1, historyCount, activation.successfulUses || 0),
      maxUses,
      smsPoolIgnoredCodes: Array.from(collectCodesFromSmsPoolPayload(record)),
    };
  }

  function isTerminalStatusPayload(payloadOrMessage) {
    const text = describePayload(payloadOrMessage).toLowerCase();
    return /cancel|expired|timeout|closed|order\s+not\s+found|invalid\s+order|invalid\s+number|does\s+not\s+exist/i.test(text);
  }

  async function requestActivation(state = {}, options = {}, deps = {}) {
    const config = resolveConfig(state, deps);
    const maxRounds = normalizeActivationRetryRounds(state?.heroSmsActivationRetryRounds, DEFAULT_ACTIVATION_RETRY_ROUNDS);
    const retryDelayMs = normalizeActivationRetryDelayMs(state?.heroSmsActivationRetryDelayMs, DEFAULT_ACTIVATION_RETRY_DELAY_MS);
    let lastError = null;

    const activeActivation = await findReusableActiveActivation(state, options, deps);
    if (activeActivation) {
      return activeActivation;
    }

    const historyActivation = await findReusableHistoryActivation(state, options, deps);
    if (historyActivation) {
      return historyActivation;
    }

    if (options?.reuseOnly === true) {
      const requestedBuckets = normalizeSmsPoolReuseCostFilter(options.reuseCostFilter);
      throw new Error(
        `SMSPool ${requestedBuckets.join(' / ') || '指定'} 复用池暂无可用号码，不会购买新号码。`
      );
    }

    for (let round = 1; round <= maxRounds; round += 1) {
      try {
        const payload = await postForm(config, '/purchase/sms', {
          key: config.apiKey,
          country: 'US',
          service: normalizeServiceCode(state.smsPoolServiceCode, DEFAULT_SERVICE_CODE),
          quantity: 1,
        }, 'SMSPool purchase sms');
        const activation = normalizeActivation(payload, {
          serviceCode: normalizeServiceCode(state.smsPoolServiceCode, DEFAULT_SERVICE_CODE),
          countryId: normalizeCountryId(state.smsPoolCountryId, DEFAULT_COUNTRY_ID),
          countryLabel: normalizeCountryLabel(state.smsPoolCountryLabel, DEFAULT_COUNTRY_LABEL),
        });
        if (!activation) {
          throw new Error(`SMSPool purchase sms失败：${describePayload(payload) || '空响应'}`);
        }
        return activation;
      } catch (error) {
        lastError = error;
        if (round >= maxRounds) {
          break;
        }
        await deps.addLog?.(
          `步骤 8：SMSPool 取号失败，正在按取号轮数重试（${round}/${maxRounds}）。${error?.message || error}`,
          'warn'
        );
        await deps.sleepWithStop?.(retryDelayMs);
      }
    }

    throw lastError || new Error('SMSPool purchase sms失败：未知错误');
  }

  async function reuseActivation(state = {}, activation, deps = {}) {
    let normalizedActivation = normalizeActivation(activation, activation);
    if (!normalizedActivation) {
      throw new Error('缺少可复用的 SMSPool 手机号订单。');
    }
    normalizedActivation = await assertSmsPoolHistoryReuseLimit(state, normalizedActivation, deps);
    const config = resolveConfig(state, deps);
    const activatePayload = await postForm(config, '/sms/activate', {
      key: config.apiKey,
      orderid: normalizedActivation.activationId,
    }, 'SMSPool activate sms');
    if (isSuccessPayload(activatePayload)) {
      const existingCodes = await captureExistingCodesForActivation(config, normalizedActivation);
      await confirmSmsPoolActivationWaiting(state, normalizedActivation, deps);
      return {
        ...normalizedActivation,
        smsPoolResendPreparedAt: Date.now(),
        ...(existingCodes.length ? { smsPoolIgnoredCodes: existingCodes } : {}),
      };
    }
    const reactivatePayload = await postForm(config, '/sms/reactivate', {
      key: config.apiKey,
      orderid: normalizedActivation.activationId,
    }, 'SMSPool reactivate sms');
    if (!isSuccessPayload(reactivatePayload)) {
      throw new Error(`SMSPool 复用手机号失败：${describePayload(reactivatePayload) || '未知错误'}`);
    }
    const existingCodes = await captureExistingCodesForActivation(config, normalizedActivation);
    await confirmSmsPoolActivationWaiting(state, normalizedActivation, deps);
    return {
      ...normalizedActivation,
      smsPoolResendPreparedAt: Date.now(),
      ...(existingCodes.length ? { smsPoolIgnoredCodes: existingCodes } : {}),
    };
  }

  async function finishActivation(_state = {}, activation) {
    const normalizedActivation = normalizeActivation(activation, activation);
    if (!normalizedActivation) {
      return '';
    }
    return 'SMSPool complete skipped';
  }

  async function cancelActivation(state = {}, activation, deps = {}) {
    const normalizedActivation = normalizeActivation(activation, activation);
    if (!normalizedActivation) {
      return '';
    }
    const config = resolveConfig(state, deps);
    const payload = await postForm(config, '/sms/cancel', {
      key: config.apiKey,
      orderid: normalizedActivation.activationId,
    }, 'SMSPool cancel sms');
    if (!isSuccessPayload(payload)) {
      throw new Error(`SMSPool 取消订单失败：${describePayload(payload) || '未知错误'}`);
    }
    return describePayload(payload);
  }

  async function banActivation(state = {}, activation, deps = {}) {
    return cancelActivation(state, activation, deps);
  }

  async function requestAdditionalSms(state = {}, activation, deps = {}) {
    let normalizedActivation = normalizeActivation(activation, activation);
    if (!normalizedActivation) {
      normalizedActivation = await findActiveActivationByPhoneNumber(
        state,
        activation?.phoneNumber ?? activation?.number ?? activation?.phone ?? activation,
        deps
      );
    }
    if (!normalizedActivation) {
      normalizedActivation = await findHistoryActivationByPhoneNumber(
        state,
        activation?.phoneNumber ?? activation?.number ?? activation?.phone ?? activation,
        deps
      );
    }
    if (!normalizedActivation) {
      return '';
    }
    normalizedActivation = await assertSmsPoolHistoryReuseLimit(state, normalizedActivation, deps);
    const config = resolveConfig(state, deps);
    const ignoredCodes = Array.from(new Set([
      ...resolveIgnoredCodeSet(normalizedActivation),
      ...(await captureExistingCodesForActivation(config, normalizedActivation)),
    ]));
    const probePayload = await postForm(config, '/sms/check_resend', {
      key: config.apiKey,
      orderid: normalizedActivation.activationId,
    }, 'SMSPool check resend');
    if (isSuccessPayload(probePayload)) {
      const resendPayload = await postForm(config, '/sms/resend', {
        key: config.apiKey,
        orderid: normalizedActivation.activationId,
      }, 'SMSPool resend sms');
      if (!isSuccessPayload(resendPayload)) {
        throw new Error(`SMSPool 重发请求失败：${describePayload(resendPayload) || '未知错误'}`);
      }
      await confirmSmsPoolActivationWaiting(state, normalizedActivation, deps);
      return {
        message: describePayload(resendPayload),
        activation: {
          ...normalizedActivation,
          smsPoolResendPreparedAt: Date.now(),
          ...(ignoredCodes.length ? { smsPoolIgnoredCodes: ignoredCodes } : {}),
        },
      };
    }
    const activatePayload = await postForm(config, '/sms/activate', {
      key: config.apiKey,
      orderid: normalizedActivation.activationId,
    }, 'SMSPool activate sms');
    if (!isSuccessPayload(activatePayload)) {
      throw new Error(`SMSPool 刷新收码状态失败：${describePayload(activatePayload) || describePayload(probePayload) || '未知错误'}`);
    }
    await confirmSmsPoolActivationWaiting(state, normalizedActivation, deps);
    return {
      message: describePayload(activatePayload),
      activation: {
        ...normalizedActivation,
        smsPoolResendPreparedAt: Date.now(),
        ...(ignoredCodes.length ? { smsPoolIgnoredCodes: ignoredCodes } : {}),
      },
    };
  }

  async function pollActivationCode(state = {}, activation, options = {}, deps = {}) {
    const normalizedActivation = normalizeActivation(activation, activation);
    if (!normalizedActivation) {
      throw new Error('缺少 SMSPool 手机号接码订单。');
    }
    const config = resolveConfig(state, deps);
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 180000);
    const intervalMs = Math.max(1000, Number(options.intervalMs) || 5000);
    const maxRoundsRaw = Math.floor(Number(options.maxRounds));
    const maxRounds = Number.isFinite(maxRoundsRaw) && maxRoundsRaw > 0 ? maxRoundsRaw : 0;
    const start = Date.now();
    let pollCount = 0;
    let lastResponse = '';
    const ignoredCodes = resolveIgnoredCodeSet(normalizedActivation);
    const resendPreparedAt = Math.max(0, Number(normalizedActivation.smsPoolResendPreparedAt) || 0);
    const freshnessDelayMs = Math.max(3000, Number(options.smsPoolFreshnessDelayMs) || 8000);
    let ignoredHistoricalCodeLogged = false;

    while (Date.now() - start < timeoutMs) {
      if (maxRounds > 0 && pollCount >= maxRounds) {
        break;
      }
      deps.throwIfStopped?.();
      if (resendPreparedAt > 0 && (Date.now() - resendPreparedAt) < freshnessDelayMs) {
        pollCount += 1;
        lastResponse = 'WAIT_FRESH_SMS';
        if (typeof options.onStatus === 'function') {
          await options.onStatus({
            activation: normalizedActivation,
            elapsedMs: Date.now() - start,
            pollCount,
            statusText: lastResponse,
            timeoutMs,
          });
        }
        if (typeof options.onWaitingForCode === 'function') {
          await options.onWaitingForCode({
            activation: normalizedActivation,
            elapsedMs: Date.now() - start,
            pollCount,
            statusText: lastResponse,
            timeoutMs,
          });
        }
        await deps.sleepWithStop(intervalMs);
        continue;
      }
      let payload = null;
      let checkFailed = null;
      try {
        payload = await postForm(config, '/sms/check', {
          key: config.apiKey,
          orderid: normalizedActivation.activationId,
        }, 'SMSPool check sms');
      } catch (error) {
        checkFailed = error;
      }
      pollCount += 1;
      lastResponse = describePayload(payload || checkFailed?.payload || checkFailed?.message);

      if (typeof options.onStatus === 'function') {
        await options.onStatus({
          activation: normalizedActivation,
          elapsedMs: Date.now() - start,
          pollCount,
          statusText: lastResponse || 'PENDING',
          timeoutMs,
        });
      }

      const code = extractFreshCodeFromSmsPoolPayload(payload, ignoredCodes);
      if (code) {
        return code;
      }
      if (!code && ignoredCodes.size > 0 && extractCodeFromSmsPoolPayload(payload)) {
        if (!ignoredHistoricalCodeLogged) {
          ignoredHistoricalCodeLogged = true;
          await deps.addLog?.(
            `步骤 8：SMSPool 复用订单 ${normalizedActivation.phoneNumber} 命中历史验证码，继续等待新短信。`,
            'info'
          );
        }
      }

      try {
        const activePayload = await postForm(config, '/request/active', {
          key: config.apiKey,
        }, 'SMSPool active orders');
        const activeOrders = Array.isArray(activePayload) ? activePayload : [];
        const matchedOrder = activeOrders.find((entry) => {
          const orderCode = String(entry?.order_code || entry?.orderid || entry?.order_id || '').trim();
          const phoneNumber = String(entry?.phonenumber || entry?.phoneNumber || entry?.number || '').trim();
          return orderCode === normalizedActivation.activationId || phoneNumber === normalizedActivation.phoneNumber;
        });
        const activeCode = extractFreshCodeFromSmsPoolPayload(matchedOrder, ignoredCodes);
        if (activeCode) {
          return activeCode;
        }
        if (!activeCode && ignoredCodes.size > 0 && extractCodeFromSmsPoolPayload(matchedOrder)) {
          if (!ignoredHistoricalCodeLogged) {
            ignoredHistoricalCodeLogged = true;
            await deps.addLog?.(
              `步骤 8：SMSPool 复用订单 ${normalizedActivation.phoneNumber} 命中历史验证码，继续等待新短信。`,
              'info'
            );
          }
        }
        if (matchedOrder) {
          lastResponse = describePayload(matchedOrder) || lastResponse;
          const matchedOrderHasIgnoredCode = !activeCode
            && ignoredCodes.size > 0
            && Boolean(extractCodeFromSmsPoolPayload(matchedOrder));
          if (
            isTerminalStatusPayload(matchedOrder)
            || (String(matchedOrder?.status || '').trim().toLowerCase() === 'completed' && !matchedOrderHasIgnoredCode)
          ) {
            throw new Error(`SMSPool 查询验证码失败：${lastResponse || '订单已结束'}`);
          }
        }
      } catch (activeError) {
        if (!checkFailed && isTerminalStatusPayload(activeError?.payload || activeError?.message)) {
          throw activeError;
        }
      }

      if (isTerminalStatusPayload(payload || checkFailed?.payload || checkFailed?.message)) {
        throw new Error(`SMSPool 查询验证码失败：${lastResponse || '订单已结束'}`);
      }

      if (typeof options.onWaitingForCode === 'function') {
        await options.onWaitingForCode({
          activation: normalizedActivation,
          elapsedMs: Date.now() - start,
          pollCount,
          statusText: lastResponse || 'PENDING',
          timeoutMs,
        });
      }

      await deps.sleepWithStop(intervalMs);
    }

    const suffix = lastResponse ? ` SMSPool 最后状态：${lastResponse}` : '';
    throw new Error(`PHONE_CODE_TIMEOUT::等待手机验证码超时。${suffix}`);
  }

  async function fetchBalance(state = {}, deps = {}) {
    const config = resolveConfig(state, deps);
    const payload = await postForm(config, '/request/balance', {
      key: config.apiKey,
    }, 'SMSPool balance');
    const balance = Number(payload?.balance);
    return {
      balance,
      raw: payload,
    };
  }

  async function fetchPrices(state = {}, countryConfig = null, deps = {}) {
    const config = resolveConfig(state, deps);
    return fetchCompatPayload(config, {
      action: 'getPrices',
      service: normalizeServiceCode(state.smsPoolServiceCode, DEFAULT_SERVICE_CODE),
      country: normalizeCountryId(countryConfig?.id ?? state.smsPoolCountryId, DEFAULT_COUNTRY_ID),
    }, 'SMSPool getPrices');
  }

  function collectPriceEntries(payload, entries = []) {
    if (Array.isArray(payload)) {
      payload.forEach((entry) => collectPriceEntries(entry, entries));
      return entries;
    }
    if (!payload || typeof payload !== 'object') {
      return entries;
    }
    const directPrice = Number(payload.price ?? payload.cost);
    const directCount = Number(payload.count ?? payload.qty);
    if (Number.isFinite(directPrice) && directPrice > 0) {
      entries.push({
        cost: Math.round(directPrice * 10000) / 10000,
        count: Number.isFinite(directCount) ? Math.max(0, directCount) : 0,
        inStock: !Number.isFinite(directCount) || directCount > 0,
      });
    }
    Object.entries(payload).forEach(([key, value]) => {
      const keyedPrice = Number(key);
      if (Number.isFinite(keyedPrice) && keyedPrice > 0) {
        const count = Number(value?.count ?? value);
        entries.push({
          cost: Math.round(keyedPrice * 10000) / 10000,
          count: Number.isFinite(count) ? Math.max(0, count) : 0,
          inStock: !Number.isFinite(count) || count > 0,
        });
      }
      collectPriceEntries(value, entries);
    });
    return entries;
  }

  function resolveCountryCandidates(state = {}) {
    const primary = {
      id: normalizeCountryId(state.smsPoolCountryId),
      label: normalizeCountryLabel(state.smsPoolCountryLabel),
    };
    const seen = new Set([primary.id]);
    const candidates = [primary];
    normalizeCountryFallback(state.smsPoolCountryFallback).forEach((entry) => {
      const id = normalizeCountryId(entry.id, 0);
      if (!id || seen.has(id)) {
        return;
      }
      seen.add(id);
      candidates.push({ id, label: normalizeCountryLabel(entry.label, `Country #${id}`) });
    });
    return candidates;
  }

  function createProvider(deps = {}) {
    const providerDeps = {
      addLog: deps.addLog,
      fetchImpl: deps.fetchImpl,
      sleepWithStop: deps.sleepWithStop,
      throwIfStopped: deps.throwIfStopped,
      requestTimeoutMs: deps.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
    };
    return {
      id: PROVIDER_ID,
      label: 'SMSPool',
      defaultCountryId: DEFAULT_COUNTRY_ID,
      defaultCountryLabel: DEFAULT_COUNTRY_LABEL,
      defaultProduct: DEFAULT_SERVICE_LABEL,
      defaultServiceCode: DEFAULT_SERVICE_CODE,
      normalizeCountryId,
      normalizeCountryLabel,
      normalizeCountryFallback,
      normalizeMaxPrice,
      normalizeServiceCode,
      resolveCountryCandidates,
      requestActivation: (state, options) => requestActivation(state, options, providerDeps),
      reuseActivation: (state, activation) => reuseActivation(state, activation, providerDeps),
      finishActivation: (state, activation) => finishActivation(state, activation, providerDeps),
      cancelActivation: (state, activation) => cancelActivation(state, activation, providerDeps),
      banActivation: (state, activation) => banActivation(state, activation, providerDeps),
      requestAdditionalSms: (state, activation) => requestAdditionalSms(state, activation, providerDeps),
      pollActivationCode: (state, activation, options) => pollActivationCode(state, activation, options, providerDeps),
      fetchBalance: (state) => fetchBalance(state, providerDeps),
      fetchPrices: (state, countryConfig) => fetchPrices(state, countryConfig, providerDeps),
      collectPriceEntries,
      describePayload,
    };
  }

  return {
    PROVIDER_ID,
    DEFAULT_BASE_URL,
    DEFAULT_COMPAT_BASE_URL,
    DEFAULT_COUNTRY_ID,
    DEFAULT_COUNTRY_LABEL,
    DEFAULT_SERVICE_CODE,
    DEFAULT_SERVICE_LABEL,
    createProvider,
  };
});
