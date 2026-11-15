// Забирает средневзвешенные курсы тенге с сайта KASE и сохраняет их в rates.json.
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
  if (!kzt.USD || kzt.USD.rate < 100 || kzt.USD.rate > 2000) {
    console.error("Курс USD/KZT не получен или выглядит неверно:", kzt.USD);
    process.exit(1);
  }

  const file = "rates.json";
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  if (prev && JSON.stringify(prev.kzt) === JSON.stringify(kzt)) { console.log("Курсы не изменились"); return; }
  const out = { source: "KASE", note: "Средневзвешенные курсы биржевых торгов KASE", updated: new Date().toISOString(), kzt };
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log("Записано:", JSON.stringify(kzt));
}

if (process.argv[1] && process.argv[1].endsWith("kase-rates.mjs")) main();
