// app.js - 刷卡助手（通路檢核 + 刷滿跳下一張）
// 特色：
// 1) 規則可設定 requires_map: true，表示「必須命中 merchantmap 才可用」
// 2) 若規則本月刷滿/回饋用完，自動跳下一張
// 3) 若沒有任何指定通路符合，會回到通用卡（例如大戶黑卡）

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
  for (const row of MAP) {
    const kw = normalize(row.keyword);
    if (kw && m.includes(kw)) return row.default_region || "";
  }
  return "";
}

// 回傳所有命中的 rule_id（避免只命中第一個）
function mapRuleIds(merchant) {
  const m = normalize(merchant);
  const out = new Set();
  if (!m) return out;

  for (const row of MAP) {
    const kw = normalize(row.keyword);
    if (kw && m.includes(kw) && row.rule_id) out.add(row.rule_id);
  }
  return out;
}

function calcBestRule(merchant, region, amount, ym) {
  const used = loadUsed(ym);

  const matchedRuleIds = mapRuleIds(merchant); // Set(rule_id)
  const hasAnyMapMatch = matchedRuleIds.size > 0;

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

    const requiresMap = !!r.requires_map;
    const matchedByMap = matchedRuleIds.has(r.rule_id);

    // 指定通路卡：若店家沒命中該 rule_id，直接排除
    if (requiresMap && !matchedByMap) {
      return {
        r, u,
        remainReward, remainSpend,
        effSpend: 0,
        estReward: 0,
        exhausted: true,
        notEligible: true
      };
    }

    const effSpend = Math.max(0, Math.min(amount, remainSpend));
    const estReward = Math.max(0, Math.min(effSpend * (r.rate || 0), remainReward));

    const exhausted = (effSpend <= 0) || (remainReward <= 0) || (estReward <= 0);

    return { r, u, remainReward, remainSpend, effSpend, estReward, exhausted, notEligible: false };
  }

  function score(info) {
    const hintBoost = (matchedRuleIds.has(info.r.rule_id)) ? 2000 : 0;
    const exhaustedPenalty = info.exhausted ? -1e12 : 0;
    const notEligiblePenalty = info.notEligible ? -2e12 : 0;

    return notEligiblePenalty + exhaustedPenalty + hintBoost
      + (info.r.priority || 0) * 1000
      + info.estReward;
  }

  const infos = candidates.map(compute).sort((a, b) => score(b) - score(a));

  const firstUsable = infos.find(x => !x.exhausted);
  const chosen = firstUsable || infos[0];

  let note = "";
  if (!firstUsable) {
    note = "提醒：目前符合條件的規則都已刷滿/無回饋或不符合通路，以下僅顯示優先級最高的規則（回饋可能為 0）。";
  } else {
    const top = infos[0];
    if (chosen.r.rule_id !== top.r.rule_id && top.exhausted) {
      note = `注意：原本最優先的「${top.r.card} / ${top.r.rule_name}」本月已刷滿或無回饋/不符合通路，已自動改推薦下一張。`;
    } else if (!hasAnyMapMatch) {
      note = "提示：此店家未命中任何指定通路，已改用通用規則自動推薦。";
    }
  }

  return {
    best: chosen.r,
    estReward: chosen.estReward,
    remainReward: chosen.remainReward,
    remainSpend: chosen.remainSpend,
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
  // 先填日期（就算 fetch 失敗也至少看得到）
  const today = new Date();
  $("date").value = today.toISOString().slice(0, 10);

  try {
    RULES = await fetch("./data/rules.json", { cache: "no-store" }).then(r => r.json());
    MAP = await fetch("./data/merchantmap.json", { cache: "no-store" }).then(r => r.json());
  } catch (e) {
    console.error(e);
    msg("載入規則失敗：請確認 data/rules.json 與 data/merchantmap.json 路徑正確。");
    return;
  }

  $("merchant").addEventListener("input", () => {
    const ar = autoRegion($("merchant").value);
    if (ar) $("region").value = ar;
  });

  $("btnRecommend").addEventListener("click", () => {
    const merchant = $("merchant").value.trim();
    const amount = Number($("amount").value || 0);
    let region = $("region").value;

    if (!merchant) { msg("請輸入店家/描述"); return; }
    if (!(amount > 0)) { msg("請輸入正確金額"); return; }

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

    msg(out.note || "已更新推薦（可按「記一筆」累加）");
  });

  $("btnAdd").addEventListener("click", () => {
    if (!lastRecommendation) { msg("請先按「推薦」"); return; }

    const ym = ymKey(lastRecommendation.date);

    const tx = loadTx(ym);
    tx.push(lastRecommendation);
    saveTx(ym, tx);

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
