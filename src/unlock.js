import { ProxyAgent, fetch as undiciFetch } from 'undici';

const OPENAI_BLOCKED_COUNTRIES = new Set([
  'CN', 'HK', 'MO', 'RU', 'BY', 'IR', 'KP', 'CU', 'SY', 'AF',
]);

async function probeIPGeo(dispatcher, signal, info) {
  try {
    const res = await undiciFetch(
      'http://ip-api.com/json/?lang=zh-CN&fields=status,country,countryCode,isp,query',
      { dispatcher, signal },
    );
    if (res.status !== 200) return;
    const data = await res.json();
    if (data.status === 'success') {
      info.ip = data.query || '';
      info.countryCode = String(data.countryCode || '').trim().toUpperCase();
      info.country = data.country || '';
      info.isp = data.isp || '';
    }
  } catch {
    // ignore
  }
}

async function probeChatGPT(dispatcher, signal) {
  try {
    const traceRes = await undiciFetch('https://chatgpt.com/cdn-cgi/trace', {
      dispatcher,
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      },
    });
    if (traceRes.status === 200) {
      const text = await traceRes.text();
      for (const line of text.split('\n')) {
        if (line.startsWith('loc=')) {
          const loc = line.slice(4).trim().toUpperCase();
          if (OPENAI_BLOCKED_COUNTRIES.has(loc)) return 'no';
          break;
        }
      }
    }

    const apiRes = await undiciFetch('https://api.openai.com/v1/models', {
      dispatcher,
      signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (apiRes.status === 401 || apiRes.status === 200) return 'yes';
    if (apiRes.status === 403) return 'no';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function probeNetflixStatus(dispatcher, signal, url) {
  try {
    const res = await undiciFetch(url, {
      dispatcher,
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    });
    await res.body?.cancel().catch(() => {});
    return res.status;
  } catch {
    return 0;
  }
}

async function probeNetflix(dispatcher, signal) {
  const fullCode = await probeNetflixStatus(dispatcher, signal, 'https://www.netflix.com/title/70143836');
  if (fullCode === 200) return 'full';
  if (fullCode === 0) return 'unknown';
  const origCode = await probeNetflixStatus(dispatcher, signal, 'https://www.netflix.com/title/80018499');
  if (origCode === 200) return 'originals';
  if (origCode === 403 || origCode === 404) return 'no';
  return 'unknown';
}

export async function probeNodeUnlock(mixedPort) {
  const dispatcher = new ProxyAgent(`http://127.0.0.1:${mixedPort}`);
  const signal = AbortSignal.timeout(4500);
  const info = {
    ip: '',
    countryCode: '',
    country: '',
    isp: '',
    chatgpt: 'unknown',
    netflix: 'unknown',
  };

  try {
    const [, chatgpt, netflix] = await Promise.all([
      probeIPGeo(dispatcher, signal, info),
      probeChatGPT(dispatcher, signal),
      probeNetflix(dispatcher, signal),
    ]);
    info.chatgpt = chatgpt;
    info.netflix = netflix;
    return info;
  } finally {
    await dispatcher.close().catch(() => {});
  }
}
