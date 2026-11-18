(() => {
  'use strict';

  /* =========================================================
     Config
     ========================================================= */
  const SECTIONS = {
    plan: {
      eyebrow: 'PLAN · 计划清单',
      title: '计划',
      sub: '把想做的事写下来，一件一件去完成。',
      placeholder: '搜索计划…',
      empty: {
        icon: 'i-plan',
        title: '计划还空着',
        text: '把脑海里想做的小事写下来，一件一件慢慢完成。',
        cta: '写下第一个计划',
        target: 'plan'
      }
    },
    done: {
      eyebrow: 'DONE · 完成记录',
      title: '已完成',
      sub: '每一件完成的小事，都值得被记住。',
      placeholder: '搜索已完成…',
      empty: {
        icon: 'i-done',
        title: '还没有完成记录',
        text: '完成一个计划后，它会带着小小的成就感出现在这里。',
        cta: '去看看计划',
        target: 'plan-section'
      }
    },
    daily: {
      eyebrow: 'DAILY · 日常记录',
      title: '日常记录',
      sub: '留住今天的心情、灵感和琐碎日常。',
      placeholder: '搜索日常记录…',
      empty: {
        icon: 'i-daily',
        title: '今天是空白页',
        text: '随手记下心情、一个念头，或今天发生的一件小事。',
        cta: '记录今天',
        target: 'daily'
      }
    },
    goods: {
      eyebrow: 'FINDS · 好物收藏',
      title: '好物收藏',
      sub: '喜欢的东西，连同当时的心情一起收藏。',
      placeholder: '搜索好物收藏…',
      empty: {
        icon: 'i-goods',
        title: '收藏夹还空着',
        text: '遇到喜欢的东西，存下图片和当时的心动理由。',
        cta: '收藏第一件好物',
        target: 'goods'
      }
    }
  };

  const LS_KEY = 'lq-memo-state-v1';
  const DB_NAME = 'lq-memo-db';
  const DB_STORE = 'kv';
  const MIGRATION_FLAG = 'lq-shared-migrated-v1';
  const BACKUP_KEY = 'lq-last-backup-at-v1';
  const BACKUP_REMINDER_KEY = 'lq-backup-reminder-at-v1';
  const INSTALL_HINT_KEY = 'lq-install-hint-dismissed-v1';
  const SYNC_POLL_MS = 2500;
  const MAX_IMAGES = 6;
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const TYPE_LABEL = { plan: '计划', daily: '日常记录', goods: '好物收藏' };

  /* =========================================================
     State
     ========================================================= */
  const state = {
    items: [],
    section: 'plan',
    search: ''
  };

  const drafts = {
    plan: { title: '', note: '', due: '' },
    daily: { note: '' },
    goods: { title: '', note: '' }
  };

  let pendingImages = [];
  const ui = {
    modal: null,
    lightbox: null,
    imageTarget: null,
    returnFocus: null,
    saveWarned: false
  };

  const sync = {
    mode: 'local',
    revision: 0,
    pollTimer: null,
    polling: false,
    busy: false,
    status: 'connecting'
  };

  let dbPromise = null;

  /* =========================================================
     Small helpers
     ========================================================= */
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
  }

  function uid() {
    try {
      if (crypto.randomUUID) return crypto.randomUUID();
    } catch (_) {
      /* ignore */
    }
    return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  const pad = (number) => String(number).padStart(2, '0');

  function dateKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function parseDateKey(key) {
    const [year, month, day] = String(key).split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function startOfDay(value = new Date()) {
    const date = value instanceof Date ? new Date(value) : new Date(value);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function dayDiff(key, base = new Date()) {
    const target = startOfDay(parseDateKey(key)).getTime();
    const today = startOfDay(base).getTime();
    return Math.round((target - today) / 86400000);
  }

  function weekdayCN(date) {
    return WEEKDAYS[date.getDay()];
  }

  function timeHM(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function fullDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 ${timeHM(value)}`;
  }

  function shortStamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const diff = dayDiff(dateKey(date));
    if (diff === 0) return `今天 ${timeHM(value)}`;
    if (diff === -1) return `昨天 ${timeHM(value)}`;
    if (diff === -2) return '前天';
    if (date.getFullYear() === new Date().getFullYear()) {
      return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
    }
    return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  }

  function groupTitle(key) {
    const diff = dayDiff(key);
    if (diff === 0) return '今天';
    if (diff === -1) return '昨天';
    if (diff === -2) return '前天';
    const date = parseDateKey(key);
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  }

  function groupSub(key) {
    const date = parseDateKey(key);
    if (dayDiff(key) >= -2) return `${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${weekdayCN(date)}`;
    return weekdayCN(date);
  }

  function firstLine(text, limit = 60) {
    return String(text || '').trim().split(/\r?\n/)[0].slice(0, limit);
  }

  function titleOf(item) {
    return String(item.title || '').trim() || firstLine(item.note) || '未命名';
  }

  function truncate(text, limit = 14) {
    const value = String(text || '');
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  }

  function isValidDate(value) {
    return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
  }

  function timestamp(value) {
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? 0 : time;
  }

  function deriveTitleNote(title, note, fallback) {
    const cleanTitle = String(title || '').trim();
    const cleanNote = String(note || '').trim();
    if (cleanTitle) return { title: cleanTitle, note: cleanNote };
    const lines = cleanNote.split(/\r?\n/);
    return {
      title: (firstLine(lines[0]) || fallback).slice(0, 80),
      note: lines.slice(1).join('\n').trim()
    };
  }

  /* =========================================================
     Storage — IndexedDB with localStorage fallback
     ========================================================= */
  function openDB() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB unavailable'));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB error'));
        request.onblocked = () => reject(new Error('IndexedDB blocked'));
      });
    }
    return dbPromise;
  }

  function idbGet(key) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readonly');
          const request = tx.objectStore(DB_STORE).get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        })
    );
  }

  function idbSet(key, value) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          const request = tx.objectStore(DB_STORE).put(value, key);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          tx.onabort = () => reject(tx.error || new Error('IndexedDB aborted'));
        })
    );
  }

  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const type = ['plan', 'daily', 'goods'].includes(raw.type) ? raw.type : 'plan';
    const images =
      type === 'goods' && Array.isArray(raw.images)
        ? raw.images
            .filter((src) => typeof src === 'string' && src.startsWith('data:image/'))
            .slice(0, MAX_IMAGES)
        : [];
    const createdAt = isValidDate(raw.createdAt) ? raw.createdAt : new Date().toISOString();
    const done = type === 'plan' ? Boolean(raw.done) : false;
    return {
      id: String(raw.id || uid()),
      type,
      title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
      note: typeof raw.note === 'string' ? raw.note.slice(0, 10000) : '',
      images,
      dueDate:
        type === 'plan' && /^\d{4}-\d{2}-\d{2}$/.test(String(raw.dueDate || ''))
          ? raw.dueDate
          : '',
      done,
      completedAt: done && isValidDate(raw.completedAt) ? raw.completedAt : '',
      createdAt,
      updatedAt: isValidDate(raw.updatedAt) ? raw.updatedAt : createdAt
    };
  }

  function normalizeItems(items) {
    const seen = new Set();
    const result = [];
    items.forEach((raw) => {
      const item = normalizeItem(raw);
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        result.push(item);
      }
    });
    return result;
  }

  async function loadData() {
    try {
      const saved = await idbGet('state');
      if (saved && Array.isArray(saved.items)) return normalizeItems(saved.items);
    } catch (_) {
      /* fall through to localStorage */
    }
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.items)) {
          const items = normalizeItems(parsed.items);
          idbSet('state', { version: 1, savedAt: new Date().toISOString(), items }).catch(
            () => {}
          );
          return items;
        }
      }
    } catch (_) {
      /* ignore */
    }
    return [];
  }

  function persist() {
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      items: state.items
    };
    (async () => {
      try {
        await idbSet('state', payload);
      } catch (_) {
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(payload));
        } catch (error) {
          if (!ui.saveWarned) {
            ui.saveWarned = true;
            toast('保存空间不足。建议先备份，再删除部分带图片的收藏。');
          }
        }
      }
    })();
  }


  /* =========================================================
     Shared sync
     ========================================================= */
  const SYNC_COPY = {
    connecting: {
      label: '连接中',
      title: '正在连接共享服务…',
      foot: '正在连接共享服务…'
    },
    shared: {
      label: '共享同步',
      title: '手机、电脑正在共用同一份备忘录',
      foot: '已连接 · 手机与电脑共享'
    },
    local: {
      label: '仅本机',
      title: '所有记录只保存在这台 iPhone 上',
      foot: '仅保存在这台 iPhone'
    },
    error: {
      label: '同步中断',
      title: '共享服务连接中断，正在自动重试',
      foot: '共享服务连接中断'
    }
  };

  function setSyncStatus(status) {
    const copy = SYNC_COPY[status] || SYNC_COPY.connecting;
    sync.status = status;
    const pill = $('#syncPill');
    if (pill) {
      pill.dataset.state = status;
      pill.title = copy.title;
    }
    const label = $('#syncText');
    if (label) label.textContent = copy.label;
    const foot = $('#storageFoot');
    if (foot) foot.dataset.state = status;
    const note = $('#storageNote');
    if (note) note.textContent = copy.foot;
  }

  async function apiRequest(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout ?? 45000);
    try {
      const init = {
        method: options.method || 'GET',
        signal: controller.signal,
        cache: 'no-store',
        headers: {}
      };
      if (options.body != null) {
        init.headers['Content-Type'] = 'application/json';
        init.body = options.body;
      }
      const response = await fetch(path, init);
      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        /* a non-JSON error page is handled below */
      }
      if (!response.ok) {
        const error = new Error((data && data.error) || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return data || {};
    } finally {
      clearTimeout(timer);
    }
  }

  function applyRevision(value) {
    const revision = Number(value);
    if (Number.isFinite(revision)) sync.revision = revision;
  }

  function syncFailure(error, silent = false) {
    const networkProblem = !error || !Number.isInteger(error.status) || error.status >= 500;
    if (networkProblem) setSyncStatus('error');
    if (!silent) {
      let message = '同步失败，请确认共享服务仍在运行。';
      if (error?.status === 404) {
        message = '这条记录已经在其他设备上被删除了。';
      } else if (error?.status === 413) {
        message = '内容太大，图片可能过多，请减少后再试。';
      } else if (error?.status >= 500) {
        message = '共享服务保存失败，请稍后重试。';
      } else if (error?.name === 'AbortError') {
        message = '同步超时，请检查网络后重试。';
      }
      toast(message);
    }
    return { ok: false, error };
  }

  async function remoteCreate(item) {
    if (sync.mode !== 'shared') return { ok: true, item, local: true };
    try {
      const data = await apiRequest('/api/items', {
        method: 'POST',
        body: JSON.stringify({ item })
      });
      applyRevision(data.revision);
      setSyncStatus('shared');
      return { ok: true, item: normalizeItem(data.item) || item };
    } catch (error) {
      return syncFailure(error);
    }
  }

  async function remoteUpdate(item) {
    if (sync.mode !== 'shared') return { ok: true, item, local: true };
    try {
      const data = await apiRequest(`/api/items/${encodeURIComponent(item.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ item })
      });
      applyRevision(data.revision);
      setSyncStatus('shared');
      return { ok: true, item: normalizeItem(data.item) || item };
    } catch (error) {
      return syncFailure(error);
    }
  }

  async function remoteDelete(ids) {
    if (sync.mode !== 'shared') return { ok: true, deleted: ids, local: true };
    try {
      const data = await apiRequest('/api/items/delete', {
        method: 'POST',
        body: JSON.stringify({ ids })
      });
      applyRevision(data.revision);
      setSyncStatus('shared');
      return { ok: true, deleted: data.deleted || [] };
    } catch (error) {
      return syncFailure(error);
    }
  }

  async function remoteImport(items) {
    if (sync.mode !== 'shared') return { ok: true, items, local: true };
    try {
      const data = await apiRequest('/api/import', {
        method: 'POST',
        body: JSON.stringify({ items })
      });
      applyRevision(data.revision);
      setSyncStatus('shared');
      return { ok: true, items: normalizeItems(data.items || []) };
    } catch (error) {
      return syncFailure(error);
    }
  }

  function beginBusy() {
    if (sync.busy) return false;
    sync.busy = true;
    return true;
  }

  function endBusy() {
    sync.busy = false;
  }

  async function fetchServerState(since) {
    const suffix = Number.isFinite(since) ? `?since=${Math.max(0, Math.floor(since))}` : '';
    return apiRequest(`/api/state${suffix}`, { timeout: 8000 });
  }

  function startPolling() {
    stopPolling();
    if (sync.mode !== 'shared') return;
    sync.pollTimer = window.setInterval(pollServer, SYNC_POLL_MS);
  }

  function stopPolling() {
    if (sync.pollTimer) {
      clearInterval(sync.pollTimer);
      sync.pollTimer = null;
    }
  }

  async function pollServer() {
    if (sync.mode !== 'shared' || sync.busy || sync.polling || document.hidden) return;
    sync.polling = true;
    try {
      const data = await fetchServerState(sync.revision);
      if (sync.mode !== 'shared' || sync.busy) return;
      setSyncStatus('shared');
      if (data.unchanged) return;
      if (!Array.isArray(data.items)) return;
      const incomingRevision = Number(data.revision);
      if (Number.isFinite(incomingRevision) && incomingRevision < sync.revision) return;
      applyRevision(data.revision);
      state.items = normalizeItems(data.items);
      persist();
      renderNav();
      renderContent();
      renderStats();
      if (state.section === 'done') renderComposer();
    } catch (_) {
      if (!document.hidden) setSyncStatus('error');
    } finally {
      sync.polling = false;
    }
  }

  async function restoreItems(items, index) {
    if (!items.length) return false;
    if (!beginBusy()) {
      toast('正在同步，请稍后再试。');
      return false;
    }
    const restored = [];
    let ok = true;
    try {
      for (const item of items) {
        const result = await remoteCreate(item);
        if (!result.ok) {
          ok = false;
          break;
        }
        restored.push(result.item || item);
      }
    } finally {
      endBusy();
    }
    if (!ok) return false;
    const restoredIds = new Set(restored.map((item) => item.id));
    state.items = state.items.filter((item) => !restoredIds.has(item.id));
    if (Number.isInteger(index)) {
      const at = Math.min(Math.max(index, 0), state.items.length);
      state.items.splice(at, 0, ...restored);
    } else {
      state.items.push(...restored);
    }
    persist();
    renderAll();
    toast('已恢复。');
    return true;
  }

  /* =========================================================
     Selectors / counts
     ========================================================= */
  function planItems() {
    return state.items
      .filter((item) => item.type === 'plan' && !item.done)
      .sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
  }

  function doneItems() {
    return state.items
      .filter((item) => item.type === 'plan' && item.done)
      .sort(
        (a, b) =>
          timestamp(b.completedAt || b.updatedAt) - timestamp(a.completedAt || a.updatedAt)
      );
  }

  function dailyItems() {
    return state.items
      .filter((item) => item.type === 'daily')
      .sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
  }

  function goodsItems() {
    return state.items
      .filter((item) => item.type === 'goods')
      .sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
  }

  function counts() {
    return {
      plan: planItems().length,
      done: doneItems().length,
      daily: dailyItems().length,
      goods: goodsItems().length
    };
  }

  function currentItems() {
    if (state.section === 'plan') return planItems();
    if (state.section === 'done') return doneItems();
    if (state.section === 'daily') return dailyItems();
    return goodsItems();
  }

  function matchesSearch(item, query) {
    if (!query) return true;
    const haystack = `${item.title}\n${item.note}`.toLowerCase();
    return haystack.includes(query);
  }

  /* =========================================================
     Date header + stats
     ========================================================= */
  function renderDates() {
    const now = new Date();
    $('#todayDate').textContent = `${now.getMonth() + 1} 月 ${now.getDate()} 日`;
    $('#todayWeek').textContent = weekdayCN(now);
    $('#sidebarDate').textContent = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${weekdayCN(now)}`;
  }

  function renderStats() {
    const total = state.items.filter((item) => item.type === 'plan').length;
    const completed = doneItems().length;
    const percent = total ? Math.round((completed / total) * 100) : 0;
    $('#progressPercent').textContent = `${percent}%`;
    $('#progressFill').style.width = `${percent}%`;
    $('#progressTrack').setAttribute('aria-valuenow', String(percent));

    let hint = '从一件小事开始吧。';
    if (total === 0) {
      hint = '从一件小事开始吧。';
    } else if (completed === 0) {
      hint = `${total} 个计划等着你，慢慢来。`;
    } else if (completed === total) {
      hint = '全部完成，今天很了不起。';
    } else {
      hint = `已完成 ${completed} / ${total} 个计划。`;
    }
    $('#progressHint').textContent = hint;
  }

  /* =========================================================
     Drafts + composer
     ========================================================= */
  function captureDraft() {
    if (state.section === 'plan') {
      const title = $('#planTitle');
      if (title) {
        drafts.plan = {
          title: title.value,
          note: $('#planNote')?.value || '',
          due: $('#planDate')?.value || ''
        };
      }
    } else if (state.section === 'daily') {
      const note = $('#dailyNote');
      if (note) drafts.daily = { note: note.value };
    } else if (state.section === 'goods') {
      const title = $('#goodsTitle');
      if (title) {
        drafts.goods = {
          title: title.value,
          note: $('#goodsNote')?.value || ''
        };
      }
    }
  }

  function imageStripHTML(images, target) {
    const thumbs = images
      .map(
        (src, index) => `
        <div class="img-thumb">
          <img src="${esc(src)}" alt="已选图片 ${index + 1}">
          <button type="button" class="img-remove" data-action="remove-image" data-target="${target}" data-index="${index}" aria-label="移除这张图片">
            <svg class="icon"><use href="#i-close"></use></svg>
          </button>
        </div>`
      )
      .join('');

    const addTile =
      images.length < MAX_IMAGES
        ? `<button type="button" class="img-add" data-action="pick-images" data-target="${target}" aria-label="添加图片">
             <svg class="icon"><use href="#i-image"></use></svg>
             <span>添加图片</span>
           </button>`
        : `<span class="img-max">已选 ${MAX_IMAGES} 张</span>`;

    return thumbs + addTile;
  }

  function planComposerHTML() {
    const draft = drafts.plan;
    return `
      <div class="composer" id="planComposer">
        <div class="composer-tape" aria-hidden="true"></div>
        <div class="composer-body">
          <input class="composer-title" id="planTitle" type="text" maxlength="80"
            value="${esc(draft.title)}" placeholder="想做什么？" aria-label="计划标题">
          <textarea class="composer-note" id="planNote" rows="2" maxlength="4000"
            placeholder="补充一点细节…（可选）" aria-label="计划备注">${esc(draft.note)}</textarea>
          <div class="composer-bar">
            <div class="composer-fields">
              <label class="mini-field">
                <svg class="icon"><use href="#i-calendar"></use></svg>
                <span>计划日期</span>
                <input type="date" id="planDate" value="${esc(draft.due)}" aria-label="计划日期">
              </label>
            </div>
            <span class="composer-hint">⌘ / Ctrl + Enter 快速添加</span>
            <button class="btn btn-primary" type="button" data-action="add-plan">
              <svg class="icon"><use href="#i-plus"></use></svg>添加到计划
            </button>
          </div>
        </div>
      </div>`;
  }

  function dailyComposerHTML() {
    const now = new Date();
    return `
      <div class="composer" id="dailyComposer">
        <div class="composer-tape" aria-hidden="true"></div>
        <div class="composer-body">
          <textarea class="composer-note composer-note-lg" id="dailyNote" rows="3" maxlength="5000"
            placeholder="今天发生了什么值得记下的事？" aria-label="日常记录内容">${esc(drafts.daily.note)}</textarea>
          <div class="composer-bar">
            <span class="composer-date">${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${weekdayCN(now)}</span>
            <span class="composer-hint">⌘ / Ctrl + Enter 记录</span>
            <button class="btn btn-primary" type="button" data-action="add-daily">
              <svg class="icon"><use href="#i-plus"></use></svg>记录今天
            </button>
          </div>
        </div>
      </div>`;
  }

  function goodsComposerHTML() {
    return `
      <div class="composer" id="goodsComposer">
        <div class="composer-tape" aria-hidden="true"></div>
        <div class="composer-body">
          <input class="composer-title" id="goodsTitle" type="text" maxlength="80"
            value="${esc(drafts.goods.title)}" placeholder="收藏了什么好物？" aria-label="好物名称">
          <textarea class="composer-note" id="goodsNote" rows="2" maxlength="4000"
            placeholder="为什么喜欢它？写点心得…（可选）" aria-label="好物心得">${esc(drafts.goods.note)}</textarea>
          <div class="image-strip image-drop" id="composerImages" data-target="composer">
            ${imageStripHTML(pendingImages, 'composer')}
          </div>
          <div class="composer-bar">
            <span class="image-hint">支持拖拽或粘贴图片</span>
            <span class="composer-hint">最多 ${MAX_IMAGES} 张 · ⌘ / Ctrl + Enter 收藏</span>
            <button class="btn btn-primary" type="button" data-action="add-goods">
              <svg class="icon"><use href="#i-goods"></use></svg>收藏好物
            </button>
          </div>
        </div>
      </div>`;
  }

  function doneSummaryHTML() {
    const done = doneItems();
    if (!done.length) return '';
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    const week = done.filter((item) => timestamp(item.completedAt || item.updatedAt) >= monday.getTime()).length;

    return `
      <div class="done-summary">
        <div class="done-summary-icon">
          <svg class="icon"><use href="#i-check"></use></svg>
        </div>
        <div class="done-summary-text">
          <strong>已经完成 <em>${done.length}</em> 件事</strong>
          <p>${week ? `本周完成 ${week} 件 · 每一件都算数。` : '每一次勾选，都是对自己的小小肯定。'}</p>
        </div>
        <button class="btn btn-ghost" type="button" data-action="clear-done">清空已完成</button>
      </div>`;
  }

  function renderComposer() {
    const mount = $('#composerMount');
    if (!mount) return;
    if (state.section === 'plan') mount.innerHTML = planComposerHTML();
    else if (state.section === 'daily') mount.innerHTML = dailyComposerHTML();
    else if (state.section === 'goods') mount.innerHTML = goodsComposerHTML();
    else mount.innerHTML = doneSummaryHTML();
  }

  function refreshComposerImages() {
    const strip = $('#composerImages');
    if (!strip) return;
    strip.innerHTML = imageStripHTML(pendingImages, 'composer');
  }

  /* =========================================================
     Content renderers
     ========================================================= */
  function planCardHTML(item, index) {
    const due = dueChipHTML(item.dueDate);
    return `
      <article class="item-card plan-card" data-id="${esc(item.id)}" style="--delay:${Math.min(index * 25, 150)}ms">
        <button class="check-btn" type="button" data-action="complete" data-id="${esc(item.id)}"
          aria-label="把「${esc(titleOf(item))}」标记为已完成" title="点一下，完成它">
          <svg class="icon"><use href="#i-check"></use></svg>
        </button>
        <div class="plan-main">
          <h3 class="plan-title">${esc(titleOf(item))}</h3>
          ${item.note ? `<p class="plan-note">${esc(item.note)}</p>` : ''}
          <div class="meta-row">
            ${due}
            <span class="meta">
              <svg class="icon"><use href="#i-clock"></use></svg>${esc(shortStamp(item.createdAt))}
            </span>
          </div>
        </div>
        <div class="card-actions">
          <button class="icon-btn" type="button" data-action="edit" data-id="${esc(item.id)}" aria-label="编辑计划" title="编辑">
            <svg class="icon"><use href="#i-edit"></use></svg>
          </button>
          <button class="icon-btn danger" type="button" data-action="delete" data-id="${esc(item.id)}" aria-label="删除计划" title="删除">
            <svg class="icon"><use href="#i-trash"></use></svg>
          </button>
        </div>
      </article>`;
  }

  function dueChipHTML(dueDate) {
    if (!dueDate) return '';
    const diff = dayDiff(dueDate);
    const date = parseDateKey(dueDate);
    let label;
    let className = '';
    if (diff < 0) {
      label = `已过期 · ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
      className = ' is-overdue';
    } else if (diff === 0) {
      label = '今天到期';
      className = ' is-soon';
    } else if (diff === 1) {
      label = '明天到期';
      className = ' is-soon';
    } else if (diff <= 7) {
      label = `${diff} 天后到期`;
    } else {
      label = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
    }
    return `<span class="due-chip${className}"><svg class="icon"><use href="#i-calendar"></use></svg>${esc(label)}</span>`;
  }

  function planListHTML(items) {
    return `<div class="plan-list">${items.map((item, index) => planCardHTML(item, index)).join('')}</div>`;
  }

  function doneCardHTML(item, index) {
    const completed = item.completedAt || item.updatedAt;
    return `
      <article class="item-card done-card" data-id="${esc(item.id)}" style="--delay:${Math.min(index * 22, 130)}ms">
        <span class="done-check" aria-hidden="true">
          <svg class="icon"><use href="#i-check"></use></svg>
        </span>
        <div class="done-main">
          <h3 class="done-title">${esc(titleOf(item))}</h3>
          ${item.note ? `<p class="done-note">${esc(item.note)}</p>` : ''}
          <div class="done-meta">完成于 ${esc(shortStamp(completed))}</div>
        </div>
        <div class="card-actions">
          <button class="undo-btn" type="button" data-action="undo-complete" data-id="${esc(item.id)}" title="重新放回计划">
            <svg class="icon"><use href="#i-undo"></use></svg>撤销
          </button>
          <button class="icon-btn" type="button" data-action="edit" data-id="${esc(item.id)}" aria-label="编辑记录" title="编辑">
            <svg class="icon"><use href="#i-edit"></use></svg>
          </button>
          <button class="icon-btn danger" type="button" data-action="delete" data-id="${esc(item.id)}" aria-label="删除记录" title="删除">
            <svg class="icon"><use href="#i-trash"></use></svg>
          </button>
        </div>
      </article>`;
  }

  function doneListHTML(items) {
    const groups = new Map();
    items.forEach((item) => {
      const key = dateKey(new Date(item.completedAt || item.updatedAt));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });

    const sorted = [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));

    return `
      <div class="done-groups">
        ${sorted
          .map(
            ([key, group]) => `
          <section class="done-group">
            <div class="group-head">
              <span class="group-title">${esc(groupTitle(key))}</span>
              <span class="group-date">${esc(groupSub(key))}</span>
              <span class="group-line"></span>
              <span class="group-count">${group.length} 项</span>
            </div>
            <div class="done-list">
              ${group.map((item, index) => doneCardHTML(item, index)).join('')}
            </div>
          </section>`
          )
          .join('')}
      </div>`;
  }

  function dailyCardHTML(item, index) {
    return `
      <article class="item-card daily-card" data-id="${esc(item.id)}" style="--delay:${Math.min(index * 25, 150)}ms">
        <div class="daily-main">
          <div class="daily-time">
            <svg class="icon"><use href="#i-clock"></use></svg>${esc(timeHM(item.createdAt))}
          </div>
          ${item.title ? `<h3 class="plan-title">${esc(item.title)}</h3>` : ''}
          <p class="daily-text">${esc(item.note)}</p>
        </div>
        <div class="card-actions">
          <button class="icon-btn" type="button" data-action="edit" data-id="${esc(item.id)}" aria-label="编辑记录" title="编辑">
            <svg class="icon"><use href="#i-edit"></use></svg>
          </button>
          <button class="icon-btn danger" type="button" data-action="delete" data-id="${esc(item.id)}" aria-label="删除记录" title="删除">
            <svg class="icon"><use href="#i-trash"></use></svg>
          </button>
        </div>
      </article>`;
  }

  function dailyGroupsHTML(items) {
    const groups = new Map();
    items.forEach((item) => {
      const key = dateKey(new Date(item.createdAt));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });

    const sorted = [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));

    return `
      <div class="daily-groups">
        ${sorted
          .map(([key, group]) => {
            const date = parseDateKey(key);
            const diff = dayDiff(key);
            const railLabel = diff === 0 ? '今天' : diff === -1 ? '昨天' : `${date.getMonth() + 1} 月`;
            return `
              <section class="daily-group">
                <div class="daily-rail">
                  <div class="day-num">${date.getDate()}</div>
                  <div class="day-month">${esc(railLabel)}</div>
                  <div class="day-week">${weekdayCN(date)}</div>
                </div>
                <div class="daily-stream">
                  ${group.map((item, index) => dailyCardHTML(item, index)).join('')}
                </div>
              </section>`;
          })
          .join('')}
      </div>`;
  }

  function goodsCardHTML(item, index) {
    const cover =
      item.images.length > 0
        ? `<div class="goods-cover">
             <img src="${esc(item.images[0])}" alt="${esc(titleOf(item))}" loading="lazy">
             ${item.images.length > 1 ? `<span class="img-count"><svg class="icon"><use href="#i-image"></use></svg>${item.images.length}</span>` : ''}
             <div class="card-actions">
               <button class="icon-btn" type="button" data-action="edit" data-id="${esc(item.id)}" aria-label="编辑收藏" title="编辑">
                 <svg class="icon"><use href="#i-edit"></use></svg>
               </button>
               <button class="icon-btn danger" type="button" data-action="delete" data-id="${esc(item.id)}" aria-label="删除收藏" title="删除">
                 <svg class="icon"><use href="#i-trash"></use></svg>
               </button>
             </div>
           </div>`
        : `<div class="goods-cover is-empty">
             <svg class="icon"><use href="#i-goods"></use></svg>
             <div class="card-actions">
               <button class="icon-btn" type="button" data-action="edit" data-id="${esc(item.id)}" aria-label="编辑收藏" title="编辑">
                 <svg class="icon"><use href="#i-edit"></use></svg>
               </button>
               <button class="icon-btn danger" type="button" data-action="delete" data-id="${esc(item.id)}" aria-label="删除收藏" title="删除">
                 <svg class="icon"><use href="#i-trash"></use></svg>
               </button>
             </div>
           </div>`;

    return `
      <article class="item-card goods-card" data-id="${esc(item.id)}" style="--delay:${Math.min(index * 30, 180)}ms">
        <button class="goods-open" type="button" data-action="open-goods" data-id="${esc(item.id)}"
          aria-label="查看收藏：${esc(titleOf(item))}"></button>
        ${cover}
        <div class="goods-body">
          <h3 class="goods-title">${esc(titleOf(item))}</h3>
          ${item.note ? `<p class="goods-note">${esc(item.note)}</p>` : ''}
          <div class="goods-foot">${esc(shortStamp(item.createdAt))} 收藏</div>
        </div>
      </article>`;
  }

  function goodsGridHTML(items) {
    return `<div class="goods-grid">${items.map((item, index) => goodsCardHTML(item, index)).join('')}</div>`;
  }

  function emptyHTML() {
    const config = SECTIONS[state.section];
    const empty = config.empty;
    return `
      <div class="empty">
        <div class="empty-art">
          <svg class="icon"><use href="#${empty.icon}"></use></svg>
        </div>
        <h3>${esc(empty.title)}</h3>
        <p>${esc(empty.text)}</p>
        <button class="btn btn-primary" type="button" data-action="empty-cta" data-target="${esc(empty.target)}">
          <svg class="icon"><use href="#i-plus"></use></svg>${esc(empty.cta)}
        </button>
      </div>`;
  }

  function emptySearchHTML() {
    return `
      <div class="empty empty-search">
        <div class="empty-art">
          <svg class="icon"><use href="#i-search"></use></svg>
        </div>
        <h3>没有找到「${esc(truncate(state.search, 18))}」</h3>
        <p>换个关键词试试，或清除搜索看看全部内容。</p>
        <button class="btn btn-ghost" type="button" data-action="clear-search">清除搜索</button>
      </div>`;
  }

  function renderContent() {
    const content = $('#content');
    if (!content) return;
    const query = state.search.trim().toLowerCase();
    const items = currentItems().filter((item) => matchesSearch(item, query));

    if (!items.length) {
      content.innerHTML = query ? emptySearchHTML() : emptyHTML();
      return;
    }

    if (state.section === 'plan') content.innerHTML = planListHTML(items);
    else if (state.section === 'done') content.innerHTML = doneListHTML(items);
    else if (state.section === 'daily') content.innerHTML = dailyGroupsHTML(items);
    else content.innerHTML = goodsGridHTML(items);
  }

  /* =========================================================
     Header / nav / all
     ========================================================= */
  function renderNav() {
    const number = counts();
    $$('.nav-item').forEach((button) => {
      const section = button.dataset.section;
      const active = section === state.section;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
      const badge = $('.nav-count', button);
      if (badge) badge.textContent = number[section] ?? 0;
    });
  }

  function renderHeader() {
    const config = SECTIONS[state.section];
    $('#pageEyebrow').textContent = config.eyebrow;
    $('#pageTitle').textContent = config.title;
    $('#pageSub').textContent = config.sub;
    const search = $('#searchInput');
    search.placeholder = config.placeholder;
    search.value = state.search;
    $('#searchClear').hidden = !state.search.trim();
  }

  function renderAll(options = {}) {
    if (options.capture !== false) captureDraft();
    renderNav();
    renderHeader();
    renderComposer();
    renderContent();
    renderStats();
    updateBackupIndicator();
  }

  function switchSection(section) {
    if (!SECTIONS[section] || section === state.section) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    captureDraft();
    state.section = section;
    state.search = '';
    renderAll({ capture: false });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function clearSearch() {
    state.search = '';
    const input = $('#searchInput');
    if (input) {
      input.value = '';
      input.focus();
    }
    $('#searchClear').hidden = true;
    renderContent();
  }

  function focusComposer(target) {
    const section = target === 'goods' ? 'goods' : target === 'daily' ? 'daily' : 'plan';
    if (state.section !== section) switchSection(section);
    requestAnimationFrame(() => {
      const selector = { plan: '#planTitle', daily: '#dailyNote', goods: '#goodsTitle' }[section];
      const input = $(selector);
      if (input) {
        input.focus({ preventScroll: true });
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  /* =========================================================
     Add items
     ========================================================= */
  function nudge(element) {
    if (!element) return;
    element.classList.remove('shake');
    void element.offsetWidth;
    element.classList.add('shake');
    element.focus({ preventScroll: false });
    setTimeout(() => element.classList.remove('shake'), 480);
  }

  async function addPlan() {
    const titleEl = $('#planTitle');
    const noteEl = $('#planNote');
    const dueEl = $('#planDate');
    const rawTitle = titleEl?.value.trim() || '';
    const rawNote = noteEl?.value.trim() || '';

    if (!rawTitle && !rawNote) {
      nudge(titleEl);
      toast('先写下想做的事吧。');
      return;
    }

    const derived = deriveTitleNote(rawTitle, rawNote, '无标题计划');
    const now = new Date().toISOString();
    const item = {
      id: uid(),
      type: 'plan',
      title: derived.title,
      note: derived.note,
      images: [],
      dueDate: dueEl?.value || '',
      done: false,
      completedAt: '',
      createdAt: now,
      updatedAt: now
    };

    if (!beginBusy()) return;
    let result;
    try {
      result = await remoteCreate(item);
    } catch (error) {
      result = syncFailure(error);
    } finally {
      endBusy();
    }
    if (!result?.ok) return;

    state.items.unshift(result.item || item);
    drafts.plan = { title: '', note: '', due: '' };
    state.search = '';
    persist();
    renderAll({ capture: false });
    toast('已加入计划清单。');
  }

  async function addDaily() {
    const noteEl = $('#dailyNote');
    const note = noteEl?.value.trim() || '';
    if (!note) {
      nudge(noteEl);
      toast('今天想记下点什么呢？');
      return;
    }

    const now = new Date().toISOString();
    const item = {
      id: uid(),
      type: 'daily',
      title: '',
      note,
      images: [],
      dueDate: '',
      done: false,
      completedAt: '',
      createdAt: now,
      updatedAt: now
    };

    if (!beginBusy()) return;
    let result;
    try {
      result = await remoteCreate(item);
    } catch (error) {
      result = syncFailure(error);
    } finally {
      endBusy();
    }
    if (!result?.ok) return;

    state.items.unshift(result.item || item);
    drafts.daily = { note: '' };
    state.search = '';
    persist();
    renderAll({ capture: false });
    toast('今天也被好好记住了。');
  }

  async function addGoods() {
    const titleEl = $('#goodsTitle');
    const noteEl = $('#goodsNote');
    const rawTitle = titleEl?.value.trim() || '';
    const rawNote = noteEl?.value.trim() || '';

    if (!rawTitle && !rawNote && !pendingImages.length) {
      nudge(titleEl);
      toast('写点什么，或者添加一张图片吧。');
      return;
    }

    const derived = deriveTitleNote(rawTitle, rawNote, '好物收藏');
    const now = new Date().toISOString();
    const item = {
      id: uid(),
      type: 'goods',
      title: derived.title,
      note: derived.note,
      images: [...pendingImages],
      dueDate: '',
      done: false,
      completedAt: '',
      createdAt: now,
      updatedAt: now
    };

    if (!beginBusy()) return;
    let result;
    try {
      result = await remoteCreate(item);
    } catch (error) {
      result = syncFailure(error);
    } finally {
      endBusy();
    }
    if (!result?.ok) return;

    state.items.unshift(result.item || item);
    drafts.goods = { title: '', note: '' };
    pendingImages = [];
    state.search = '';
    persist();
    renderAll({ capture: false });
    toast('已收藏，愿它一直让你心动。');
  }

  /* =========================================================
     Item actions
     ========================================================= */
  async function completeItem(id, trigger) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item || item.done || !beginBusy()) return;

    const card = trigger?.closest('.plan-card');
    if (card) {
      card.classList.add('is-completing');
      const rect = card.getBoundingClientRect();
      confetti(rect.left + 24, rect.top + 30);
    }

    const now = new Date().toISOString();
    const updated = {
      ...item,
      done: true,
      completedAt: now,
      updatedAt: now
    };

    let result;
    try {
      result = await remoteUpdate(updated);
    } catch (error) {
      result = syncFailure(error);
    } finally {
      endBusy();
    }

    if (!result?.ok) {
      card?.classList.remove('is-completing');
      return;
    }

    const index = state.items.findIndex((entry) => entry.id === id);
    if (index >= 0) state.items[index] = result.item || updated;
    persist();

    setTimeout(() => {
      renderAll();
      toast('完成啦，已移入「已完成」。', {
        actionLabel: '撤销',
        duration: 6000,
        onAction: async () => {
          const latest = state.items.find((entry) => entry.id === id);
          if (!latest) {
            toast('这条计划已经不存在了。');
            return;
          }
          if (!beginBusy()) return;
          const reverted = {
            ...latest,
            done: false,
            completedAt: '',
            updatedAt: new Date().toISOString()
          };
          let undoResult;
          try {
            undoResult = await remoteUpdate(reverted);
          } catch (error) {
            undoResult = syncFailure(error);
          } finally {
            endBusy();
          }
          if (!undoResult?.ok) return;
          const at = state.items.findIndex((entry) => entry.id === id);
          if (at >= 0) state.items[at] = undoResult.item || reverted;
          persist();
          renderAll();
          toast('已恢复到计划。');
        }
      });
    }, 330);
  }

  async function undoComplete(id) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item || !beginBusy()) return;

    const reverted = {
      ...item,
      done: false,
      completedAt: '',
      updatedAt: new Date().toISOString()
    };

    let result;
    try {
      result = await remoteUpdate(reverted);
    } catch (error) {
      result = syncFailure(error);
    } finally {
      endBusy();
    }
    if (!result?.ok) return;

    const index = state.items.findIndex((entry) => entry.id === id);
    if (index >= 0) state.items[index] = result.item || reverted;
    persist();
    renderAll();
    toast('已移回「计划」。');
  }

  async function deleteItem(id) {
    const index = state.items.findIndex((entry) => entry.id === id);
    if (index < 0 || !beginBusy()) return;
    const removed = state.items[index];

    let result;
    try {
      result = await remoteDelete([id]);
    } catch (error) {
      result = syncFailure(error);
    } finally {
      endBusy();
    }
    if (!result?.ok) return;

    const currentIndex = state.items.findIndex((entry) => entry.id === id);
    if (currentIndex >= 0) state.items.splice(currentIndex, 1);
    if (ui.modal && ui.modal.id === id) closeModal();
    persist();
    renderAll();

    toast(`已删除「${truncate(titleOf(removed))}」。`, {
      actionLabel: '撤销',
      duration: 6000,
      onAction: () => restoreItems([removed], index)
    });
  }

  async function clearDone() {
    const removed = state.items.filter((item) => item.type === 'plan' && item.done);
    if (!removed.length || !beginBusy()) return;

    let result;
    try {
      result = await remoteDelete(removed.map((item) => item.id));
    } catch (error) {
      result = syncFailure(error);
    } finally {
      endBusy();
    }
    if (!result?.ok) return;

    state.items = state.items.filter((item) => !(item.type === 'plan' && item.done));
    persist();
    renderAll();
    toast(`已清空 ${removed.length} 条完成记录。`, {
      actionLabel: '撤销',
      duration: 6000,
      onAction: () => restoreItems(removed)
    });
  }

  /* =========================================================
     Images
     ========================================================= */
  function pickImages(target) {
    ui.imageTarget = target;
    const input = $('#imageInput');
    input.value = '';
    input.click();
  }

  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => resolve({ image, url });
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('这张图片没法读取，换一张试试。'));
      };
      image.src = url;
    });
  }

  async function compressImage(file) {
    if (!file.type.startsWith('image/')) throw new Error('请选择图片文件。');
    if (file.size > 25 * 1024 * 1024) throw new Error('图片超过了 25MB，换一张小一点的吧。');

    let source = null;
    let width = 0;
    let height = 0;
    let cleanup = () => {};

    try {
      source = await createImageBitmap(file, { imageOrientation: 'from-image' });
      width = source.width;
      height = source.height;
      cleanup = () => source.close?.();
    } catch (_) {
      const loaded = await loadImageElement(file);
      source = loaded.image;
      width = loaded.image.naturalWidth || loaded.image.width;
      height = loaded.image.naturalHeight || loaded.image.height;
      cleanup = () => URL.revokeObjectURL(loaded.url);
    }

    try {
      const maxDimension = 1500;
      const scale = Math.min(1, maxDimension / Math.max(width, height));
      const canvasWidth = Math.max(1, Math.round(width * scale));
      const canvasHeight = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('图片处理失败了。');
      context.fillStyle = '#fffdf8';
      context.fillRect(0, 0, canvasWidth, canvasHeight);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, canvasWidth, canvasHeight);

      let dataUrl = canvas.toDataURL('image/webp', 0.82);
      if (!dataUrl.startsWith('data:image/webp')) {
        dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      }
      return dataUrl;
    } finally {
      cleanup();
    }
  }

  async function addImages(files, target) {
    const list = [...files].filter((file) => file.type.startsWith('image/'));
    if (!list.length) {
      toast('请选择图片文件。');
      return;
    }

    const owner = target === 'modal' ? ui.modal : null;
    const images = target === 'modal' ? ui.modal?.images : pendingImages;
    if (!images) return;

    const remaining = MAX_IMAGES - images.length;
    if (remaining <= 0) {
      toast(`最多只能添加 ${MAX_IMAGES} 张图片。`);
      return;
    }

    if (list.length > remaining) {
      toast(`最多 ${MAX_IMAGES} 张，先添加前 ${remaining} 张。`);
    }

    const accepted = list.slice(0, remaining);
    const addButton = $(`.img-add[data-target="${target}"]`);
    addButton?.classList.add('is-loading');

    for (const file of accepted) {
      try {
        images.push(await compressImage(file));
      } catch (error) {
        toast(error.message || '图片处理失败，换一张试试。');
      }
    }

    addButton?.classList.remove('is-loading');
    if (target === 'modal') {
      if (ui.modal === owner) refreshModalImages();
    } else {
      refreshComposerImages();
    }
  }

  function refreshModalImages() {
    const strip = $('#modalImages');
    if (!strip || !ui.modal) return;
    strip.innerHTML = imageStripHTML(ui.modal.images, 'modal');
  }

  /* =========================================================
     Modals
     ========================================================= */
  function setModal(html) {
    if (!ui.modal && !ui.returnFocus) ui.returnFocus = document.activeElement;
    $('#modalRoot').innerHTML = html;
    document.body.classList.add('modal-open');
  }

  function closeModal() {
    ui.modal = null;
    $('#modalRoot').innerHTML = '';
    document.body.classList.remove('modal-open');
    if (ui.returnFocus && document.contains(ui.returnFocus)) {
      try {
        ui.returnFocus.focus({ preventScroll: true });
      } catch (_) {
        /* ignore */
      }
    }
    ui.returnFocus = null;
  }

  function openEditModal(id) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item) return;
    captureDraft();
    if (!ui.modal) ui.returnFocus = document.activeElement;
    ui.modal = {
      kind: 'edit',
      id,
      type: item.type,
      images: item.type === 'goods' ? [...item.images] : []
    };
    renderEditModal(item);
  }

  function renderEditModal(item) {
    const isDaily = item.type === 'daily';
    const isPlan = item.type === 'plan';
    const isGoods = item.type === 'goods';
    const titleField = !isDaily
      ? `<label class="field">
           <span>标题</span>
           <input id="editTitle" type="text" maxlength="80" value="${esc(item.title)}" placeholder="给它起个名字">
         </label>`
      : '';

    const noteField = `
      <label class="field">
        <span>${isDaily ? '内容' : '备注'}</span>
        <textarea id="editNote" maxlength="10000" rows="5" placeholder="${isDaily ? '写点什么…' : '补充一点细节…'}">${esc(item.note)}</textarea>
      </label>`;

    const dateField = isPlan
      ? `<label class="field">
           <span>计划日期（可选）</span>
           <input id="editDate" type="date" value="${esc(item.dueDate)}">
         </label>`
      : '';

    const imagesField = isGoods
      ? `<div class="field">
           <span class="field-label">图片</span>
           <div class="image-strip image-drop" id="modalImages" data-target="modal">
             ${imageStripHTML(ui.modal.images, 'modal')}
           </div>
           <p class="modal-note">最多 ${MAX_IMAGES} 张，支持拖拽或粘贴图片。</p>
         </div>`
      : '';

    setModal(`
      <div class="modal-backdrop" id="modalBackdrop">
        <div class="modal edit-modal" role="dialog" aria-modal="true" aria-labelledby="editModalTitle">
          <div class="modal-head">
            <div>
              <div class="eyebrow">EDIT · 编辑</div>
              <h2 id="editModalTitle">编辑${TYPE_LABEL[item.type]}</h2>
            </div>
            <button class="modal-x" type="button" data-action="modal-close" aria-label="关闭">
              <svg class="icon"><use href="#i-close"></use></svg>
            </button>
          </div>
          <div class="modal-body">
            ${titleField}
            ${noteField}
            ${dateField}
            ${imagesField}
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" type="button" data-action="modal-close">取消</button>
            <button class="btn btn-primary" type="button" data-action="modal-save">保存修改</button>
          </div>
        </div>
      </div>`);

    requestAnimationFrame(() => {
      const title = $('#editTitle');
      const note = $('#editNote');
      const target = title || note;
      if (target) {
        target.focus({ preventScroll: true });
        const length = target.value.length;
        try {
          target.setSelectionRange(length, length);
        } catch (_) {
          /* ignore */
        }
      }
    });
  }

  async function saveEdit() {
    if (!ui.modal || ui.modal.kind !== 'edit') return;
    const item = state.items.find((entry) => entry.id === ui.modal.id);
    if (!item) {
      closeModal();
      return;
    }

    const titleEl = $('#editTitle');
    const noteEl = $('#editNote');
    let title = titleEl ? titleEl.value.trim() : item.title;
    let note = noteEl ? noteEl.value.trim() : item.note;

    if (item.type === 'daily') {
      if (!note) {
        nudge(noteEl);
        toast('内容不能为空。');
        return;
      }
      title = '';
    } else if (!title && !note && !(item.type === 'goods' && ui.modal.images.length)) {
      nudge(titleEl || noteEl);
      toast('内容不能为空。');
      return;
    } else if (!title) {
      const derived = deriveTitleNote(
        '',
        note,
        item.type === 'goods' ? '好物收藏' : '无标题计划'
      );
      title = derived.title;
      note = derived.note;
    }

    if (!beginBusy()) return;

    const updated = {
      ...item,
      title,
      note,
      updatedAt: new Date().toISOString()
    };
    if (item.type === 'plan') updated.dueDate = $('#editDate')?.value || '';
    if (item.type === 'goods') updated.images = [...ui.modal.images];

    let result;
    try {
      result = await remoteUpdate(updated);
    } catch (error) {
      result = syncFailure(error);
    } finally {
      endBusy();
    }
    if (!result?.ok) return;

    const index = state.items.findIndex((entry) => entry.id === item.id);
    if (index >= 0) state.items[index] = result.item || updated;
    persist();
    if (ui.modal?.kind === 'edit' && ui.modal.id === item.id) closeModal();
    renderAll();
    toast('修改已保存。');
  }

  function openGoodsDetail(id) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item) return;
    captureDraft();
    if (!ui.modal) ui.returnFocus = document.activeElement;
    ui.modal = { kind: 'detail', id, imageIndex: 0 };
    renderGoodsDetail(item);
  }

  function renderGoodsDetail(item) {
    const images = item.images;
    const gallery = images.length
      ? `<div class="detail-gallery">
           <div class="detail-main" data-action="lightbox-open" data-index="${ui.modal.imageIndex}" title="点击查看大图">
             <img id="detailMainImg" src="${esc(images[ui.modal.imageIndex])}" alt="${esc(titleOf(item))}">
           </div>
           ${
             images.length > 1
               ? `<div class="detail-thumbs">
                   ${images
                     .map(
                       (src, index) => `
                     <button class="detail-thumb ${index === ui.modal.imageIndex ? 'active' : ''}" type="button"
                       data-action="detail-image" data-index="${index}" aria-label="查看第 ${index + 1} 张图片">
                       <img src="${esc(src)}" alt="">
                     </button>`
                     )
                     .join('')}
                 </div>`
               : ''
           }
         </div>`
      : '';

    setModal(`
      <div class="modal-backdrop" id="modalBackdrop">
        <div class="modal detail-modal" role="dialog" aria-modal="true" aria-label="${esc(titleOf(item))}" tabindex="-1">
          <button class="modal-x" type="button" data-action="modal-close" aria-label="关闭">
            <svg class="icon"><use href="#i-close"></use></svg>
          </button>
          <div class="detail-layout ${gallery ? '' : 'no-images'}">
            ${gallery}
            <div class="detail-info">
              <div class="eyebrow">FINDS · 好物收藏</div>
              <h2 class="detail-title">${esc(titleOf(item))}</h2>
              <p class="detail-note ${item.note ? '' : 'is-empty'}">${item.note ? esc(item.note) : '还没有写下喜欢它的理由。'}</p>
              <div class="detail-meta">收藏于 ${esc(fullDate(item.createdAt))}</div>
              <div class="detail-actions">
                <button class="btn btn-ghost" type="button" data-action="edit" data-id="${esc(item.id)}">
                  <svg class="icon"><use href="#i-edit"></use></svg>编辑
                </button>
                <button class="btn btn-text btn-danger" type="button" data-action="delete" data-id="${esc(item.id)}">
                  <svg class="icon"><use href="#i-trash"></use></svg>删除
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>`);

    requestAnimationFrame(() => $('.detail-modal')?.focus({ preventScroll: true }));
  }

  function setDetailImage(index) {
    if (!ui.modal || ui.modal.kind !== 'detail') return;
    const item = state.items.find((entry) => entry.id === ui.modal.id);
    if (!item || !item.images[index]) return;
    ui.modal.imageIndex = index;
    const main = $('#detailMainImg');
    if (main) main.src = item.images[index];
    const mainWrap = $('.detail-main');
    if (mainWrap) mainWrap.dataset.index = String(index);
    $$('.detail-thumb').forEach((button, buttonIndex) => {
      button.classList.toggle('active', buttonIndex === index);
    });
  }

  /* =========================================================
     Lightbox
     ========================================================= */
  function openLightbox(images, index = 0) {
    if (!Array.isArray(images) || !images.length) return;
    ui.lightbox = { images, index: Math.max(0, Math.min(index, images.length - 1)) };
    renderLightbox();
  }

  function renderLightbox() {
    if (!ui.lightbox) return;
    const { images, index } = ui.lightbox;
    let root = $('#lightbox');
    if (!root) {
      root = document.createElement('div');
      root.id = 'lightbox';
      root.className = 'lightbox';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', '查看大图');
      document.body.appendChild(root);
    }
    root.innerHTML = `
      <button class="lightbox-close" type="button" data-action="lightbox-close" aria-label="关闭大图">
        <svg class="icon"><use href="#i-close"></use></svg>
      </button>
      ${
        images.length > 1
          ? `<button class="lightbox-nav prev" type="button" data-action="lightbox-prev" aria-label="上一张">
               <svg class="icon"><use href="#i-left"></use></svg>
             </button>
             <button class="lightbox-nav next" type="button" data-action="lightbox-next" aria-label="下一张">
               <svg class="icon"><use href="#i-right"></use></svg>
             </button>`
          : ''
      }
      <img src="${esc(images[index])}" alt="图片 ${index + 1}">
      <div class="lightbox-counter">${index + 1} / ${images.length}</div>`;
  }

  function moveLightbox(step) {
    if (!ui.lightbox) return;
    const total = ui.lightbox.images.length;
    ui.lightbox.index = (ui.lightbox.index + step + total) % total;
    renderLightbox();
  }

  function closeLightbox() {
    ui.lightbox = null;
    $('#lightbox')?.remove();
  }

  /* =========================================================
     Toast + confetti
     ========================================================= */
  function toast(message, options = {}) {
    const root = $('#toastRoot');
    if (!root) return;

    while (root.children.length >= 3) root.firstElementChild.remove();

    const node = document.createElement('div');
    node.className = 'toast';
    node.innerHTML = `
      <span class="toast-text">${esc(message)}</span>
      ${options.actionLabel ? `<button class="toast-action" type="button">${esc(options.actionLabel)}</button>` : ''}`;
    root.appendChild(node);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 220);
    };

    const timer = setTimeout(dismiss, options.duration ?? (options.actionLabel ? 6000 : 3600));

    if (options.actionLabel) {
      const action = $('.toast-action', node);
      action?.addEventListener('click', () => {
        clearTimeout(timer);
        dismiss();
        options.onAction?.();
      });
    }
  }

  function confetti(x, y) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const layer = $('#confettiLayer');
    if (!layer) return;
    const colors = ['#b45b39', '#5d7c57', '#b18a46', '#d98d64', '#8aa77f', '#e3bd7d'];
    const count = 20;

    for (let index = 0; index < count; index += 1) {
      const piece = document.createElement('span');
      piece.className = 'confetti-piece';
      piece.style.left = `${x}px`;
      piece.style.top = `${y}px`;
      piece.style.background = colors[index % colors.length];
      if (index % 3 === 0) piece.style.borderRadius = '50%';
      layer.appendChild(piece);

      const angle = (Math.PI * 2 * index) / count + Math.random() * 0.5;
      const distance = 40 + Math.random() * 95;
      const dx = Math.cos(angle) * distance;
      const dy = Math.sin(angle) * distance - 20;
      const rotation = Math.random() * 620 - 310;

      const animation = piece.animate(
        [
          { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
          {
            transform: `translate(${dx}px, ${dy + 90}px) rotate(${rotation}deg)`,
            opacity: 0
          }
        ],
        {
          duration: 680 + Math.random() * 420,
          easing: 'cubic-bezier(.15,.65,.35,1)'
        }
      );
      animation.onfinish = () => piece.remove();
    }
  }

  /* =========================================================
     Backup / restore / local data
     ========================================================= */
  function readLocalValue(key) {
    try {
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function writeLocalValue(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {
      /* ignore */
    }
  }

  function lastBackupDate() {
    const raw = readLocalValue(BACKUP_KEY);
    if (!raw) return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatBackupStamp() {
    const date = lastBackupDate();
    if (!date) return '还没有备份';
    const diff = dayDiff(dateKey(date));
    const time = timeHM(date.toISOString());
    if (diff === 0) return `今天 ${time}`;
    if (diff === -1) return `昨天 ${time}`;
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`;
  }

  function backupIsOverdue() {
    if (!state.items.length) return false;
    const date = lastBackupDate();
    if (!date) return true;
    return Date.now() - date.getTime() >= 7 * 86400000;
  }

  function markBackupDone() {
    writeLocalValue(BACKUP_KEY, new Date().toISOString());
    updateBackupIndicator();
  }

  function updateBackupIndicator() {
    const button = $('#dataButton');
    if (!button) return;
    const overdue = backupIsOverdue();
    button.classList.toggle('is-overdue', overdue);
    button.title = overdue ? '记录只在这台 iPhone 上，建议现在备份' : '备份与数据';
  }

  function isStandaloneApp() {
    try {
      return (
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true
      );
    } catch (_) {
      return false;
    }
  }

  function openDataModal() {
    if (ui.modal?.kind === 'data') return;
    if (!ui.modal) ui.returnFocus = document.activeElement;
    ui.modal = { kind: 'data' };
    renderDataModal();
  }

  function renderDataModal() {
    const imageCount = state.items.reduce(
      (sum, item) => sum + (Array.isArray(item.images) ? item.images.length : 0),
      0
    );
    const overdue = backupIsOverdue();
    const standalone = isStandaloneApp();
    const installTip = standalone
      ? '已从主屏幕打开，之后可以直接像 App 一样使用。'
      : '回到 Safari：点底部「分享」按钮 →「添加到主屏幕」，以后就能全屏打开。';

    setModal(`
      <div class="modal-backdrop" id="modalBackdrop">
        <div class="modal data-modal" role="dialog" aria-modal="true" aria-labelledby="dataModalTitle" tabindex="-1">
          <div class="modal-head">
            <div>
              <div class="eyebrow">LOCAL · 本机数据</div>
              <h2 id="dataModalTitle">数据与备份</h2>
            </div>
            <button class="modal-x" type="button" data-action="modal-close" aria-label="关闭">
              <svg class="icon"><use href="#i-close"></use></svg>
            </button>
          </div>
          <div class="modal-body">
            <div class="data-local-card">
              <span class="data-local-stamp">本</span>
              <div>
                <strong>只保存在这台 iPhone</strong>
                <p>不上传云端，也不会和别的设备同步。</p>
              </div>
            </div>
            <div class="data-stats">
              <div class="data-stat"><span>记录</span><strong>${state.items.length} 条</strong></div>
              <div class="data-stat"><span>图片</span><strong>${imageCount} 张</strong></div>
              <div class="data-stat"><span>上次备份</span><strong class="${overdue ? 'is-overdue' : ''}">${esc(formatBackupStamp())}</strong></div>
            </div>
            ${overdue ? `<p class="data-warning">iOS 可能在空间不足或长期不用时清理网站数据，建议现在备份一次。</p>` : `<p class="data-hint">备份会生成一个包含图片的 JSON 文件，建议保存到「文件」或 iCloud Drive。</p>`}
            <div class="data-install-tip">
              <svg class="icon"><use href="#i-download"></use></svg>
              <p>${esc(installTip)}</p>
            </div>
            <p class="modal-note">恢复时选择本应用导出的备份文件即可；恢复只会补充手机里没有的记录。</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" type="button" data-action="restore-data">
              <svg class="icon"><use href="#i-upload"></use></svg>从备份恢复
            </button>
            <button class="btn btn-primary" type="button" data-action="backup-data">
              <svg class="icon"><use href="#i-download"></use></svg>备份到文件
            </button>
          </div>
        </div>
      </div>`);

    requestAnimationFrame(() => $('.data-modal')?.focus({ preventScroll: true }));
  }

  let backupBusy = false;

  async function exportData() {
    if (!state.items.length) {
      toast('还没有可备份的内容。');
      return false;
    }
    if (backupBusy) return false;
    backupBusy = true;

    try {
      const payload = {
        app: '拾光备忘录',
        version: 1,
        exportedAt: new Date().toISOString(),
        items: state.items
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json'
      });
      const filename = `拾光备忘录-备份-${dateKey()}.json`;
      const file = new File([blob], filename, { type: 'application/json' });

      let shared = false;
      let canceled = false;
      let canShareFiles = false;
      try {
        canShareFiles = Boolean(navigator.canShare && navigator.canShare({ files: [file] }));
      } catch (_) {
        canShareFiles = false;
      }

      if (canShareFiles) {
        try {
          await navigator.share({
            files: [file],
            title: '拾光备忘录备份',
            text: '保存到「文件」或 iCloud Drive。'
          });
          shared = true;
        } catch (error) {
          if (error?.name === 'AbortError') canceled = true;
        }
      }

      if (canceled) return false;

      if (!shared) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      }

      markBackupDone();
      if (ui.modal?.kind === 'data') renderDataModal();
      toast(
        shared
          ? '备份已准备好，请保存到「文件」或 iCloud Drive。'
          : '备份文件已下载。'
      );
      return true;
    } finally {
      backupBusy = false;
    }
  }

  function maybeRemindBackup() {
    if (!backupIsOverdue()) return;
    const now = Date.now();
    const lastReminder = Number(readLocalValue(BACKUP_REMINDER_KEY) || 0);
    if (lastReminder && now - lastReminder < 3 * 86400000) return;
    writeLocalValue(BACKUP_REMINDER_KEY, String(now));
    setTimeout(() => {
      toast('记录只保存在这台 iPhone 上，建议做一次备份。', {
        actionLabel: '去备份',
        duration: 9000,
        onAction: openDataModal
      });
    }, 2000);
  }

  async function importData(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const incoming = Array.isArray(parsed) ? parsed : parsed.items;
      if (!Array.isArray(incoming)) throw new Error('格式不正确');

      const seen = new Set(state.items.map((item) => item.id));
      const additions = [];
      incoming.forEach((raw) => {
        const item = normalizeItem(raw);
        if (item && !seen.has(item.id)) {
          seen.add(item.id);
          additions.push(item);
        }
      });

      if (!additions.length) {
        toast('没有新的记录可恢复。');
        return;
      }

      if (!beginBusy()) return;
      let result;
      try {
        result = await remoteImport(additions);
      } catch (error) {
        result = syncFailure(error);
      } finally {
        endBusy();
      }
      if (!result?.ok) return;

      const added = Array.isArray(result.items) ? result.items : additions;
      const existing = new Set(state.items.map((item) => item.id));
      added.forEach((item) => {
        if (!existing.has(item.id)) {
          existing.add(item.id);
          state.items.push(item);
        }
      });

      persist();
      renderAll();
      if (added.length) toast(`已恢复 ${added.length} 条记录。`);
      else toast('没有新的记录可恢复。');
    } catch (_) {
      toast('恢复失败，请选择由本应用导出的备份文件。');
    }
  }

  /* =========================================================
     Events
     ========================================================= */
  function bindEvents() {
    document.addEventListener('click', (event) => {
      const target = event.target.closest?.('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      const id = target.dataset.id;

      switch (action) {
        case 'nav':
          switchSection(target.dataset.section);
          break;
        case 'add-plan':
          addPlan();
          break;
        case 'add-daily':
          addDaily();
          break;
        case 'add-goods':
          addGoods();
          break;
        case 'complete':
          completeItem(id, target);
          break;
        case 'undo-complete':
          undoComplete(id);
          break;
        case 'delete':
          deleteItem(id);
          break;
        case 'edit':
          openEditModal(id);
          break;
        case 'clear-done':
          clearDone();
          break;
        case 'empty-cta': {
          const emptyTarget = target.dataset.target;
          if (emptyTarget === 'plan-section') switchSection('plan');
          else focusComposer(emptyTarget);
          break;
        }
        case 'clear-search':
          clearSearch();
          break;
        case 'focus-composer':
          focusComposer(target.dataset.target || state.section);
          break;
        case 'pick-images':
          event.preventDefault();
          pickImages(target.dataset.target || 'composer');
          break;
        case 'remove-image': {
          const index = Number(target.dataset.index);
          if (target.dataset.target === 'modal') {
            if (ui.modal?.images) {
              ui.modal.images.splice(index, 1);
              refreshModalImages();
            }
          } else if (Number.isInteger(index)) {
            pendingImages.splice(index, 1);
            refreshComposerImages();
          }
          break;
        }
        case 'modal-close':
          closeModal();
          break;
        case 'modal-save':
          saveEdit();
          break;
        case 'open-goods':
          openGoodsDetail(id);
          break;
        case 'detail-image':
          setDetailImage(Number(target.dataset.index));
          break;
        case 'lightbox-open': {
          if (!ui.modal || ui.modal.kind !== 'detail') break;
          const item = state.items.find((entry) => entry.id === ui.modal.id);
          if (item) openLightbox(item.images, Number(target.dataset.index) || 0);
          break;
        }
        case 'lightbox-close':
          closeLightbox();
          break;
        case 'lightbox-prev':
          moveLightbox(-1);
          break;
        case 'lightbox-next':
          moveLightbox(1);
          break;
        case 'export':
          exportData();
          break;
        case 'import':
          $('#importInput').click();
          break;
        case 'open-data':
          openDataModal();
          break;
        case 'backup-data':
          exportData();
          break;
        case 'restore-data':
          closeModal();
          $('#importInput').click();
          break;
        default:
          break;
      }
    });

    $('#modalRoot').addEventListener('click', (event) => {
      if (event.target.id === 'modalBackdrop') closeModal();
    });

    document.addEventListener('click', (event) => {
      if (event.target?.id === 'lightbox') closeLightbox();
    });

    $('#searchInput').addEventListener('input', (event) => {
      state.search = event.target.value;
      $('#searchClear').hidden = !state.search.trim();
      renderContent();
    });

    $('#imageInput').addEventListener('change', async (event) => {
      const files = [...(event.target.files || [])];
      const target = ui.imageTarget;
      event.target.value = '';
      ui.imageTarget = null;
      if (files.length && target) await addImages(files, target);
    });

    $('#importInput').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) await importData(file);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (ui.lightbox) {
          closeLightbox();
          return;
        }
        if (ui.modal) {
          closeModal();
          return;
        }
        if (state.search) {
          clearSearch();
          return;
        }
        if (document.activeElement?.matches?.('input, textarea')) {
          document.activeElement.blur();
        }
        return;
      }

      if (ui.lightbox) {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          moveLightbox(-1);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          moveLightbox(1);
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        if (ui.modal?.kind === 'edit') {
          event.preventDefault();
          saveEdit();
          return;
        }
        if (ui.modal) return;
        event.preventDefault();
        if (state.section === 'plan') addPlan();
        else if (state.section === 'daily') addDaily();
        else if (state.section === 'goods') addGoods();
      }
    });

    document.addEventListener('dragover', (event) => {
      const zone = event.target.closest?.('.image-drop');
      if (!zone) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      zone.classList.add('dragging');
    });

    document.addEventListener('dragleave', (event) => {
      const zone = event.target.closest?.('.image-drop');
      if (zone) zone.classList.remove('dragging');
    });

    document.addEventListener('drop', (event) => {
      const zone = event.target.closest?.('.image-drop');
      if (!zone) return;
      event.preventDefault();
      zone.classList.remove('dragging');
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length) addImages(files, zone.dataset.target);
    });

    document.addEventListener('paste', (event) => {
      const files = [...(event.clipboardData?.files || [])].filter((file) =>
        file.type.startsWith('image/')
      );
      if (!files.length) return;

      let target = null;
      if (ui.modal?.kind === 'edit' && $('#modalImages')) target = 'modal';
      else if (state.section === 'goods' && $('#composerImages')) target = 'composer';

      if (target) {
        event.preventDefault();
        addImages(files, target);
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && sync.mode === 'shared') pollServer();
    });

    window.addEventListener('storage', (event) => {
      if (sync.mode !== 'local') return;
      if (event.key !== LS_KEY) return;
      try {
        const parsed = JSON.parse(event.newValue || '{}');
        if (Array.isArray(parsed.items)) {
          state.items = normalizeItems(parsed.items);
          renderAll();
        }
      } catch (_) {
        /* ignore */
      }
    });
  }

  /* =========================================================
     Boot
     ========================================================= */
  async function migrateLocalCache(cachedItems) {
    let remembered = null;
    try {
      remembered = localStorage.getItem(MIGRATION_FLAG);
    } catch (_) {
      return '';
    }
    if (remembered) return '';

    let message = '';
    if (!state.items.length && cachedItems.length) {
      try {
        const result = await apiRequest('/api/import', {
          method: 'POST',
          body: JSON.stringify({ items: cachedItems }),
          timeout: 45000
        });
        applyRevision(result.revision);
        const refreshed = await fetchServerState();
        if (Array.isArray(refreshed.items)) state.items = normalizeItems(refreshed.items);
        message = `已把本机 ${cachedItems.length} 条记录合并到共享备忘录。`;
      } catch (_) {
        message = '本机记录暂时没有合并成功，可以用左下角的「恢复」手动迁移。';
      }
    }

    try {
      localStorage.setItem(MIGRATION_FLAG, '1');
    } catch (_) {
      /* ignore */
    }
    return message;
  }

  async function init() {
    bindEvents();
    renderDates();
    sync.mode = 'local';
    setSyncStatus('local');
    state.items = await loadData();
    renderAll();
    updateBackupIndicator();

    const boot = $('#boot');
    if (boot) {
      boot.classList.add('is-hidden');
      setTimeout(() => boot.remove(), 500);
    }

    setTimeout(maybeRemindBackup, 2200);

    try {
      navigator.storage?.persist?.().catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  init().catch((error) => {
    console.error(error);
    const boot = $('#boot');
    if (boot) boot.remove();
    toast('打开备忘录时出了点问题，刷新页面试试。');
  });
})();
