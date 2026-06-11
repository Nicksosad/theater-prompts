import { getContext } from '../../../extensions.js';

const EXTENSION_NAME = 'theater-prompts';
const STORAGE_KEY = 'theaterPrompts.settings';
const DEFAULT_BASE_URL = 'http://localhost:7788';
const MAX_RANDOM_COUNT = 50;
const MATCH_LIMIT = 8;
const MESSAGE_SAVE_BUTTON_CLASS = 'theater-prompts-message-save-button';

const state = {
    prompts: [],
    tags: [],
    selectedTags: [],
    searchQuery: '',
    randomCount: 10,
    randomPrompts: null,
    detailPrompt: null,
    lastUsedPrompt: null,
    pendingSave: null,
    view: 'main',
    baseUrl: DEFAULT_BASE_URL,
    authToken: '',
    authPassword: '',
    loading: false,
    saving: false,
    error: '',
};

let searchRenderTimer = null;
let messageButtonsObserver = null;

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        state.baseUrl = String(saved.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
        state.authToken = String(saved.authToken || '').trim();
        state.authPassword = String(saved.authPassword || '').trim();
        state.randomCount = clampRandomCount(saved.randomCount || 10);
        state.selectedTags = Array.isArray(saved.selectedTags) ? saved.selectedTags.map(tag => String(tag || '').trim()).filter(Boolean) : [];
    } catch {
        state.baseUrl = DEFAULT_BASE_URL;
    }
}

function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        baseUrl: state.baseUrl,
        authToken: state.authToken,
        authPassword: state.authPassword,
        randomCount: state.randomCount,
        selectedTags: state.selectedTags,
    }));
}

function clampRandomCount(value) {
    const count = Number.parseInt(String(value), 10);
    if (!Number.isFinite(count) || count < 1) return 1;
    return Math.min(count, MAX_RANDOM_COUNT);
}

function normalizeBaseUrl(value) {
    return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function normalizePrompt(raw) {
    const tags = Array.isArray(raw?.tags) ? raw.tags.map(tag => String(tag || '').trim()).filter(Boolean) : [];
    return {
        id: Number(raw?.id || 0),
        title: String(raw?.title || '').trim() || '未命名提示词',
        content: String(raw?.content || ''),
        tags,
        createdAt: String(raw?.createdAt || ''),
    };
}

function stripMarkup(value) {
    return String(value || '')
        .replace(/```(?:html)?\s*([\s\S]*?)\s*```/gi, '$1')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function getMessageText(message) {
    return stripMarkup(message?.mes || message?.message || '');
}

function normalizeMatchText(value) {
    return stripMarkup(value).toLowerCase();
}

function getMatchTerms(value) {
    const text = normalizeMatchText(value);
    const terms = new Set();
    const asciiWords = text.match(/[a-z0-9_]{2,}/g) || [];
    asciiWords.forEach(word => terms.add(word));

    const cjkText = (text.match(/[\u4e00-\u9fff]+/g) || []).join('');
    for (let index = 0; index < cjkText.length - 1; index++) {
        terms.add(cjkText.slice(index, index + 2));
    }
    for (let index = 0; index < cjkText.length - 2; index++) {
        terms.add(cjkText.slice(index, index + 3));
    }
    return terms;
}

function scorePromptMatch(userText, prompt) {
    const source = normalizeMatchText(userText);
    if (!source) return 0;

    const title = normalizeMatchText(prompt.title);
    const tags = Array.isArray(prompt.tags) ? prompt.tags.map(normalizeMatchText).filter(Boolean) : [];
    const content = normalizeMatchText(prompt.content);
    const sourceTerms = getMatchTerms(source);
    const promptTerms = getMatchTerms(`${prompt.title} ${tags.join(' ')} ${prompt.content}`);
    let score = 0;

    if (title && source.includes(title)) score += 120;
    tags.forEach(tag => {
        if (tag && source.includes(tag)) score += 35;
    });

    sourceTerms.forEach(term => {
        if (!promptTerms.has(term)) return;
        score += term.length >= 3 ? 2 : 1;
    });

    const contentWindows = content.match(/[\s\S]{12,80}/g) || [];
    contentWindows.slice(0, 40).forEach(windowText => {
        const compact = windowText.trim();
        if (compact.length >= 12 && source.includes(compact)) score += Math.min(80, compact.length);
    });

    return score;
}

function findRelatedPrompts(userText) {
    return state.prompts
        .map(prompt => ({ prompt, score: scorePromptMatch(userText, prompt) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || String(a.prompt.title).localeCompare(String(b.prompt.title), 'zh-Hans-CN'))
        .slice(0, MATCH_LIMIT);
}

function findLastCharacterMessage(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (isSaveableCharacterMessage(message)) {
            return { message, index };
        }
    }
    return null;
}

function findPreviousUserMessage(messages, beforeIndex) {
    for (let index = beforeIndex - 1; index >= 0; index--) {
        const message = messages[index];
        if (getMessageText(message) && message?.is_user) {
            return { message, index };
        }
    }
    return null;
}

function isSaveableCharacterMessage(message) {
    return Boolean(getMessageText(message) && !message?.is_user);
}

function getRequestHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (state.authToken) headers.Authorization = `Bearer ${state.authToken}`;
    return headers;
}

function syncAuthPasswordFromInput() {
    const passwordInput = document.getElementById('theater_prompts_auth_password');
    if (passwordInput) state.authPassword = String(passwordInput.value || '');
    return state.authPassword;
}

async function loginWithPassword(password) {
    const cleanPassword = String(password || '');
    if (!cleanPassword) throw new Error('请在设置里输入小剧场管理器密码');
    const response = await fetch(`${state.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: cleanPassword }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.token) {
        throw new Error(payload?.error || (response.status === 401 ? '密码错误' : `HTTP ${response.status}`));
    }
    state.authToken = String(payload.token || '').trim();
    saveSettings();
    return state.authToken;
}

async function fetchWithAuthRetry(url, options = {}) {
    syncAuthPasswordFromInput();
    const legacyPassword = state.authPassword ? '' : state.authToken;
    const requestOptions = {
        ...options,
        headers: {
            ...(options.headers || {}),
        },
    };
    if (state.authToken && !requestOptions.headers.Authorization) {
        requestOptions.headers.Authorization = `Bearer ${state.authToken}`;
    }

    if (!state.authToken && state.authPassword) {
        const token = await loginWithPassword(state.authPassword);
        requestOptions.headers.Authorization = `Bearer ${token}`;
    }

    let response = await fetch(url, requestOptions);
    if (response.status !== 401) return response;

    state.authToken = '';
    saveSettings();
    syncAuthPasswordFromInput();
    if (!state.authPassword && legacyPassword) {
        state.authPassword = legacyPassword;
    }
    if (!state.authPassword) return response;

    const token = await loginWithPassword(state.authPassword);
    response = await fetch(url, {
        ...requestOptions,
        headers: {
            ...(requestOptions.headers || {}),
            Authorization: `Bearer ${token}`,
        },
    });
    return response;
}

async function fetchPrompts() {
    state.loading = true;
    state.error = '';
    renderPanel();

    try {
        const response = await fetchWithAuthRetry(`${state.baseUrl}/api/data`);
        if (response.status === 401) throw new Error('未授权：请在设置里输入小剧场管理器密码后重新刷新');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        state.prompts = (Array.isArray(payload?.prompts) ? payload.prompts : [])
            .map(normalizePrompt)
            .filter(prompt => prompt.id > 0 || prompt.title || prompt.content);
        state.tags = Array.from(new Set(state.prompts.flatMap(prompt => prompt.tags))).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        state.selectedTags = state.selectedTags.filter(tag => state.tags.includes(tag));
        state.randomPrompts = null;
        state.detailPrompt = null;
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] 读取提示词失败`, error);
        state.error = `读取提示词失败：${error.message || error}`;
    } finally {
        state.loading = false;
        renderPanel();
    }
}

function getFilteredPrompts() {
    const query = state.searchQuery.trim().toLowerCase();
    return state.prompts.filter(prompt => {
        if (state.selectedTags.length > 0 && !state.selectedTags.every(tag => prompt.tags.includes(tag))) return false;
        if (!query) return true;
        const haystacks = [prompt.title, prompt.tags.join(' ')];
        return haystacks.some(value => String(value || '').toLowerCase().includes(query));
    });
}

function getDisplayedPrompts() {
    return state.randomPrompts || getFilteredPrompts();
}

function syncSettingsInputs() {
    const baseUrlInput = document.getElementById('theater_prompts_base_url');
    const passwordInput = document.getElementById('theater_prompts_auth_password');
    const randomCountInput = document.getElementById('theater_prompts_random_count');
    if (baseUrlInput) state.baseUrl = normalizeBaseUrl(baseUrlInput.value);
    if (passwordInput) state.authPassword = String(passwordInput.value || '');
    if (randomCountInput) state.randomCount = clampRandomCount(randomCountInput.value);
    saveSettings();
}

function randomPick() {
    const source = getFilteredPrompts();
    const count = Math.min(state.randomCount, source.length);
    const shuffled = [...source];
    for (let index = shuffled.length - 1; index > 0; index--) {
        const randomIndex = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
    }
    state.randomPrompts = shuffled.slice(0, count);
    state.detailPrompt = null;
    state.view = 'main';
    renderPanel();
    showToast(source.length < state.randomCount ? `当前筛选范围只有 ${source.length} 条，已全部显示` : `已随机抽取 ${count} 条`);
}

async function copyText(text, successMessage = '已复制') {
    const value = String(text || '');
    if (!value) {
        showToast('没有可复制的内容', 'warning');
        return;
    }

    try {
        await navigator.clipboard.writeText(value);
    } catch {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
    }
    showToast(successMessage);
}

function insertIntoInput(text, mode = 'replace') {
    const textarea = document.getElementById('send_textarea');
    if (!textarea) {
        showToast('未找到酒馆输入框', 'error');
        return;
    }

    const value = String(text || '');
    if (!value) {
        showToast('没有可插入的内容', 'warning');
        return;
    }

    if (mode === 'append' && textarea.value.trim()) {
        textarea.value = `${textarea.value}\n\n${value}`;
    } else {
        textarea.value = value;
    }

    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
    showToast(mode === 'append' ? '已追加到输入框' : '已插入到输入框');
}

async function startLastAiSaveFlow() {
    const context = getContext();
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const foundCharacter = findLastCharacterMessage(messages);

    if (!foundCharacter) {
        showToast('没有找到可保存的助手回复', 'warning');
        return;
    }

    await startMessageSaveFlow(foundCharacter.index);
}

async function startMessageSaveFlow(messageIndex) {
    const context = getContext();
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const index = Number.parseInt(String(messageIndex), 10);
    const message = messages[index];

    if (!Number.isInteger(index) || !isSaveableCharacterMessage(message)) {
        showToast('没有找到可保存的角色回复', 'warning');
        return;
    }

    getPanel().classList.remove('hidden');
    syncSettingsInputs();

    if (state.prompts.length === 0 && !state.loading) {
        await fetchPrompts();
    }

    const foundUser = findPreviousUserMessage(messages, index);
    const userText = getMessageText(foundUser?.message);
    const matches = findRelatedPrompts(userText);
    state.pendingSave = {
        message,
        userMessage: foundUser?.message || null,
        userText,
        matches,
    };
    state.view = 'link-save';
    renderPanel();
}

async function saveLastAiMessage(prompt = undefined) {
    const context = getContext();
    const message = state.pendingSave?.message;

    if (state.saving) return;

    if (!message) {
        showToast('没有找到待保存的助手回复', 'warning');
        return;
    }

    state.saving = true;
    renderPanel();
    showToast('正在保存到小剧场管理器...', 'info');

    const linkedPrompt = prompt === undefined ? (state.lastUsedPrompt || state.detailPrompt || null) : prompt;
    const promptTitle = linkedPrompt?.title || '未关联提示词';
    const item = {
        id: Date.now() + 1,
        roleName: String(message.name || context?.name2 || '未知角色').trim() || '未知角色',
        roleHandle: '',
        promptTitle,
        promptTitles: [promptTitle],
        content: String(message.mes || message.message || '').trim(),
        createdAt: new Date().toISOString(),
        likes: 0,
        shares: 0,
        mediaMode: 'none',
        mediaImage: '',
    };

    try {
        const response = await fetchWithAuthRetry(`${state.baseUrl}/api/theaters`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(item),
        });
        if (response.status === 401) throw new Error('未授权：请在设置里输入小剧场管理器密码后重试');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.pendingSave = null;
        state.view = 'settings';
        closePanel();
        showToast('已保存角色回复到小剧场管理器');
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] 保存小剧场失败`, error);
        showToast(`保存失败：${error.message || error}`, 'error');
    } finally {
        state.saving = false;
        if (!getPanel().classList.contains('hidden')) renderPanel();
    }
}

function markPromptUsed(prompt) {
    state.lastUsedPrompt = prompt;
}

function showToast(message, type = 'success') {
    if (globalThis.toastr?.[type]) {
        globalThis.toastr[type](message);
    } else {
        console.log(`[${EXTENSION_NAME}] ${message}`);
    }
}

function getPanel() {
    let panel = document.getElementById('theater_prompts_panel');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'theater_prompts_panel';
    panel.className = 'theater-prompts-panel hidden';
    document.body.appendChild(panel);
    return panel;
}

function openPanel() {
    getPanel().classList.remove('hidden');
    state.view = 'main';
    renderPanel();
    if (state.prompts.length === 0 && !state.loading) fetchPrompts();
}

function closePanel() {
    getPanel().classList.add('hidden');
}

function renderPanel() {
    const panel = getPanel();
    const filteredCount = getFilteredPrompts().length;
    const displayedPrompts = getDisplayedPrompts();
    const isRandomView = Array.isArray(state.randomPrompts);

    panel.innerHTML = `
        <div class="theater-prompts-backdrop" data-action="close"></div>
        <section class="theater-prompts-window">
            ${renderCurrentView(displayedPrompts, filteredCount, isRandomView)}
        </section>
    `;

    bindPanelEvents(panel);
}

function renderCurrentView(prompts, filteredCount, isRandomView) {
    if (state.view === 'settings') return renderSettings();
    if (state.view === 'tags') return renderTags();
    if (state.view === 'link-save') return renderLinkSave();
    if (state.view === 'detail' && state.detailPrompt) return renderDetail(state.detailPrompt);
    return renderMain(prompts, filteredCount, isRandomView);
}

function renderHeader(title, subtitle, leftAction = '', rightAction = 'close') {
    const left = leftAction
        ? `<button class="theater-prompts-plain-icon" type="button" data-action="${leftAction}">←</button>`
        : '<div class="theater-prompts-header-spacer"></div>';
    const right = rightAction
        ? `<button class="theater-prompts-plain-icon" type="button" data-action="${rightAction}">${rightAction === 'settings' ? '⚙' : '×'}</button>`
        : '<div class="theater-prompts-header-spacer"></div>';

    return `
        <header class="theater-prompts-header">
            ${left}
            <div>
                <h3>${escapeHtml(title)}</h3>
                <p>${escapeHtml(subtitle || '')}</p>
            </div>
            ${right}
        </header>
    `;
}

function renderMain(prompts, filteredCount, isRandomView) {
    const tagText = state.selectedTags.length > 0 ? `已选 ${state.selectedTags.length} 个标签` : '全部标签';
    return `
        <header class="theater-prompts-header">
            <div>
                <h3>小剧场提示词库</h3>
                <p>${isRandomView ? `抽取结果 ${prompts.length} 条` : `当前显示 ${prompts.length} 条`}</p>
            </div>
            <span style="display:flex;gap:8px;margin-left:auto;">
                <button class="theater-prompts-plain-icon" type="button" data-action="open-tags" title="${escapeHtml(tagText)}"><span class="fa-solid fa-tags"></span></button>
                <button class="theater-prompts-plain-icon" type="button" data-action="settings" title="设置"><span class="fa-solid fa-gear"></span></button>
                <button class="theater-prompts-plain-icon" type="button" data-action="close" title="关闭"><span class="fa-solid fa-xmark"></span></button>
            </span>
        </header>
        <div class="theater-prompts-main-toolbar">
            <input id="theater_prompts_search" type="search" value="${escapeHtml(state.searchQuery)}" placeholder="搜索提示词或关键字...">
            <button class="menu_button theater-prompts-random-button" type="button" data-action="random"><span class="fa-solid fa-shuffle"></span>随机抽取</button>
            ${isRandomView ? '<button class="menu_button" type="button" data-action="clear-random">清除</button>' : ''}
        </div>
        ${state.error ? `<div class="theater-prompts-error">${escapeHtml(state.error)}</div>` : ''}
        ${state.loading ? '<div class="theater-prompts-empty">正在读取提示词...</div>' : renderPromptList(prompts, filteredCount, isRandomView)}
    `;
}

function renderSettings() {
    return `
        ${renderHeader('设置', '连接与随机抽取', 'back-main', '')}
        <div class="theater-prompts-page-body">
            <label class="theater-prompts-form-group">
                管理器地址
                <input id="theater_prompts_base_url" type="text" value="${escapeHtml(state.baseUrl)}" placeholder="http://localhost:7788">
            </label>
            <label class="theater-prompts-form-group">
                管理器密码（可选）
                <input id="theater_prompts_auth_password" type="password" value="${escapeHtml(state.authPassword)}" placeholder="密码保护关闭时留空">
            </label>
            <label class="theater-prompts-form-group">
                随机数量
                <input id="theater_prompts_random_count" type="number" min="1" max="${MAX_RANDOM_COUNT}" value="${state.randomCount}">
            </label>
            <button class="theater-prompts-block-button" type="button" data-action="refresh">刷新提示词</button>
            <button class="theater-prompts-block-button" type="button" data-action="save-last-ai">保存最后一条助手回复</button>
        </div>
    `;
}

function renderTags() {
    return `
        ${renderHeader('选择标签', state.selectedTags.length > 0 ? `已选择 ${state.selectedTags.length} 个` : '未选择标签', 'back-main', '')}
        <div class="theater-prompts-page-body">
            <div class="theater-prompts-tag-grid">
                <button class="theater-prompts-tag-option ${state.selectedTags.length === 0 ? 'active' : ''}" type="button" data-action="clear-tags">全部标签</button>
                ${state.tags.map(tag => `<button class="theater-prompts-tag-option ${state.selectedTags.includes(tag) ? 'active' : ''}" type="button" data-action="toggle-tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join('')}
            </div>
            <button class="theater-prompts-block-button" type="button" data-action="back-main">应用筛选</button>
        </div>
    `;
}

function renderLinkSave() {
    const pending = state.pendingSave;
    if (!pending) return renderSettings();
    const saveLabel = state.saving ? '保存中...' : '不关联，直接保存';
    return `
        ${renderHeader('选择关联提示词', `找到 ${pending.matches.length} 个推荐关联`, 'settings', '')}
        <div class="theater-prompts-page-body">
            ${renderPromptLinkCandidates(pending.matches)}
            <div class="theater-prompts-detail-actions">
                <button class="theater-prompts-block-button" type="button" data-action="save-unlinked" ${state.saving ? 'disabled' : ''}>${saveLabel}</button>
                <button class="menu_button" type="button" data-action="settings">取消</button>
            </div>
        </div>
    `;
}

function renderPromptLinkCandidates(matches) {
    if (!matches.length) {
        return '<div class="theater-prompts-empty">没有匹配到提示词，可以直接保存为未关联。</div>';
    }

    return `
        <div class="theater-prompts-link-list">
            ${matches.map(({ prompt }) => `
                <article class="theater-prompts-item">
                    <div class="theater-prompts-title-row">
                        <strong>${escapeHtml(prompt.title)}</strong>
                        <span class="theater-prompts-item-actions">
                            <button class="menu_button" type="button" data-action="save-linked" data-prompt-id="${escapeHtml(prompt.id)}" ${state.saving ? 'disabled' : ''}>${state.saving ? '保存中...' : '关联并保存'}</button>
                        </span>
                    </div>
                    ${prompt.tags.length ? `<div class="theater-prompts-tags">${prompt.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
                </article>
            `).join('')}
        </div>
    `;
}

function renderPromptList(prompts, filteredCount, isRandomView) {
    if (state.prompts.length === 0) {
        return '<div class="theater-prompts-empty">暂无提示词。请确认小剧场管理器已启动并有提示词数据。</div>';
    }

    if (prompts.length === 0) {
        return `<div class="theater-prompts-empty">当前筛选范围没有提示词${filteredCount === 0 ? '' : `（筛选结果 ${filteredCount} 条）`}。</div>`;
    }

    return `
        <div class="theater-prompts-list">
            ${prompts.map(prompt => `
                <article class="theater-prompts-item" data-prompt-id="${escapeHtml(prompt.id)}">
                    <div class="theater-prompts-item-main">
                        <div class="theater-prompts-title-row">
                            <strong>${escapeHtml(prompt.title)}</strong>
                            <span class="theater-prompts-item-actions">
                                <button class="menu_button" type="button" data-action="detail" data-prompt-id="${escapeHtml(prompt.id)}">查看</button>
                                <button class="menu_button" type="button" data-action="copy" data-prompt-id="${escapeHtml(prompt.id)}">复制</button>
                            </span>
                        </div>
                        ${prompt.tags.length ? `<div class="theater-prompts-tags">${prompt.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
                    </div>
                </article>
            `).join('')}
        </div>
    `;
}

function renderDetail(prompt) {
    return `
        ${renderHeader('详情', '完整提示词', 'back-main', 'close')}
        <div class="theater-prompts-detail">
            <h4>${escapeHtml(prompt.title)}</h4>
            ${prompt.tags.length ? `<div class="theater-prompts-tags">${prompt.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
            <textarea class="theater-prompts-content" readonly>${escapeHtml(prompt.content)}</textarea>
            <div class="theater-prompts-detail-actions">
                <button class="menu_button" type="button" data-action="copy-detail">复制全文</button>
                <button class="menu_button" type="button" data-action="insert-detail">插入输入框</button>
                <button class="menu_button" type="button" data-action="append-detail">追加到输入框</button>
            </div>
        </div>
    `;
}

function findPromptById(id) {
    return state.prompts.find(prompt => String(prompt.id) === String(id));
}

function bindPanelEvents(panel) {
    panel.querySelectorAll('[data-action]').forEach(element => {
        element.addEventListener('click', async event => {
            const action = event.currentTarget.dataset.action;
            const prompt = findPromptById(event.currentTarget.dataset.promptId);

            if (action === 'close') closePanel();
            if (action === 'settings') {
                state.view = 'settings';
                state.pendingSave = null;
                renderPanel();
            }
            if (action === 'open-tags') {
                state.view = 'tags';
                renderPanel();
            }
            if (action === 'back-main') {
                state.view = 'main';
                state.detailPrompt = null;
                renderPanel();
            }
            if (action === 'refresh') {
                syncSettingsInputs();
                await fetchPrompts();
            }
            if (action === 'clear-tags') {
                state.selectedTags = [];
                state.randomPrompts = null;
                saveSettings();
                renderPanel();
            }
            if (action === 'toggle-tag') {
                const tag = String(event.currentTarget.dataset.tag || '').trim();
                if (!tag) return;
                state.selectedTags = state.selectedTags.includes(tag)
                    ? state.selectedTags.filter(item => item !== tag)
                    : [...state.selectedTags, tag];
                state.randomPrompts = null;
                saveSettings();
                renderPanel();
            }
            if (action === 'random') {
                syncSettingsInputs();
                randomPick();
            }
            if (action === 'clear-random') {
                state.randomPrompts = null;
                renderPanel();
            }
            if (action === 'detail' && prompt) {
                state.detailPrompt = prompt;
                state.view = 'detail';
                renderPanel();
            }
            if (action === 'copy' && prompt) {
                markPromptUsed(prompt);
                await copyText(prompt.content, `已复制：${prompt.title}`);
            }
            if (action === 'copy-detail' && state.detailPrompt) {
                markPromptUsed(state.detailPrompt);
                await copyText(state.detailPrompt.content, `已复制：${state.detailPrompt.title}`);
            }
            if (action === 'insert-detail' && state.detailPrompt) {
                markPromptUsed(state.detailPrompt);
                insertIntoInput(state.detailPrompt.content, 'replace');
            }
            if (action === 'append-detail' && state.detailPrompt) {
                markPromptUsed(state.detailPrompt);
                insertIntoInput(state.detailPrompt.content, 'append');
            }
            if (action === 'save-last-ai') {
                syncSettingsInputs();
                await startLastAiSaveFlow();
            }
            if (action === 'save-linked' && prompt) {
                await saveLastAiMessage(prompt);
            }
            if (action === 'save-unlinked') {
                await saveLastAiMessage(null);
            }
        });
    });

    const baseUrlInput = panel.querySelector('#theater_prompts_base_url');
    const passwordInput = panel.querySelector('#theater_prompts_auth_password');
    const searchInput = panel.querySelector('#theater_prompts_search');
    const randomCountInput = panel.querySelector('#theater_prompts_random_count');

    baseUrlInput?.addEventListener('change', event => {
        state.baseUrl = normalizeBaseUrl(event.target.value);
        saveSettings();
        renderPanel();
    });
    passwordInput?.addEventListener('change', event => {
        state.authPassword = String(event.target.value || '');
        state.authToken = '';
        saveSettings();
    });
    searchInput?.addEventListener('input', event => {
        state.searchQuery = event.target.value;
        state.randomPrompts = null;
        clearTimeout(searchRenderTimer);
        searchRenderTimer = setTimeout(renderPanel, 250);
    });
    randomCountInput?.addEventListener('change', event => {
        state.randomCount = clampRandomCount(event.target.value);
        saveSettings();
        renderPanel();
    });
}

function addExtensionButton() {
    if (document.getElementById('theater_prompts_wand_button')) return;

    const container = document.getElementById('token_counter_wand_container') || document.getElementById('extensionsMenu');
    if (!container) return;

    const button = document.createElement('div');
    button.id = 'theater_prompts_wand_button';
    button.className = 'list-group-item flex-container flexGap5';
    button.innerHTML = '<div class="fa-solid fa-masks-theater extensionsMenuExtensionButton"></div>小剧场提示词库';
    button.addEventListener('click', openPanel);
    container.appendChild(button);
}

function getMessageIndexFromElement(messageElement) {
    const attributes = ['mesid', 'data-message-id', 'data-mes-id', 'data-index', 'data-message-index'];
    for (const attribute of attributes) {
        const rawValue = messageElement.getAttribute(attribute);
        if (rawValue === null) continue;
        const value = Number.parseInt(rawValue, 10);
        if (Number.isInteger(value) && value >= 0) return value;
    }

    const messages = Array.from(document.querySelectorAll('#chat .mes, .mes'));
    const index = messages.indexOf(messageElement);
    return index >= 0 ? index : null;
}

function findExtraMessageButtonsContainer(messageElement) {
    const hint = messageElement.querySelector('.extraMesButtonsHint');
    return messageElement.querySelector('.extraMesButtons')
        || hint?.parentElement?.querySelector('.extraMesButtons')
        || (hint?.nextElementSibling?.classList?.contains('extraMesButtons') ? hint.nextElementSibling : null);
}

function addMessageSaveButton(messageElement) {
    if (!messageElement || messageElement.querySelector(`.${MESSAGE_SAVE_BUTTON_CLASS}`)) return;

    const messageIndex = getMessageIndexFromElement(messageElement);
    if (messageIndex === null) return;

    const context = getContext();
    const message = Array.isArray(context?.chat) ? context.chat[messageIndex] : null;
    if (!isSaveableCharacterMessage(message)) return;

    const container = findExtraMessageButtonsContainer(messageElement);
    if (!container) return;

    const button = document.createElement('div');
    button.className = `mes_button ${MESSAGE_SAVE_BUTTON_CLASS} fa-solid fa-paper-plane interactable`;
    button.title = '关联保存到小剧场';
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        await startMessageSaveFlow(messageIndex);
    });
    button.addEventListener('keydown', async event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        await startMessageSaveFlow(messageIndex);
    });
    container.appendChild(button);
}

function refreshMessageSaveButtons(root = document) {
    root.querySelectorAll?.('.mes').forEach(addMessageSaveButton);
}

function watchMessageButtons() {
    refreshMessageSaveButtons();
    if (messageButtonsObserver) return;

    messageButtonsObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            mutation.addedNodes.forEach(node => {
                if (!(node instanceof Element)) return;
                if (node.classList.contains('mes')) addMessageSaveButton(node);
                const parentMessage = node.closest('.mes');
                if (parentMessage) addMessageSaveButton(parentMessage);
                refreshMessageSaveButtons(node);
            });
        }
    });
    messageButtonsObserver.observe(document.body, { childList: true, subtree: true });
}

jQuery(() => {
    loadSettings();
    addExtensionButton();
    watchMessageButtons();
});
