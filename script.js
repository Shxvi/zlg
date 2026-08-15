const editor = document.getElementById('editor');
const editorContainer = document.getElementById('editorContainer');
const gutterWrapper = document.getElementById('gutterWrapper');
const gutterContent = document.getElementById('gutterContent');
const dropOverlay = document.getElementById('dropOverlay');
const lineCountEl = document.getElementById('lineCount');
const charCountEl = document.getElementById('charCount');
const statusText = document.getElementById('statusText');
const progressBar = document.getElementById('progressBar');
const targetZoneInput = document.getElementById('targetZone');
const zipExclusionsCheck = document.getElementById('zipExclusionsCheck');
const dohResolverSelect = document.getElementById('dohResolverSelect');
const toastContainer = document.getElementById('toastContainer');
const viewFilterInput = document.getElementById('viewFilterInput');
const viewFilterClear = document.getElementById('viewFilterClear');

const findReplaceOverlay = document.getElementById('findReplaceOverlay');
const findInput = document.getElementById('findInput');
const replaceInput = document.getElementById('replaceInput');
const findMatchesCount = document.getElementById('findMatchesCount');
const findRegexToggle = document.getElementById('findRegexToggle');
const findCaseToggle = document.getElementById('findCaseToggle');

const dnsModal = document.getElementById('dnsModal');
const modalTitle = document.getElementById('modalTitle');
const modalProgressSection = document.getElementById('modalProgressSection');
const modalResultSection = document.getElementById('modalResultSection');
const modalStatusText = document.getElementById('modalStatusText');
const modalProgressFill = document.getElementById('modalProgressFill');
const deadDomainsList = document.getElementById('deadDomainsList');
const modalFooter = document.getElementById('modalFooter');

const ROW_HEIGHT = 20;
const PAD_TOP = 8;
const STORAGE_KEY = 'zapret_list_state';

let baseLines = [''];
let lineOffsets = [0];
let totalLines = 1;
let pendingDeadLines = [];

let findState = {
    matches: [],
    currentIndex: -1,
    isRegex: false,
    isCase: false
};

const CATEGORIES = {
    'YouTube & Google Services': /youtube|googlevideo|ytimg|ggpht|youtu\.be|google/i,
    'Discord Services': /discord|discordapp|discordstatus|discordcdn/i,
    'Social Networks & Media': /instagram|facebook|twitter|x\.com|t\.co|tiktok|cdninstagram/i,
    'Torrents & Trackers': /torrent|tracker|rutor|rutracker|nnmclub|piratebay|tapochek/i,
    'Gaming Platforms': /steam|roblox|epicgames|ea\.com|origin|blizzard|riotgames|gog\.com/i,
    'Streaming & Video': /netflix|twitch|spotify|soundcloud|hdrezka|filmix|kinogo/i,
    'Adult Services': /porn|xxx|xvideos|xnxx|pornhub|hentai|redtube|erome/i
};

function showToast(msg) {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'toast-card';
    toast.textContent = msg;
    toastContainer.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 200);
    }, 2500);
}

const idbStorage = {
    dbPromise: null,
    init() {
        if (!this.dbPromise) {
            this.dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open('ZapretDB', 1);
                req.onupgradeneeded = () => req.result.createObjectStore('states');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        return this.dbPromise;
    },
    async set(key, val) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('states', 'readwrite');
            tx.objectStore('states').put(val, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
    async get(key) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('states', 'readonly');
            const req = tx.objectStore('states').get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
};

let saveTimeout = null;
function scheduleAutosave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
        const state = {
            text: editor.value,
            baseLines,
            resolver: dohResolverSelect ? dohResolverSelect.value : 'cloudflare',
            updated: Date.now()
        };
        const rawJson = JSON.stringify(state);
        if (rawJson.length > 4500000) {
            try {
                await idbStorage.set(STORAGE_KEY, state);
                localStorage.removeItem(STORAGE_KEY);
            } catch {}
        } else {
            try {
                localStorage.setItem(STORAGE_KEY, rawJson);
            } catch {}
        }
    }, 300);
}

async function restoreAutosave() {
    try {
        let state = null;
        const localRaw = localStorage.getItem(STORAGE_KEY);
        if (localRaw) {
            state = JSON.parse(localRaw);
        } else {
            state = await idbStorage.get(STORAGE_KEY);
        }
        if (state && typeof state.text === 'string') {
            baseLines = Array.isArray(state.baseLines) ? state.baseLines : [''];
            if (state.resolver && dohResolverSelect) {
                dohResolverSelect.value = state.resolver;
            }
            setEditorContent(state.text, false);
            showToast('Сессия восстановлена');
        }
    } catch {}
}

function lintLineDomain(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;
    if (/\s/.test(trimmed)) return { type: 'err', desc: 'Пробелы в строке' };
    if (/^https?:\/\//i.test(trimmed)) return { type: 'warn', desc: 'Указан протокол' };
    if (trimmed.includes('/') || trimmed.includes(':')) return { type: 'warn', desc: 'Пути или порты в домене' };
    if (/[^\x00-\x7F]/.test(trimmed)) return { type: 'warn', desc: 'Неконвертированный IDN' };
    return null;
}

function buildLineOffsets(val) {
    const offsets = [0];
    let pos = 0;
    while ((pos = val.indexOf('\n', pos)) !== -1) {
        pos++;
        offsets.push(pos);
    }
    lineOffsets = offsets;
    totalLines = val === '' ? 0 : offsets.length;
}

function getLineText(val, idx) {
    if (idx < 0 || idx >= lineOffsets.length) return '';
    const start = lineOffsets[idx];
    const end = idx + 1 < lineOffsets.length ? lineOffsets[idx + 1] - 1 : val.length;
    let line = val.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    return line;
}

function updateMetrics() {
    lineCountEl.textContent = totalLines.toLocaleString();
    const bytes = new Blob([editor.value]).size;
    charCountEl.textContent = bytes > 1048576 
        ? (bytes / 1048576).toFixed(2) + ' MB' 
        : bytes > 1024 
            ? (bytes / 1024).toFixed(2) + ' KB' 
            : bytes + ' B';

    const digits = Math.max(String(totalLines).length, 3);
    const calculatedWidth = Math.max(52, digits * 8 + 24);
    gutterWrapper.style.width = `${calculatedWidth}px`;
    gutterWrapper.style.minWidth = `${calculatedWidth}px`;
}

function renderVirtualGutter() {
    const scrollTop = editor.scrollTop;
    const clientHeight = editor.clientHeight;
    const val = editor.value;

    if (totalLines === 0) {
        gutterContent.innerHTML = '';
        return;
    }

    const startLine = Math.max(0, Math.floor((scrollTop - PAD_TOP) / ROW_HEIGHT));
    const visibleCount = Math.ceil(clientHeight / ROW_HEIGHT) + 4;
    const endLine = Math.min(totalLines - 1, startLine + visibleCount);

    const translateY = startLine * ROW_HEIGHT + PAD_TOP - scrollTop;
    gutterContent.style.transform = `translateY(${translateY}px)`;

    const baseCount = baseLines.length;
    let html = '';

    for (let i = startLine; i <= endLine; i++) {
        let diffType = '';
        let hasDel = false;
        const currentLine = getLineText(val, i);

        if (i >= baseCount) {
            diffType = 'added';
        } else {
            if (currentLine !== baseLines[i]) {
                diffType = 'modified';
            }
        }

        if (totalLines < baseCount && i === totalLines - 1) {
            hasDel = true;
        }

        const lint = lintLineDomain(currentLine);
        const lintTag = lint ? `<div class="gutter-lint-marker ${lint.type}" title="${lint.desc}"></div>` : '';
        const delTag = hasDel ? '<div class="gutter-del"></div>' : '';
        const barClass = diffType ? `gutter-bar ${diffType}` : 'gutter-bar';

        html += `
            <div class="gutter-row">
                ${lintTag}
                ${delTag}
                <span class="gutter-num">${i + 1}</span>
                <div class="${barClass}"></div>
            </div>
        `;
    }

    gutterContent.innerHTML = html;
}

editor.addEventListener('scroll', () => requestAnimationFrame(renderVirtualGutter));
editor.addEventListener('input', () => {
    buildLineOffsets(editor.value);
    updateMetrics();
    renderVirtualGutter();
    scheduleAutosave();
    if (findReplaceOverlay.classList.contains('active')) {
        updateFindMatches();
    }
});

function setEditorContent(text, resetBase = false) {
    editor.value = text;
    buildLineOffsets(text);
    if (resetBase) {
        baseLines = text === '' ? [] : text.replace(/\r/g, '').split('\n');
    }
    updateMetrics();
    renderVirtualGutter();
    scheduleAutosave();
}

async function fetchLocalText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} при загрузке ${url}`);
    return await res.text();
}

async function loadPremadeList() {
    try {
        statusText.textContent = 'Загрузка premade-list.txt...';
        const text = await fetchLocalText('premade-list.txt');
        setEditorContent(text, true);
        showToast('Загружен premade-list.txt');
        statusText.textContent = 'Готовые правила загружены';
    } catch (e) {
        showToast(`Ошибка: ${e.message}`);
        statusText.textContent = `Ошибка загрузки: ${e.message}`;
    }
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    window.addEventListener(evt, preventDefaults, false);
});

editorContainer.addEventListener('dragenter', (e) => {
    preventDefaults(e);
    dragCounter++;
    dropOverlay.classList.add('active');
});

editorContainer.addEventListener('dragover', preventDefaults);

editorContainer.addEventListener('dragleave', (e) => {
    preventDefaults(e);
    dragCounter--;
    if (dragCounter <= 0) {
        dragCounter = 0;
        dropOverlay.classList.remove('active');
    }
});

editorContainer.addEventListener('drop', (e) => {
    preventDefaults(e);
    dragCounter = 0;
    dropOverlay.classList.remove('active');
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length > 0) {
        readFile(dt.files[0]);
    }
});

function readFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        setEditorContent(e.target.result, true);
        showToast(`Загружен: ${file.name}`);
        statusText.textContent = `Загружен: ${file.name}`;
    };
    reader.readAsText(file);
}

function loadFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    readFile(file);
    e.target.value = '';
}

function extractHost(line) {
    let d = line.trim();
    if (/^https?:\/\//i.test(d)) {
        d = d.replace(/^https?:\/\//i, '');
    }
    d = d.split('/')[0].split(':')[0];
    return d.toLowerCase();
}

function cleanUrlGarbage() {
    const raw = editor.value.split('\n');
    const cleaned = raw.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        return extractHost(trimmed);
    });
    setEditorContent(cleaned.join('\n'), false);
    showToast('URL и порты очищены');
    statusText.textContent = 'Список очищен';
}

function removeDuplicates() {
    const raw = editor.value.split('\n');
    const seen = new Set();
    const result = [];

    for (let i = 0; i < raw.length; i++) {
        const line = raw[i];
        const key = line.trim().toLowerCase();
        if (key === '' || !seen.has(key)) {
            if (key !== '') seen.add(key);
            result.push(line);
        }
    }

    const delta = raw.length - result.length;
    setEditorContent(result.join('\n'), false);
    showToast(`Удалено дубликатов: ${delta}`);
    statusText.textContent = `Удалено дубликатов: ${delta}`;
}

function collapseSubdomains() {
    const raw = editor.value.split('\n');
    const validDomains = [];
    
    for (const l of raw) {
        const h = extractHost(l);
        if (h && !l.trim().startsWith('#')) validDomains.push(h);
    }

    const domainSet = new Set(validDomains);
    const rootDomains = new Set();
    const sorted = Array.from(domainSet).sort((a, b) => a.split('.').length - b.split('.').length);

    for (const d of sorted) {
        const parts = d.split('.');
        let isSub = false;
        for (let i = 1; i < parts.length - 1; i++) {
            const parent = parts.slice(i).join('.');
            if (rootDomains.has(parent)) {
                isSub = true;
                break;
            }
        }
        if (!isSub) {
            rootDomains.add(d);
        }
    }

    const result = raw.filter(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return true;
        const h = extractHost(trimmed);
        return rootDomains.has(h);
    });

    const delta = raw.length - result.length;
    setEditorContent(result.join('\n'), false);
    showToast(`Схлопнуто поддоменов: ${delta}`);
    statusText.textContent = `Удалено избыточных: ${delta}`;
}

function convertPunycode() {
    const raw = editor.value.split('\n');
    const converted = raw.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const host = extractHost(trimmed);
        try {
            if (host.includes('xn--')) {
                const u = new URL('http://' + host);
                return (u.hostname || host);
            } else {
                const u = new URL('http://' + host);
                return u.hostname;
            }
        } catch {
            return line;
        }
    });
    setEditorContent(converted.join('\n'), false);
    showToast('Punycode сконвертирован');
    statusText.textContent = 'Конвертация выполнена';
}

function removeCustomZone() {
    const rawInput = targetZoneInput.value.trim();
    if (!rawInput) return;

    const patterns = rawInput.split(',')
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => {
            const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return p.startsWith('.') ? `${escaped}$` : `(?:^|\\.)${escaped}$`;
        });

    if (patterns.length === 0) return;

    const regex = new RegExp(`(${patterns.join('|')})`, 'i');
    const raw = editor.value.split('\n');
    const filtered = raw.filter(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return true;
        const host = extractHost(trimmed);
        return !regex.test(host);
    });

    const delta = raw.length - filtered.length;
    setEditorContent(filtered.join('\n'), false);
    showToast(`Удалено строк (${rawInput}): ${delta}`);
    statusText.textContent = `Удалено строк: ${delta}`;
}

function groupByTLD() {
    const raw = editor.value.split('\n');
    const validLines = raw
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'));

    const groups = new Map();
    for (const line of validLines) {
        const host = extractHost(line);
        const match = host.match(/\.([a-z0-9\-]+)$/i);
        const tld = match ? '.' + match[1].toLowerCase() : '# other';
        if (!groups.has(tld)) groups.set(tld, []);
        groups.get(tld).push(line);
    }

    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
        if (a === '# other') return 1;
        if (b === '# other') return -1;
        return a.localeCompare(b);
    });

    const output = [];
    for (const key of sortedKeys) {
        output.push(key === '# other' ? '# other' : `# ${key}`);
        output.push(...groups.get(key).sort((a, b) => a.localeCompare(b)));
        output.push('');
    }

    setEditorContent(output.join('\n').trim(), false);
    showToast(`Сгруппировано по ${groups.size} TLD`);
    statusText.textContent = `Группировка завершена`;
}

function groupByCategory() {
    const raw = editor.value.split('\n');
    const validLines = raw
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'));

    const catGroups = new Map();
    for (const cat of Object.keys(CATEGORIES)) catGroups.set(cat, []);
    catGroups.set('Other / Miscellaneous', []);

    for (const line of validLines) {
        const host = extractHost(line);
        let assigned = false;
        for (const [catName, regex] of Object.entries(CATEGORIES)) {
            if (regex.test(host)) {
                catGroups.get(catName).push(line);
                assigned = true;
                break;
            }
        }
        if (!assigned) catGroups.get('Other / Miscellaneous').push(line);
    }

    const output = [];
    for (const [catName, items] of catGroups.entries()) {
        if (items.length > 0) {
            output.push(`# === ${catName} (${items.length}) ===`);
            output.push(...Array.from(new Set(items)).sort((a, b) => a.localeCompare(b)));
            output.push('');
        }
    }

    setEditorContent(output.join('\n').trim(), false);
    showToast('Группировка по категориям выполнена');
    statusText.textContent = 'Группировка завершена';
}

function abortDnsVerification() {
    Verifier.abort();
    dnsModal.classList.remove('active');
    showToast('Тест прерван');
    statusText.textContent = 'Тест прерван пользователем';
}

async function toggleDnsVerification() {
    if (Verifier.isRunning) return;

    const allLines = editor.value.split('\n');
    const targetItems = [];
    for (let i = 0; i < allLines.length; i++) {
        const trimmed = allLines[i].trim();
        if (trimmed && !trimmed.startsWith('#')) {
            targetItems.push({ index: i, text: allLines[i], raw: trimmed });
        }
    }

    if (targetItems.length === 0) {
        showToast('Нет доменов для теста');
        return;
    }

    modalTitle.textContent = `Тест доступности (${dohResolverSelect.options[dohResolverSelect.selectedIndex].text})`;
    modalProgressSection.style.display = 'block';
    modalResultSection.style.display = 'none';
    modalStatusText.textContent = `Проверено: 0 / ${targetItems.length}`;
    modalProgressFill.style.width = '0%';
    modalFooter.innerHTML = `
        <button class="btn btn-danger" onclick="abortDnsVerification()">
            <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            <span>Остановить</span>
        </button>
    `;
    dnsModal.classList.add('active');

    const deadIndices = await Verifier.run({
        items: targetItems,
        type: 'domain',
        resolver: dohResolverSelect.value,
        concurrency: 64,
        onProgress: ({ processed, total, deadCount }) => {
            modalProgressFill.style.width = `${(processed / total) * 100}%`;
            modalStatusText.textContent = `Проверено: ${processed} / ${total} (Нерабочих: ${deadCount})`;
        }
    });

    if (!deadIndices) return;

    pendingDeadLines = targetItems
        .filter(item => deadIndices.has(item.index))
        .map(item => item.text);

    let deadHtml = pendingDeadLines.length === 0
        ? '<div style="color: var(--text-secondary);">Все домены активны!</div>'
        : pendingDeadLines.map(line => `<div>${escapeHtml(line)}</div>`).join('');

    modalTitle.textContent = 'Результаты теста';
    modalProgressSection.style.display = 'none';
    modalResultSection.style.display = 'block';
    document.getElementById('modalDesc').textContent = `Недоступно: ${pendingDeadLines.length}`;
    deadDomainsList.innerHTML = deadHtml;

    if (pendingDeadLines.length > 0) {
        modalFooter.innerHTML = `
            <button class="btn" onclick="dnsModal.classList.remove('active')">Отмена</button>
            <button class="btn btn-danger" onclick="confirmDeleteDeadDomains()">Удалить (${pendingDeadLines.length})</button>
        `;
    } else {
        modalFooter.innerHTML = `<button class="btn btn-accent" onclick="dnsModal.classList.remove('active')">Закрыть</button>`;
    }
    showToast(`Тест завершен. Нерабочих: ${pendingDeadLines.length}`);
}

function confirmDeleteDeadDomains() {
    const raw = editor.value.split('\n');
    const deadSet = new Set(pendingDeadLines);
    const filtered = raw.filter(line => !deadSet.has(line));
    const delta = raw.length - filtered.length;
    setEditorContent(filtered.join('\n'), false);
    dnsModal.classList.remove('active');
    showToast(`Удалено нерабочих: ${delta}`);
}

function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clearEditor() {
    setEditorContent('', true);
    showToast('Редактор очищен');
    statusText.textContent = 'Редактор очищен';
}

function copyToClipboard() {
    navigator.clipboard.writeText(editor.value).then(() => {
        showToast(`Скопировано ${totalLines.toLocaleString()} строк`);
    });
}

function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

async function exportFile() {
    baseLines = editor.value === '' ? [] : editor.value.replace(/\r/g, '').split('\n');
    renderVirtualGutter();
    const outputText = editor.value;

    if (zipExclusionsCheck.checked) {
        if (typeof JSZip === 'undefined') {
            showToast('Ошибка: JSZip недоступен');
            return;
        }
        let ipContent = '';
        let domainContent = '';
        try {
            const [ipRes, domainRes] = await Promise.all([
                fetchLocalText('ipset-exclude.txt'),
                fetchLocalText('list-exclude.txt')
            ]);
            ipContent = ipRes;
            domainContent = domainRes;
        } catch (e) {
            showToast(`Ошибка исключений: ${e.message}`);
            return;
        }

        const zip = new JSZip();
        zip.file('list-general.txt', outputText);
        zip.file('ipset-exclude.txt', ipContent);
        zip.file('list-exclude.txt', domainContent);

        try {
            const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } });
            triggerDownload(content, 'rules-bundle.zip');
            showToast('Экспортирован rules-bundle.zip');
        } catch {
            showToast('Сбой сжатия ZIP');
        }
    } else {
        const blob = new Blob([outputText], { type: 'text/plain;charset=utf-8' });
        triggerDownload(blob, 'list-general.txt');
        showToast('Экспортирован list-general.txt');
    }
}

function openFindReplace(isReplace = false) {
    findReplaceOverlay.classList.add('active');
    findInput.focus();
    findInput.select();
    if (isReplace) replaceInput.focus();
    updateFindMatches();
}

function closeFindReplace() {
    findReplaceOverlay.classList.remove('active');
    editor.focus();
}

function toggleFindRegex() {
    findState.isRegex = !findState.isRegex;
    findRegexToggle.classList.toggle('active', findState.isRegex);
    updateFindMatches();
}

function toggleFindCase() {
    findState.isCase = !findState.isCase;
    findCaseToggle.classList.toggle('active', findState.isCase);
    updateFindMatches();
}

function updateFindMatches() {
    const query = findInput.value;
    if (!query) {
        findState.matches = [];
        findState.currentIndex = -1;
        findMatchesCount.textContent = '0/0';
        return;
    }

    let regex;
    try {
        regex = new RegExp(findState.isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), findState.isCase ? 'g' : 'gi');
    } catch {
        findMatchesCount.textContent = 'Err';
        return;
    }

    const text = editor.value;
    const matches = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length });
        if (!regex.global) break;
    }

    findState.matches = matches;
    if (matches.length > 0) {
        if (findState.currentIndex === -1 || findState.currentIndex >= matches.length) {
            findState.currentIndex = 0;
        }
        findMatchesCount.textContent = `${findState.currentIndex + 1}/${matches.length}`;
        highlightFindMatch(findState.currentIndex);
    } else {
        findState.currentIndex = -1;
        findMatchesCount.textContent = '0/0';
    }
}

function highlightFindMatch(idx) {
    if (idx < 0 || idx >= findState.matches.length) return;
    const match = findState.matches[idx];
    editor.focus();
    editor.setSelectionRange(match.start, match.end);
    const lineIndex = editor.value.slice(0, match.start).split('\n').length - 1;
    editor.scrollTop = Math.max(0, lineIndex * ROW_HEIGHT - editor.clientHeight / 2);
}

function findNav(dir) {
    if (findState.matches.length === 0) return;
    findState.currentIndex = (findState.currentIndex + dir + findState.matches.length) % findState.matches.length;
    findMatchesCount.textContent = `${findState.currentIndex + 1}/${findState.matches.length}`;
    highlightFindMatch(findState.currentIndex);
}

function replaceOne() {
    if (findState.currentIndex === -1 || findState.matches.length === 0) return;
    const match = findState.matches[findState.currentIndex];
    const repVal = replaceInput.value;
    const val = editor.value;
    const nextVal = val.slice(0, match.start) + repVal + val.slice(match.end);
    setEditorContent(nextVal, false);
    updateFindMatches();
}

function replaceAll() {
    const query = findInput.value;
    if (!query) return;
    try {
        const regex = new RegExp(findState.isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), findState.isCase ? 'g' : 'gi');
        const count = (editor.value.match(regex) || []).length;
        const nextVal = editor.value.replace(regex, replaceInput.value);
        setEditorContent(nextVal, false);
        updateFindMatches();
        showToast(`Заменено совпадений: ${count}`);
    } catch {}
}

findInput.addEventListener('input', updateFindMatches);
findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        findNav(e.shiftKey ? -1 : 1);
    }
});

let liveFilterCachedText = null;
function applyViewFilter() {
    const q = viewFilterInput.value.trim().toLowerCase();
    viewFilterClear.style.display = q ? 'block' : 'none';
    if (q) {
        if (liveFilterCachedText === null) liveFilterCachedText = editor.value;
        const filtered = liveFilterCachedText.split('\n').filter(l => l.toLowerCase().includes(q) || l.trim().startsWith('#'));
        editor.value = filtered.join('\n');
        buildLineOffsets(editor.value);
        updateMetrics();
        renderVirtualGutter();
    } else {
        clearViewFilter();
    }
}

function clearViewFilter() {
    viewFilterInput.value = '';
    viewFilterClear.style.display = 'none';
    if (liveFilterCachedText !== null) {
        editor.value = liveFilterCachedText;
        liveFilterCachedText = null;
        buildLineOffsets(editor.value);
        updateMetrics();
        renderVirtualGutter();
    }
}

window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        exportFile();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        document.getElementById('fileInput').click();
    } else if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        copyToClipboard();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openFindReplace(false);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        openFindReplace(true);
    } else if (e.key === 'Escape') {
        if (findReplaceOverlay.classList.contains('active')) closeFindReplace();
        if (dnsModal.classList.contains('active')) abortDnsVerification();
    }
});

restoreAutosave();