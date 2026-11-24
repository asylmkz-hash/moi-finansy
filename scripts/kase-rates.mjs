// Забирает средневзвешенные курсы тенге с сайта KASE и цены ценных бумаг
// (KASE и мировые биржи через Yahoo Finance) и сохраняет их в rates.json.
// Запускается GitHub Actions по расписанию (.github/workflows/kase-rates.yml).
import fs from "node:fs";

const PAGE = "https://kase.kz/ru/markets/foreign-currencies";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; moi-finansy-rates/1.0)", "Accept-Language": "ru" };
// валюта → инструменты KASE в порядке предпочтения
const SYMBOLS = {
  USD: ["USDKZT_TOM", "USDKZT_SPT"],
  EUR: ["EURKZT_TOM", "EURKZT_TOD"],
  RUB: ["RUBKZT_TOM", "RUBKZT_TOD"],
  CNY: ["CNYKZT_TOM", "CNYKZT_TOD"],
  AED: ["AEDKZT_TOM"]
};

// список тикеров, которые держат пользователи (только символы, без привязки к людям)
const FS_TICKERS = "https://firestore.googleapis.com/v1/projects/moi-finansy-82c4e/databases/(default)/documents/tickers?pageSize=300&key=AIzaSyAG-N3qMC30_VWc4_NhncTAcWgMDk6x2bs";
// самые ликвидные акции KASE — их цены есть всегда
const KASE_DEFAULT = ["KSPI", "HSBK", "KCEL", "KZTO", "KEGC", "KZAP", "KMGZ", "CCBN", "AIRA", "KZTK", "KZTKp", "BAST", "RAHT", "BSUL", "MMGZp"];
const RX_SYM = /^[A-Za-z0-9.\-=^_]{1,20}$/;
// котировки в пенсах и т.п. переводим в основную валюту
const SUBUNIT = { GBp: ["GBP", 100], GBX: ["GBP", 100], ZAc: ["ZAR", 100], ILA: ["ILS", 100] };
const day = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

async function listTickers() {
  const out = [];
  let token = "";
  for (let i = 0; i < 20; i++) {
    const r = await fetch(FS_TICKERS + (token ? "&pageToken=" + encodeURIComponent(token) : ""));
    if (!r.ok) { console.log("Список тикеров недоступен:", r.status); break; }
    const j = await r.json();
    for (const d of j.documents || []) {
      const f = d.fields || {};
      let sym = f.symbol && f.symbol.stringValue, m = f.market && f.market.stringValue;
      if (!sym || !RX_SYM.test(sym) || (m !== "KASE" && m !== "YAHOO")) continue;
      // тикеры в формате брокера: IBIT.US — мировые биржи, GDX_KZ.KZ — KASE
      const mm = sym.match(/^(.+)\.(US|KZ)$/i);
      if (mm) { sym = mm[1]; m = mm[2].toUpperCase() === "US" ? "YAHOO" : "KASE"; }
      sym = sym.toUpperCase();
      if (m === "KASE" && /^[A-Z]{4}P$/.test(sym)) sym = sym.slice(0, 4) + "p";
      out.push({ sym, m });
    }
    if (!j.nextPageToken) break;
    token = j.nextPageToken;
  }
  return out;
}
async function kasePrice(sym) {
  const now = Math.floor(Date.now() / 1000);
  const r = await fetch(`https://kase.kz/tv-charts/securities/history?symbol=${encodeURIComponent(sym)}&resolution=1D&from=${now - 30 * 86400}&to=${now}&countback=15&chart_language_code=ru`, { headers: HEADERS });
  if (!r.ok) return null;
  const j = await r.json();
  if (j.s !== "ok" || !j.c || !j.c.length) return null;
  const i = j.c.length - 1;
  // бумаги KASE Global (AAPL_KZ, GDX_KZ) торгуются в долларах
  return j.c[i] > 0 ? { price: j.c[i], currency: /_KZ$/.test(sym) ? "USD" : "KZT", date: day(j.t[i]) } : null;
}
async function yahooPrice(sym) {
  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (r.status === 404) return null;
      if (!r.ok) continue;
      const j = await r.json();
      const m = j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
      if (!m || !(m.regularMarketPrice > 0)) return null;
      let price = m.regularMarketPrice, currency = m.currency || "USD";
      if (SUBUNIT[currency]) { price /= SUBUNIT[currency][1]; currency = SUBUNIT[currency][0]; }
      return { price: Math.round(price * 10000) / 10000, currency, date: day(m.regularMarketTime || Date.now() / 1000) };
    } catch (e) { /* пробуем второй адрес */ }
  }
  return null;
}
async function fetchPrices(prev) {
  const want = new Map(KASE_DEFAULT.map((s) => [`KASE:${s}`, { sym: s, m: "KASE" }]));
  for (const t of await listTickers().catch((e) => { console.log("Тикеры:", e.message); return []; })) want.set(`${t.m}:${t.sym}`, t);
  const prices = {};
  for (const [id, t] of want) {
    const p = await (t.m === "KASE" ? kasePrice(t.sym) : yahooPrice(t.sym)).catch(() => null);
    if (p) prices[id] = p;
    else if (prev && prev[id]) prices[id] = prev[id];   // оставляем последнюю известную цену
  }
  return prices;
}

export function parseCards(html) {
  const out = {};
  for (const part of html.split('class="currency__title"').slice(1)) {
    const seg = part.slice(0, 2000);
    const t = seg.match(/^[^>]*>\s*([A-Z_]+)\s*</);
    const v = seg.match(/currency__values__value"[^>]*>(?:\s*<!---->)*\s*(\d[\d\s.,]*\d|\d)/);
    const d = seg.match(/currency__updatetime__date"[^>]*>\s*(\d{2}\.\d{2}\.\d{4})/);
    if (!t || !v || !d) continue;
    const rate = Number(v[1].replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(rate) && rate > 0) out[t[1]] = { rate, date: d[1].split(".").reverse().join("-") };
  }
  return out;
}

async function lastClose(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const url = `https://kase.kz/tv-charts/currency/history?symbol=${symbol}&resolution=1D&from=${now - 20 * 86400}&to=${now}&countback=10&chart_language_code=ru`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) return null;
  const j = await r.json();
  if (j.s !== "ok" || !j.c || !j.c.length) return null;
  const i = j.c.length - 1;
  return { rate: j.c[i], date: new Date(j.t[i] * 1000).toISOString().slice(0, 10) };
}

async function main() {
  let cards = {};
  try {
    const r = await fetch(PAGE, { headers: HEADERS });
    if (r.ok) cards = parseCards(await r.text());
    else console.log("Страница KASE ответила", r.status);
  } catch (e) { console.log("Не удалось открыть страницу KASE:", e.message); }

  const kzt = {};
  for (const [cur, syms] of Object.entries(SYMBOLS)) {
    const s = syms.find((x) => cards[x]);
    if (s) { kzt[cur] = { ...cards[s], symbol: s, kind: "weighted" }; continue; }
    for (const x of syms) {
      const c = await lastClose(x).catch(() => null);
      if (c) { kzt[cur] = { ...c, symbol: x, kind: "close" }; break; }
    }
  }
  const file = "rates.json";
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  let kztOut = kzt;
  if (!kzt.USD || kzt.USD.rate < 100 || kzt.USD.rate > 2000) {
    console.error("Курс USD/KZT не получен или выглядит неверно:", kzt.USD);
    if (!prev || !prev.kzt) process.exit(1);
    kztOut = prev.kzt;   // курсы оставляем прежними, цены бумаг всё равно обновим
  }
  const prices = await fetchPrices(prev && prev.prices);
  console.log("Цены бумаг:", Object.keys(prices).length);
  if (prev && JSON.stringify(prev.kzt) === JSON.stringify(kztOut) && JSON.stringify(prev.prices || {}) === JSON.stringify(prices)) { console.log("Курсы и цены не изменились"); return; }
  const out = { source: "KASE", note: "Средневзвешенные курсы биржевых торгов KASE; цены бумаг — KASE и Yahoo Finance", updated: new Date().toISOString(), kzt: kztOut, prices };
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log("Записано:", JSON.stringify(kztOut));
}

if (process.argv[1] && process.argv[1].endsWith("kase-rates.mjs")) main();
