// app.js - 刷卡助手（全新整理版）
// 重點：當規則本月已刷滿/已無回饋時，自動跳過，改推薦下一張

"use strict";

let RULES = [];
let MAP = [];
let lastRecommendation = null;

const $ = (id) => document.getElementById(id);
const msg = (t) => { $("msg").textContent = t || ""; };

const ymKey = (d) => {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
};

const storeKeyTx = (ym) => `tx:${ym}`;
const storeKeyUsed = (ym) => `used:${ym}`; // by rule_id

function loadUsed(ym) {
  return JSON.parse(localStorage.getItem(storeKeyUsed(ym)) || "{}");
}
function saveUsed(ym, used) {
  localStorage.setItem(storeKeyUsed(ym), JSON.stringify(used));
}
function loadTx(ym) {
  return JSON.parse(localStorage.getItem(storeKeyTx(ym)) || "[]");
}
function saveTx(ym, tx) {
  localStorage.setItem(storeKeyTx(ym), JSON.stringify(tx));
}

function normalize(s) {
  return (s || "").toString().trim().toLowerCase();
}

function autoRegion(merchant) {
  const m = normalize(merchant);
  if (!m) return "";
  // 找到第一個包含命中的 keyword（你可用更長 keyword 放前面提高命中精準）
  for (const row of MAP) {
    const kw = normalize(row.keyword);
    if (kw && m.includes(kw)) return row.default_region || "";
  }
  return "";
}

function mapRuleId(merchant) {
  const m = normalize(merchant);
  if (!m) return "";
  for (const row of MAP) {
    const kw = normalize(row.keyword);
    if (kw && m.includes(kw)) return row.rule_id || "";
  }
  return "";
}

/**
 * 挑出最佳規則：
 * - 先依 region 過濾候選
 * - 計算每條規則「本筆可刷金額 effSpend」與「本筆估算回饋 estReward」
 * - 若規則已刷滿/已無回饋（exhausted），會自動跳過，改選下一張
 * - 仍保留 merchantmap 命中 rule_id 的偏好（可自行調整 hintBoost 強度）
 */
function calcBestRule(merchant, region, amount, ym) {
  const used = loadUsed(ym);
  const hintedRuleId = mapRuleId(merchant);

  const candidates = RULES.filter(r => {
    const okRegion = !region || (r.regions || []).includes(region);
    return okRegion;
  });

  if (!candidates.length) return null;

  function compute(r) {
    const u = used[r.rule_id] || { used_reward: 0, used_spend: 0 };

    const capReward = (r.cap_reward ?? 0);
    const capSpend  = (r.cap_spend ?? 0);

    const remainReward = capReward - (u.used_reward || 0);
    const remainSpend  = capSpend  - (u.used_spend || 0);

    // 本筆最多能放進此規則的可刷金額（刷滿就會變 0）
    const effSpend = Math.max(0, Math.min(amount, remainSpend));

    // 估算回饋：同時受 remainSpend & remainReward 限制
    const estReward = Math.max(0, Math.min(effSpend * (r.rate || 0), remainReward));

    // exhausted：本月已刷滿 / 已無回饋（不該再被推薦）
    const exhausted = (effSpend <= 0) || (remainReward <= 0) || (estReward <= 0);

    return { r, u, remainReward, remainSpend, effSpend, estReward, exhausted };
  }

  function score(info) {
    // 命中 rule_id 的加分（目前是「強偏好」，若不想鎖死可改小，例如 500 或 2000）
    const hintBoost = (hintedRuleId && info.r.rule_id === hintedRuleId) ? 1e6 : 0;

    // 關鍵：刷滿/沒回饋的規則要大幅降權，避免「回饋=0 仍被推薦」
    // 用 -1e12 確保不會被 priority 輾壓回第一名
    const exhaustedPenalty = info.exhausted ? -1e12 : 0;

    // priority 其次，最後用估算回饋做 tie-break
    return exhaustedPenalty + hintBoost + (info.r.priority || 0) * 1000 + info.estReward;
  }

  const infos = candidates.map(compute);
  infos.sort((a, b) => score(b) - score(a));

  const top = infos[0];
  const bestInfo = infos.find(x => !x.exhausted) || top;

  let note = "";
  if (bestInfo.r.rule_id !== top.r.rule_id && top.exhausted) {
    note = `注意：原本最優先的「${top.r.card} / ${top.r.rule_name}」本月已刷滿或無回饋，已自動改推薦下一張。`;
  } else if (bestInfo.exhausted) {
    note = "提醒：目前所有符合條件的規則本月都已刷滿或無回饋，以下僅顯示優先級最高的規則（回饋可能為 0）。";
  }

  return {
    best: bestInfo.r,
    estReward: bestInfo.estReward,
    remainReward: bestInfo.remainReward,
    remainSpend: bestInfo.remainSpend,
    note
  };
}

function renderTx() {
  const ym = ymKey($("date").value);
  const tx = loadTx(ym);
  $("txList").innerHTML = tx.slice().reverse().map(t => `
    <div class="item">
      <div>${t.date}｜${t.merchant}｜${t.region}｜$${t.amount}</div>
      <div>→ ${t.card} / ${t.rule_name}｜回饋 ${t.est_reward}</div>
    </div>
  `).join("") || "<div class='item'>本月尚無紀錄</div>";
}

async function init() {
  // default date today
  const today = new Date();
  $("date").value = today.toISOString().slice(0, 10);

  // load data
  try {
    RULES = await fetch("./data/rules.json", { cache: "no-store" }).then(r => r.json());
    MAP = await fetch("./data/merchantmap.json", { cache: "no-store" }).then(r => r.json());
  } catch (e) {
    console.error(e);
    msg("載入規則失敗：請確認 data/rules.json 與 data/merchantmap.json 路徑正確，並重新整理。");
    return;
  }

  // auto region when typing merchant
  $("merchant").addEventListener("input", () => {
    const ar = autoRegion($("merchant").value);
    if (ar) $("region").value = ar; // 自動填，但你仍可手動改
  });

  $("btnRecommend").addEventListener("click", () => {
    const merchant = $("merchant").value.trim();
    const amount = Number($("amount").value || 0);
    let region = $("region").value;

    if (!merchant) { msg("請輸入店家/描述"); return; }
    if (!(amount > 0)) { msg("請輸入正確金額"); return; }

    // 若 region 還空，嘗試自動
    if (!region) {
      region = autoRegion(merchant) || "國內";
      $("region").value = region;
    }

    const ym = ymKey($("date").value);
    const out = calcBestRule(merchant, region, amount, ym);
    if (!out) { msg("找不到可用規則"); return; }

    lastRecommendation = {
      date: $("date").value,
      merchant, region, amount,
      rule_id: out.best.rule_id,
      card: out.best.card,
      rule_name: out.best.rule_name,
      est_reward: Math.round(out.estReward),
      remain_reward: Math.max(0, Math.round(out.remainReward)),
      remain_spend: Math.max(0, Math.round(out.remainSpend))
    };

    $("outCard").textContent = lastRecommendation.card;
    $("outRule").textContent = `${lastRecommendation.rule_id}｜${lastRecommendation.rule_name}`;
    $("outReward").textContent = String(lastRecommendation.est_reward);
    $("outRemainReward").textContent = String(lastRecommendation.remain_reward);
    $("outRemainSpend").textContent = String(lastRecommendation.remain_spend);

    // ✅ 這行很重要：顯示跳過刷滿規則的原因
    msg(out.note || "已更新推薦（可按「記一筆」累加）");
  });

  $("btnAdd").addEventListener("click", () => {
    if (!lastRecommendation) { msg("請先按「推薦」"); return; }

    const ym = ymKey(lastRecommendation.date);

    // append tx
    const tx = loadTx(ym);
    tx.push(lastRecommendation);
    saveTx(ym, tx);

    // update used
    const used = loadUsed(ym);
    const u = used[lastRecommendation.rule_id] || { used_reward: 0, used_spend: 0 };
    u.used_reward += Number(lastRecommendation.est_reward || 0);
    u.used_spend  += Number(lastRecommendation.amount || 0);
    used[lastRecommendation.rule_id] = u;
    saveUsed(ym, used);

    msg("OK：已記一筆並累加本月使用量");
    renderTx();
  });

  $("btnReset").addEventListener("click", () => {
    const ym = ymKey($("date").value);
    localStorage.removeItem(storeKeyTx(ym));
    localStorage.removeItem(storeKeyUsed(ym));
    msg(`OK：已重置 ${ym} 本月資料（只影響本機）`);
    renderTx();
  });

  renderTx();
}

init();
