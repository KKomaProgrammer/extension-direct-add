'use strict';

const HISTORY_KEY = 'eddh_history_v1';
const MAX_HISTORY = 40;
const FETCH_TIMEOUT_MS = 6000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'EDD_DOWNLOAD') {
    handleDownload(message.candidate, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
    return true;
  }

  if (message.type === 'EDD_ANALYZE_GITHUB') {
    analyzeGithubCandidate(message.candidate)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
    return true;
  }

  if (message.type === 'EDD_GET_HISTORY') {
    getHistory()
      .then((history) => sendResponse({ ok: true, history }))
      .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
    return true;
  }

  if (message.type === 'EDD_CLEAR_HISTORY') {
    chrome.storage.local.set({ [HISTORY_KEY]: [] }, () => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

async function handleDownload(rawCandidate, sender) {
  const candidate = normalizeCandidate(rawCandidate);
  if (!candidate) throw new Error('Invalid candidate.');

  const resolved = candidate.kind === 'github'
    ? await resolveGithubZip(candidate)
    : { url: candidate.url, title: candidate.title || fileNameFromUrl(candidate.url), verified: false };

  const safeName = makeSafeFileName(resolved.title || candidate.title || 'extension-source');
  const filename = `extension-direct-add/${safeName}.zip`;

  const downloadId = await downloadQuietly(resolved.url, filename);
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    time: Date.now(),
    pageUrl: candidate.pageUrl || sender?.tab?.url || '',
    title: resolved.title || candidate.title || 'Extension source',
    originalUrl: candidate.url,
    downloadUrl: resolved.url,
    kind: candidate.kind,
    filename,
    downloadId,
    verified: Boolean(resolved.verified),
    warning: resolved.warning || ''
  };
  await addHistory(entry);

  return { ok: true, entry };
}

async function analyzeGithubCandidate(rawCandidate) {
  const candidate = normalizeCandidate(rawCandidate);
  if (!candidate || candidate.kind !== 'github') throw new Error('Invalid GitHub candidate.');
  const info = await resolveGithubZip(candidate);
  return { ok: true, info };
}

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate.url !== 'string') return null;
  const url = candidate.url.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const kind = candidate.kind === 'github' ? 'github' : 'zip';
  return {
    kind,
    url,
    title: typeof candidate.title === 'string' ? candidate.title.trim() : '',
    pageUrl: typeof candidate.pageUrl === 'string' ? candidate.pageUrl : ''
  };
}

async function resolveGithubZip(candidate) {
  const repo = parseGithubRepo(candidate.url);
  if (!repo) throw new Error('GitHub repository URL could not be parsed.');

  const apiUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}`;
  const repoInfo = await fetchJsonWithTimeout(apiUrl);
  const defaultBranch = repo.branch || repoInfo.default_branch || 'main';
  const title = `${repo.owner}-${repo.name}-${defaultBranch}`;

  let verified = false;
  let warning = '';
  try {
    const manifestUrl = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${encodeURIComponent(defaultBranch)}/manifest.json`;
    const manifest = await fetchJsonWithTimeout(manifestUrl, { soft404: true });
    verified = Boolean(manifest && (manifest.manifest_version === 2 || manifest.manifest_version === 3));
    if (!verified) warning = 'Root manifest.json was not verified. Check the unzipped folder before loading.';
  } catch (_) {
    warning = 'manifest.json verification timed out or failed. Check the unzipped folder before loading.';
  }

  return {
    url: `https://codeload.github.com/${repo.owner}/${repo.name}/zip/refs/heads/${encodeURIComponent(defaultBranch)}`,
    title,
    owner: repo.owner,
    repo: repo.name,
    branch: defaultBranch,
    verified,
    warning
  };
}

function parseGithubRepo(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  if (!/(^|\.)github\.com$/i.test(parsed.hostname)) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, '');
  let branch = '';

  if ((parts[2] === 'tree' || parts[2] === 'blob') && parts[3]) {
    branch = parts[3];
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  return { owner, name, branch };
}

async function fetchJsonWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'Accept': 'application/vnd.github+json, application/json;q=0.9, */*;q=0.1' }
    });
    if (!response.ok) {
      if (options.soft404 && response.status === 404) return null;
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function downloadQuietly(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(downloadId);
    });
  });
}

async function getHistory() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
}

async function addHistory(entry) {
  const history = await getHistory();
  history.unshift(entry);
  await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(0, MAX_HISTORY) });
}

function fileNameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop() || 'extension-source';
    return last.replace(/\.zip$/i, '') || 'extension-source';
  } catch (_) {
    return 'extension-source';
  }
}

function makeSafeFileName(name) {
  return (name || 'extension-source')
    .normalize('NFKD')
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'extension-source';
}

function normalizeError(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}
