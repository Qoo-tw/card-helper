let RULES = [];
let MAP = [];
let lastRecommendation = null;

const $ = (id) => document.getElementById(id);
const msg = (t) => { $("msg").textContent = t || ""; };

const ymKey = (d) => {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth()+1).padStart(2,"0");
  return `${y}-${m}`;
};

const storeKeyTx = (ym) => `tx:${ym}`;
const storeKeyUsed = (ym) => `used:${ym}`; // by rule_id

function loadUsed(ym){
  return JSON.parse(localStorage.getItem(storeKeyUsed(ym)) || "{}");
}
function saveUsed(ym, used){
  localStorage.setItem(storeKeyUsed(ym), JSON.stringify(used));
}
function loadTx(ym){
  return JSON.parse(localStorage.getItem(storeKeyTx(ym)) || "[]");
}
function saveTx(ym, tx){
  localStorage.setItem(storeKeyTx(ym), JSON.stringify(tx));
}

function normalize(s){
  return (s || "").toString().trim().toLowerCase();
}

function autoRegion(merchant){
  const m = normalize(merchant);
  if (!m) return "";
  // 找到第一個包含命中的 keyword（你可用更長 keyword 放前面提高命中精準）
  for (const row of MAP){
    const kw = normalize(row.keyword);
    if (kw && m.includes(kw)) return row.default_region || "";
  }
  return "";
}

function mapRuleId(merchant){
  const m = normalize(merchant);
  if (!m) return "";
  for (const row of MAP){
    const kw = normalize(row.keyword);
    if (kw && m.includes(kw)) return row.rule_id || "";
  }
  return "";
}

function calcBestRule(merchant, region, amount, ym){
  const used = loadUsed(ym);

  // 先看 MerchantMap 是否直接指到某個 rule_id（指定店家/精選通路）
  const hintedRuleId = mapRuleId(merchant);

  const candidates = RULES.filter(r => {
    const okRegion = !region || (r.regions || []).includes(region);
    return okRegion;
  });

  function compute(r){
    const u = used[r.rule_id] || { used_reward:0, used_spend:0 };
    const remainReward = (r.cap_reward ?? 0) - (u.used_reward || 0);
    const remainSpend  = (r.cap_spend  ?? 0) - (u.used_spend  || 0);

    // 這筆最多能放進此規則的可刷金額（刷滿就會變 0）
    const effSpend = Math.max(0, Math.min(amount, remainSpend));
    // 估算回饋：同時受 remainSpend & remainReward 限制
    const estReward = Math.max(0, Math.min(effSpend * r.rate, remainReward));

    const exhausted = (effSpend <= 0) || (remainReward <= 0) || (estReward <= 0);

    return { r, u, remainReward, remainSpend, effSpend, estReward, exhausted };
  }

  function score(info){
    // 命中 rule_id 的加分（你若不想鎖死，可把 1e6 改小）
    const hintBoost = (hintedRuleId && info.r.rule_id === hintedRuleId) ? 1e6 : 0;

    // ⚠️ 關鍵：刷滿/沒回饋的規則要大幅降權，避免「回饋=0 仍被推薦」
    // 用 -1e12 確保不會被 priority 輾壓回第一名
    const exhaustedPenalty = info.exhausted ? -1e12 : 0;

    return exhaustedPenalty + hintBoost + (info.r.priority || 0) * 1000 + info.estReward;
  }

  const infos = candidates.map(compute);
  infos.sort((a,b)=> score(b) - score(a));

  if (!infos.length) return null;

  const top = infos[0];
  // 先拿到「可回饋」的第一名（若 top 已刷滿，會自動往下找）
  const bestInfo = infos.find(x => !x.exhausted) || top;

  // 給 UI 用：如果 top 被跳過，帶一段提示文字
  let note = "";
  if (bestInfo.r.rule_id !== top.r.rule_id && top.exhausted) {
    note = `注意：原本最優先的「${top.r.card} / ${top.r.rule_name}」本月已刷滿或無回饋，已自動改推薦下一張。`;
  } else if (bestInfo.exhausted) {
    // 全部都刷滿/無回饋時：至少仍回傳 top，讓 UI 不會壞掉
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

  function scoreRule(r){
    const u = used[r.rule_id] || { used_reward:0, used_spend:0 };
    const remainReward = (r.cap_reward ?? 0) - (u.used_reward || 0);
    const remainSpend  = (r.cap_spend  ?? 0) - (u.used_spend  || 0);

    const effSpend = Math.max(0, Math.min(amount, remainSpend));
    const est = Math.max(0, Math.min(effSpend * r.rate, remainReward));

    // 指定命中 rule_id 給超大加分
    const hintBoost = (hintedRuleId && r.rule_id === hintedRuleId) ? 1e6 : 0;

    // priority 其次，最後用估算回饋做 tie-break
    return hintBoost + (r.priority || 0)*1000 + est;
  }

  candidates.sort((a,b)=> scoreRule(b)-scoreRule(a));

  const best = candidates[0];
  if (!best) return null;

  const u = used[best.rule_id] || { used_reward:0, used_spend:0 };
  const remainReward = (best.cap_reward ?? 0) - (u.used_reward || 0);
  const remainSpend  = (best.cap_spend  ?? 0) - (u.used_spend  || 0);
  const effSpend = Math.max(0, Math.min(amount, remainSpend));
  const estReward = Math.max(0, Math.min(effSpend * best.rate, remainReward));

  return { best, estReward, remainReward, remainSpend };
}

function renderTx(){
  const ym = ymKey($("date").value);
  const tx = loadTx(ym);
  $("txList").innerHTML = tx.slice().reverse().map(t => `
    <div class="item">
      <div>${t.date}｜${t.merchant}｜${t.region}｜$${t.amount}</div>
      <div>→ ${t.card} / ${t.rule_name}｜回饋 ${t.est_reward}</div>
    </div>
  `).join("") || "<div class='item'>本月尚無紀錄</div>";
}

async function init(){
  // default date today
  const today = new Date();
  $("date").value = today.toISOString().slice(0,10);

  // load data
  RULES = await fetch("./data/rules.json").then(r=>r.json());
  MAP = await fetch("./data/merchantmap.json").then(r=>r.json());

  // auto region when typing merchant
  $("merchant").addEventListener("input", ()=>{
    const ar = autoRegion($("merchant").value);
    if (ar) $("region").value = ar; // 自動填，但你仍可手動改
  });

  $("btnRecommend").addEventListener("click", ()=>{
    const merchant = $("merchant").value.trim();
    const amount = Number($("amount").value || 0);
    let region = $("region").value;

    if (!merchant){ msg("請輸入店家/描述"); return; }
    if (!(amount > 0)){ msg("請輸入正確金額"); return; }

    // 若 region 還空，嘗試自動
    if (!region){
      region = autoRegion(merchant) || "國內";
      $("region").value = region;
    }

    const ym = ymKey($("date").value);
    const out = calcBestRule(merchant, region, amount, ym);
    if (!out){ msg("找不到可用規則"); return; }

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

    msg("已更新推薦（可按「記一筆」累加）");
  });

  $("btnAdd").addEventListener("click", ()=>{
    if (!lastRecommendation){ msg("請先按「推薦」"); return; }
    const ym = ymKey(lastRecommendation.date);
    const tx = loadTx(ym);
    tx.push(lastRecommendation);
    saveTx(ym, tx);

    const used = loadUsed(ym);
    const u = used[lastRecommendation.rule_id] || { used_reward:0, used_spend:0 };
    u.used_reward += Number(lastRecommendation.est_reward || 0);
    u.used_spend  += Number(lastRecommendation.amount || 0);
    used[lastRecommendation.rule_id] = u;
    saveUsed(ym, used);

    msg("OK：已記一筆並累加本月使用量");
    renderTx();
  });

  $("btnReset").addEventListener("click", ()=>{
    const ym = ymKey($("date").value);
    localStorage.removeItem(storeKeyTx(ym));
    localStorage.removeItem(storeKeyUsed(ym));
    msg(`OK：已重置 ${ym} 本月資料（只影響本機）`);
    renderTx();
  });

  renderTx();
}

init();

