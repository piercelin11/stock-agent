const TWSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
const TPEX_URL =
  "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";

function isOrdinaryStock(code, name) {
  const isFourDigitNumeric = /^\d{4}$/.test(code); // 排除債券(5碼)、權證(6碼)等，順帶擋掉特別股/認股權憑證等含字母代號
  const isETF = code.startsWith("00"); // 排除 ETF(即使剛好4碼，如 0050)
  const isWarrantName = name.includes("購") || name.includes("售"); // 保險起見再擋一次權證

  return isFourDigitNumeric && !isETF && !isWarrantName;
}

function buildStock(code, name, closingPrice, change, market) {
  const prevClose = closingPrice - change;

  if (
    !isOrdinaryStock(code, name) ||
    !Number.isFinite(closingPrice) ||
    !Number.isFinite(change) ||
    !Number.isFinite(prevClose) ||
    prevClose <= 0
  ) {
    return null;
  }

  return {
    code,
    name,
    closingPrice,
    change,
    changePercent: (change / prevClose) * 100,
    market,
  };
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API 請求失敗 (${url}): ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function main() {
  const [twseData, tpexData] = await Promise.all([
    fetchJson(TWSE_URL),
    fetchJson(TPEX_URL),
  ]);

  const twseStocks = twseData
    .map((item) =>
      buildStock(
        item.Code,
        item.Name,
        parseFloat(item.ClosingPrice),
        parseFloat(item.Change),
        "上市"
      )
    )
    .filter(Boolean);

  const tpexStocks = tpexData
    .map((item) =>
      buildStock(
        item.SecuritiesCompanyCode,
        item.CompanyName,
        parseFloat(item.Close),
        parseFloat(item.Change),
        "上櫃"
      )
    )
    .filter(Boolean);

  const stocks = [...twseStocks, ...tpexStocks];

  const top20 = stocks
    .sort((a, b) => b.changePercent - a.changePercent)
    .slice(0, 20);

  console.log(
    `共取得 ${stocks.length} 檔股票資料（上市 ${twseStocks.length} 檔、上櫃 ${tpexStocks.length} 檔），漲幅前 20 名如下：\n`
  );
  console.log(
    "排名".padEnd(4) +
      "代號".padEnd(8) +
      "名稱".padEnd(14) +
      "市場".padEnd(6) +
      "收盤價".padEnd(10) +
      "漲跌".padEnd(10) +
      "漲跌幅",
  );
  console.log("-".repeat(66));

  top20.forEach((s, i) => {
    console.log(
      String(i + 1).padEnd(4) +
        s.code.padEnd(8) +
        s.name.padEnd(12) +
        s.market.padEnd(6) +
        s.closingPrice.toFixed(2).padEnd(10) +
        s.change.toFixed(2).padEnd(10) +
        `${s.changePercent.toFixed(2)}%`,
    );
  });
}

main().catch((err) => {
  console.error("執行失敗:", err.message);
  process.exit(1);
});
