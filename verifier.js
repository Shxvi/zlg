const Verifier = (() => {
    const RESOLVERS = {
        cloudflare: 'https://cloudflare-dns.com/dns-query',
        google: 'https://dns.google/resolve',
        quad9: 'https://dns.quad9.net:5053/dns-query',
        adguard: 'https://dns.adguard-dns.com/resolve'
    };

    let abortController = null;
    let isRunning = false;

    function formatIpPtr(rawIp) {
        const clean = rawIp.trim().split('/')[0].split(' ')[0].split('\t')[0];
        if (clean.includes(':')) {
            return null; // IPv6 PTR пропускается для ускорения валидации
        }
        const octets = clean.split('.');
        if (octets.length !== 4) return null;
        for (let i = 0; i < 4; i++) {
            const n = parseInt(octets[i], 10);
            if (isNaN(n) || n < 0 || n > 255) return null;
        }
        return `${octets.reverse().join('.')}.in-addr.arpa`;
    }

    function extractDomain(raw) {
        let d = raw.trim();
        if (/^https?:\/\//i.test(d)) d = d.replace(/^https?:\/\//i, '');
        d = d.split('/')[0].split(':')[0].trim().toLowerCase();
        return d.length > 0 ? d : null;
    }

    async function queryDns(name, type, resolverKey, parentSignal) {
        const base = RESOLVERS[resolverKey] || RESOLVERS.cloudflare;
        const url = `${base}?name=${encodeURIComponent(name)}&type=${type}`;
        
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), 2500);
        
        const onParentAbort = () => timeoutController.abort();
        if (parentSignal) {
            parentSignal.addEventListener('abort', onParentAbort);
        }

        try {
            const res = await fetch(url, {
                headers: { 'Accept': 'application/dns-json' },
                signal: timeoutController.signal,
                cache: 'force-cache'
            });
            clearTimeout(timeoutId);
            if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
            if (!res.ok) return false;
            const json = await res.json();
            return json.Status === 0 && Array.isArray(json.Answer) && json.Answer.length > 0;
        } catch {
            clearTimeout(timeoutId);
            if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
            return false;
        }
    }

    async function run({ items, type, resolver = 'cloudflare', concurrency = 64, onProgress }) {
        if (isRunning) return null;
        isRunning = true;
        abortController = new AbortController();

        const cache = new Map();
        const deadIndices = new Set();
        const total = items.length;
        let processed = 0;
        let cursor = 0;
        let animationFrameId = null;

        const reportProgress = () => {
            if (animationFrameId) return;
            animationFrameId = requestAnimationFrame(() => {
                if (typeof onProgress === 'function') {
                    onProgress({ processed, total, deadCount: deadIndices.size });
                }
                animationFrameId = null;
            });
        };

        async function worker() {
            while (cursor < total && isRunning) {
                const idx = cursor++;
                const item = items[idx];
                let targetQuery = null;
                let recordType = 'A';

                if (type === 'ip') {
                    targetQuery = formatIpPtr(item.raw);
                    recordType = 'PTR';
                } else {
                    targetQuery = extractDomain(item.raw);
                    recordType = 'A';
                }

                if (!targetQuery) {
                    if (type === 'ip' && item.raw.includes(':')) {
                        // IPv6 считается валидным синтаксически
                    } else {
                        deadIndices.add(item.index);
                    }
                    processed++;
                    reportProgress();
                    continue;
                }

                let isAlive = false;
                if (cache.has(targetQuery)) {
                    isAlive = cache.get(targetQuery);
                } else {
                    isAlive = await queryDns(targetQuery, recordType, resolver, abortController.signal);
                    cache.set(targetQuery, isAlive);
                }

                if (!isAlive) {
                    deadIndices.add(item.index);
                }

                processed++;
                reportProgress();
            }
        }

        const pool = Array.from({ length: Math.min(concurrency, total) }, () => worker());

        try {
            await Promise.all(pool);
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            if (typeof onProgress === 'function') {
                onProgress({ processed: total, total, deadCount: deadIndices.size });
            }
            return isRunning ? deadIndices : null;
        } finally {
            isRunning = false;
        }
    }

    function abort() {
        if (abortController) {
            abortController.abort();
        }
        isRunning = false;
    }

    return {
        run,
        abort,
        get isRunning() { return isRunning; }
    };
})();