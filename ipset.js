const editor = document.getElementById('editor');
const editorContainer = document.getElementById('editorContainer');
const gutterWrapper = document.getElementById('gutterWrapper');
const gutterContent = document.getElementById('gutterContent');
const dropOverlay = document.getElementById('dropOverlay');
const lineCountEl = document.getElementById('lineCount');
const charCountEl = document.getElementById('charCount');
const statusText = document.getElementById('statusText');
const progressBar = document.getElementById('progressBar');
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

const ipModal = document.getElementById('ipModal');
const ipModalTitle = document.getElementById('ipModalTitle');
const ipModalProgressSection = document.getElementById('ipModalProgressSection');
const ipModalResultSection = document.getElementById('ipModalResultSection');
const ipModalStatusText = document.getElementById('ipModalStatusText');
const ipModalProgressFill = document.getElementById('ipModalProgressFill');
const deadIpList = document.getElementById('deadIpList');
const ipModalFooter = document.getElementById('ipModalFooter');

const ROW_HEIGHT = 20;
const PAD_TOP = 8;
const STORAGE_KEY = 'zapret_ipset_state';

let baseLines = [''];
let lineOffsets = [0];
let totalLines = 1;
let pendingDeadIpLines = [];

let findState = {
    matches: [],
    currentIndex: -1,
    isRegex: false,
    isCase: false
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
            showToast('Сессия IPSet восстановлена');
        }
    } catch {}
}

function lintLineIp(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;
    if (trimmed.includes(':')) return null;

    const parts = trimmed.split('/');
    const ipPart = parts[0];
    const maskPart = parts[1];

    const octets = ipPart.split('.');
    if (octets.length !== 4) return { type: 'err', desc: 'Некорректный IPv4' };
    for (const oct of octets) {
        if (!/^\d+$/.test(oct)) return { type: 'err', desc: 'Символы в октете' };
        const n = parseInt(oct, 10);
        if (n < 0 || n > 255) return { type: 'err', desc: 'Октет вне диапазона 0-255' };
    }

    if (maskPart !== undefined) {
        if (!/^\d+$/.test(maskPart)) return { type: 'err', desc: 'Символы в маске CIDR' };
        const m = parseInt(maskPart, 10);
        if (m < 0 || m > 32) return { type: 'err', desc: 'Маска IPv4 CIDR вне 0-32' };
    }

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

        const lint = lintLineIp(currentLine);
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
    if (findReplaceOverlay.classList.contains('active')) updateFindMatches();
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

async function loadPremadeIpSet() {
    try {
        statusText.textContent = 'Загрузка premade-ipset.txt...';
        const text = await fetchLocalText('premade-ipset.txt');
        setEditorContent(text, true);
        showToast('Загружен premade-ipset.txt');
        statusText.textContent = 'IPSet загружен';
    } catch (e) {
        showToast(`Ошибка: ${e.message}`);
        statusText.textContent = `Ошибка загрузки: ${e.message}`;
    }
}

function cleanIpGarbage() {
    const raw = editor.value.split('\n');
    const cleaned = raw.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        return trimmed.split(' ')[0].split('\t')[0];
    });
    setEditorContent(cleaned.join('\n'), false);
    showToast('IPSet очищен от мусора');
    statusText.textContent = 'IPSet очищен';
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
    showToast(`Удалено дубликатов IP: ${delta}`);
    statusText.textContent = `Удалено дубликатов: ${delta}`;
}

function ip2int(ip) {
    return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function int2ip(int) {
    return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join('.');
}

function parseCidr(line) {
    const [ip, maskStr] = line.split('/');
    const mask = maskStr ? parseInt(maskStr, 10) : 32;
    if (isNaN(mask) || mask < 0 || mask > 32) return null;
    const octets = ip.split('.');
    if (octets.length !== 4 || octets.some(o => isNaN(o) || o < 0 || o > 255)) return null;
    const ipInt = ip2int(ip);
    const maskInt = mask === 0 ? 0 : (0xFFFFFFFF << (32 - mask)) >>> 0;
    const start = (ipInt & maskInt) >>> 0;
    const end = (start + (Math.pow(2, 32 - mask) - 1)) >>> 0;
    return { start, end, orig: line };
}

function aggregateSubnets() {
    const raw = editor.value.split('\n');
    const v4Ranges = [];
    const others = [];

    for (const l of raw) {
        const trimmed = l.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.includes(':')) {
            others.push(l);
            continue;
        }
        const parsed = parseCidr(trimmed);
        if (parsed) v4Ranges.push(parsed);
        else others.push(l);
    }

    if (v4Ranges.length === 0) {
        showToast('Нет корректных IPv4 для агрегации');
        return;
    }

    v4Ranges.sort((a, b) => a.start - b.start || a.end - b.end);

    const merged = [];
    let cur = v4Ranges[0];

    for (let i = 1; i < v4Ranges.length; i++) {
        const next = v4Ranges[i];
        if (next.start <= cur.end + 1) {
            cur.end = Math.max(cur.end, next.end);
        } else {
            merged.push(cur);
            cur = next;
        }
    }
    merged.push(cur);

    const aggregatedLines = [];
    for (const r of merged) {
        let start = r.start;
        const end = r.end;
        while (start <= end) {
            let maxBits = 32 - Math.floor(Math.log2(start & -start || 1));
            let rangeBits = Math.floor(Math.log2(end - start + 2));
            let prefix = Math.max(32 - rangeBits, maxBits);
            if (prefix < 0) prefix = 0;
            aggregatedLines.push(`${int2ip(start)}/${prefix}`);
            start += Math.pow(2, 32 - prefix);
        }
    }

    const finalResult = [...others, ...aggregatedLines];
    const delta = raw.length - finalResult.length;
    setEditorContent(finalResult.join('\n'), false);
    showToast(`Агрегация: объединено ${delta} правил`);
    statusText.textContent = `Сокращено: ${delta}`;
}

function filterBogons() {
    const bogonPrefixes = ['10.', '127.', '169.254.', '172.16.', '192.168.', '0.0.0.0', '100.64.'];
    const raw = editor.value.split('\n');
    const filtered = raw.filter(l => {
        const trimmed = l.trim();
        if (!trimmed || trimmed.startsWith('#')) return true;
        return !bogonPrefixes.some(p => trimmed.startsWith(p));
    });
    const delta = raw.length - filtered.length;
    setEditorContent(filtered.join('\n'), false);
    showToast(`Удалено Bogon IP: ${delta}`);
    statusText.textContent = `Удалено Bogon: ${delta}`;
}

function filterIPv6() {
    const raw = editor.value.split('\n');
    const filtered = raw.filter(l => {
        const trimmed = l.trim();
        if (!trimmed || trimmed.startsWith('#')) return true;
        return !trimmed.includes(':');
    });
    const delta = raw.length - filtered.length;
    setEditorContent(filtered.join('\n'), false);
    showToast(`Удалено IPv6: ${delta}`);
    statusText.textContent = `Удалено IPv6: ${delta}`;
}

function abortIpVerification() {
    Verifier.abort();
    ipModal.classList.remove('active');
    showToast('Тест прерван');
    statusText.textContent = 'Тест прерван пользователем';
}

async function toggleIpVerification() {
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
        showToast('Нет IP для теста');
        return;
    }

    ipModalTitle.textContent = `Тест доступности IP (${dohResolverSelect.options[dohResolverSelect.selectedIndex].text})`;
    ipModalProgressSection.style.display = 'block';
    ipModalResultSection.style.display = 'none';
    ipModalStatusText.textContent = `Проверено: 0 / ${targetItems.length}`;
    ipModalProgressFill.style.width = '0%';
    ipModalFooter.innerHTML = `
        <button class="btn btn-danger" onclick="abortIpVerification()">
            <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            <span>Остановить</span>
        </button>
    `;
    ipModal.classList.add('active');

    const deadIndices = await Verifier.run({
        items: targetItems,
        type: 'ip',
        resolver: dohResolverSelect.value,
        concurrency: 64,
        onProgress: ({ processed, total, deadCount }) => {
            ipModalProgressFill.style.width = `${(processed / total) * 100}%`;
            ipModalStatusText.textContent = `Проверено: ${processed} / ${total} (Нераспознано: ${deadCount})`;
        }
    });

    if (!deadIndices) return;

    pendingDeadIpLines = targetItems
        .filter(item => deadIndices.has(item.index))
        .map(item => item.text);

    let deadHtml = pendingDeadIpLines.length === 0
        ? '<div style="color: var(--text-secondary);">Все IP-адреса валидны и отвечают PTR!</div>'
        : pendingDeadIpLines.map(line => `<div>${escapeHtml(line)}</div>`).join('');

    ipModalTitle.textContent = 'Результаты теста IP';
    ipModalProgressSection.style.display = 'none';
    ipModalResultSection.style.display = 'block';
    document.getElementById('ipModalDesc').textContent = `Не распознано: ${pendingDeadIpLines.length}`;
    deadIpList.innerHTML = deadHtml;

    if (pendingDeadIpLines.length > 0) {
        ipModalFooter.innerHTML = `
            <button class="btn" onclick="ipModal.classList.remove('active')">Отмена</button>
            <button class="btn btn-danger" onclick="confirmDeleteDeadIps()">Удалить (${pendingDeadIpLines.length})</button>
        `;
    } else {
        ipModalFooter.innerHTML = `<button class="btn btn-accent" onclick="ipModal.classList.remove('active')">Закрыть</button>`;
    }
    showToast(`Тест завершен. Нераспознано: ${pendingDeadIpLines.length}`);
}

function confirmDeleteDeadIps() {
    const raw = editor.value.split('\n');
    const deadSet = new Set(pendingDeadIpLines);
    const filtered = raw.filter(line => !deadSet.has(line));
    const delta = raw.length - filtered.length;
    setEditorContent(filtered.join('\n'), false);
    ipModal.classList.remove('active');
    showToast(`Удалено неактивных IP: ${delta}`);
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

async function exportIpFile() {
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
        zip.file('ipset-all.txt', outputText);
        zip.file('ipset-exclude.txt', ipContent);
        zip.file('list-exclude.txt', domainContent);

        try {
            const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } });
            triggerDownload(content, 'ipset-bundle.zip');
            showToast('Экспортирован ipset-bundle.zip');
        } catch {
            showToast('Сбой сжатия ZIP');
        }
    } else {
        const blob = new Blob([outputText], { type: 'text/plain;charset=utf-8' });
        triggerDownload(blob, 'ipset-all.txt');
        showToast('Экспортирован ipset-all.txt');
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
        exportIpFile();
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
        if (ipModal.classList.contains('active')) abortIpVerification();
    }
});

restoreAutosave();