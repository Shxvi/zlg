async function initGitHubRelease() {
    const releaseText = document.getElementById('githubReleaseText');
    const releaseBtn = document.getElementById('githubReleaseBtn');
    if (!releaseBtn || !releaseText) return;

    try {
        const res = await fetch('https://api.github.com/repos/Flowseal/zapret-discord-youtube/releases/latest');
        if (res.ok) {
            const data = await res.json();
            const tag = data.tag_name || '';
            const zipAsset = data.assets ? data.assets.find(a => a.name.endsWith('.zip')) : null;
            
            if (zipAsset) {
                releaseBtn.href = zipAsset.browser_download_url;
                releaseText.textContent = `Скачать Zapret ${tag} (${(zipAsset.size / 1048576).toFixed(1)} MB)`;
            } else if (data.zipball_url) {
                releaseBtn.href = data.zipball_url;
                releaseText.textContent = `Скачать Zapret ${tag} (.zip)`;
            }
        }
    } catch {
        // Fallback на статический URL
    }
}

async function downloadDirectFile(sourceUrl, filename) {
    try {
        const res = await fetch(sourceUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        triggerDownload(blob, filename);
    } catch (e) {
        alert(`Ошибка загрузки ${sourceUrl}: ${e.message}`);
    }
}

async function downloadAllBundleZip() {
    if (typeof JSZip === 'undefined') {
        alert('Ошибка: jszip.min.js не найден');
        return;
    }

    try {
        const files = [
            { url: 'premade-list.txt', name: 'list-general.txt' },
            { url: 'premade-ipset.txt', name: 'ipset-all.txt' },
            { url: 'list-exclude.txt', name: 'list-exclude.txt' },
            { url: 'ipset-exclude.txt', name: 'ipset-exclude.txt' }
        ];

        const zip = new JSZip();
        for (const f of files) {
            const res = await fetch(f.url);
            if (res.ok) {
                const text = await res.text();
                zip.file(f.name, text);
            }
        }

        const content = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 9 }
        });
        triggerDownload(content, 'zapret-lists.zip');
    } catch (e) {
        alert(`Ошибка сборки архива: ${e.message}`);
    }
}

function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

document.addEventListener('DOMContentLoaded', initGitHubRelease);
