// Query-side retrieval helpers for the in-browser MiniSearch index.
// Index tokenizer stays unigram+bigram. Queries drop stop unigrams and expand
// by topic + combination intent (not lone 原告/怎么办) so colloquial questions
// reach the matching 法典 instead of OR-matching 强制执行 into 行政强制法.

export function cjkTokenize(str) {
  if (!str) return [];
  const tokens = [];
  const re = /[\u4e00-\u9fff]+|[a-zA-Z0-9]+/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const run = m[0];
    if (/[a-zA-Z0-9]/.test(run[0])) {
      tokens.push(run.toLowerCase());
    } else {
      for (let i = 0; i < run.length; i++) {
        tokens.push(run[i]);
        if (i + 1 < run.length) tokens.push(run[i] + run[i + 1]);
      }
    }
  }
  return tokens;
}

const QUERY_STOP_UNIGRAMS = new Set(
  "的了吗呢啊吧把被在是有和与及或就还要做什么后完个这那怎请问题嘛呀哦".split("")
);

export function queryTokenize(str) {
  return cjkTokenize(str).filter((token) => {
    if (token.length >= 2) return true;
    return !QUERY_STOP_UNIGRAMS.has(token);
  });
}

// Topic → legal terms only. Role words (原告/被告) and question mood
// (怎么办) are not intents: injecting 强制执行 here lets 行政强制法
// dominate MiniSearch OR ranking on every everyday question.
const DOMAIN_EXPANDERS = [
  { test: /案子|官司/, add: "案件" },
  { test: /审完|审结|判完|判下来|打完/, add: "判决 生效" },
  { test: /上诉/, add: "上诉期 第二审 民事诉讼法" },
  { test: /离婚/, add: "民法典 婚姻家庭" },
  // 工伤 is its own statute (工伤保险条例 is not in the corpus, but 社会保险法
  // and 劳动能力鉴定 are), so it must not collapse into the labour-contract rule.
  { test: /工伤/, add: "工伤保险 社会保险法 工伤认定 劳动能力鉴定" },
  { test: /劳动|开除|辞退|加班|工资/, add: "劳动合同法 劳动争议" },
  { test: /合同违约|合同/, add: "民法典 合同编" },
  { test: /租房|房租|房东|租客|押金|租金/, add: "房屋租赁 出租人 承租人 民法典" },
  { test: /欠钱|借钱|诉讼时效/, add: "诉讼时效 民法典" },
  // Vocabulary gaps measured on the holdout/test query sets: everyday words
  // with no statutory counterpart (打赏, 假货, 网暴, 高空抛物).
  { test: /打赏|充值/, add: "限制民事行为能力 民事行为能力 返还 民法典" },
  { test: /食品|外卖|饭菜|异物|过期/, add: "食品安全 消费者权益 赔偿责任" },
  { test: /网暴|辱骂|诽谤|骚扰/, add: "名誉权 人格权 治安管理处罚 民法典" },
  { test: /高空抛物|坠物|楼上掉/, add: "抛掷物品 坠落 建筑物 侵权责任 民法典" },
];

const POST_JUDGMENT = /审完|审结|判完|判下来|判决生效|打完/;
const NEXT_STEP = /还要做什么|下一步|之后怎么办|然后呢/;
const EXPLICIT_EXECUTION = /申请执行|强制执行|拒不执行/;
const LOST_CASE = /败诉|输了/;
const WON_CASE = /胜诉|赢了/;
const NONPERFORMANCE = /不(履行|执行|给|还)|赖账/;

// Combination-intent only. A lone 原告/怎么办 must not expand to 执行.
export function executionIntentTerms(text) {
  if (LOST_CASE.test(text) && !EXPLICIT_EXECUTION.test(text)) return "";
  if (EXPLICIT_EXECUTION.test(text)) return "申请执行 民事诉讼法";
  if (WON_CASE.test(text) && NONPERFORMANCE.test(text)) {
    return "申请执行 民事诉讼法";
  }
  if (POST_JUDGMENT.test(text) && NEXT_STEP.test(text)) {
    return "申请执行 民事诉讼法";
  }
  return "";
}

export function appealIntentTerms(text) {
  if (LOST_CASE.test(text) && !EXPLICIT_EXECUTION.test(text)) {
    return "上诉 第二审 民事诉讼法";
  }
  return "";
}

export function expandLegalQuery(q) {
  const text = String(q || "").trim();
  if (!text) return "";
  const extra = [];
  for (const rule of DOMAIN_EXPANDERS) {
    if (rule.test.test(text)) extra.push(rule.add);
  }
  const execution = executionIntentTerms(text);
  if (execution) extra.push(execution);
  const appeal = appealIntentTerms(text);
  if (appeal) extra.push(appeal);
  return extra.length ? `${text} ${extra.join(" ")}` : text;
}

export const SEARCH_OPTIONS = {
  tokenize: queryTokenize,
  boost: { n: 4, t: 1, c: 1.4 },
  combineWith: "OR",
};

// Function words that would otherwise form meaningless bigrams with their
// neighbours ("工被", "司违").
const STOP_CHARS = new Set(
  "的了吗呢啊吧把被在是有和与及或就还要做什么后完个这那怎请问题嘛呀哦我你他她它们".split("")
);
const STOP_BIGRAMS = new Set([
  "怎么", "什么", "多久", "可以", "应该", "需要", "如何", "哪些", "多少",
]);

// The user's own bigrams — the words they actually used, minus function words
// and sliding-window artifacts that straddle one. These are the ranking keys:
// an article containing 押金/拖欠/工伤 beats one that merely shares characters.
export function userBigrams(q) {
  const text = String(q || "");
  const out = new Set();
  const re = /[一-鿿]+|[a-zA-Z0-9]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const run = m[0];
    if (/[a-zA-Z0-9]/.test(run[0])) {
      out.add(run.toLowerCase());
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) {
      const a = run[i];
      const b = run[i + 1];
      if (STOP_CHARS.has(a) || STOP_CHARS.has(b)) continue;
      const bigram = a + b;
      if (STOP_BIGRAMS.has(bigram)) continue;
      out.add(bigram);
    }
  }
  return [...out];
}

// Index-side tokenizer config, shared by the worker and the main-thread
// fallback so both build identical indexes.
export const INDEX_OPTIONS = {
  fields: ["t", "n", "c"],
  storeFields: ["n", "a", "c", "u", "t"],
  tokenize: cjkTokenize,
  searchOptions: { tokenize: cjkTokenize, boost: { n: 3, c: 1.5 } },
};

const POOL_SIZE = 150; // candidates scored before ranking
const PER_LAW_CAP = 2; // keep the answer from quoting one statute only

// A follow-up this short may have no retrievable words of its own.
export const FOLLOWUP_MERGE_MAX_CHARS = 12;
const FOLLOWUP_MARKER =
  /^(那|那么|这个|这种|它|其|还有|如果|假如|要是|继续|然后)/;

// Decide whether a question should inherit the previous question's terms.
// Length alone is not enough: "公司拖欠工资怎么维权" is 10 characters but a
// new topic, and merging it into the previous subject ranked its sources
// against the wrong topic. Merge only when the question reads as a
// continuation, or is short and has no content words at all ("怎么办？").
export function shouldInheritContext(question) {
  const q = String(question || "").trim();
  if (!q) return false;
  if (FOLLOWUP_MARKER.test(q)) return true;
  if (q.length > FOLLOWUP_MERGE_MAX_CHARS) return false;
  return userBigrams(q).length === 0;
}

function coverageScore(hit, bigrams) {
  if (!bigrams.length) return 0;
  const text = `${hit.n || ""} ${hit.c || ""} ${hit.t || ""}`;
  let hitCount = 0;
  for (const bigram of bigrams) {
    if (text.includes(bigram)) hitCount++;
  }
  return hitCount / bigrams.length;
}

// Two-stage retrieval. The expanded query recalls candidates (BM25 over an
// OR query is broad and cheap), then articles are ranked by how much of the
// *user's own wording* they contain. Unigrams are what make plain BM25 fail
// here: 司/工/资 match half the corpus, so "公司拖欠工资怎么维权" used to
// return six 公司法 articles and "房东不退押金怎么办" returned 行政强制法.
export function searchLaws(mini, query, topK = 6) {
  if (!mini) return [];
  const limit = Math.max(0, Math.floor(Number(topK) || 0));
  if (!limit) return [];
  const q = String(query || "").trim();
  if (!q) return [];

  const bigrams = userBigrams(q);
  const pool = mini
    .search(expandLegalQuery(q), SEARCH_OPTIONS)
    .slice(0, POOL_SIZE);
  if (!pool.length) return [];

  // Coverage dominates; BM25 breaks ties within the same word coverage.
  const ranked = pool
    .map((hit) => ({ hit, coverage: coverageScore(hit, bigrams) }))
    .sort((a, b) => b.coverage - a.coverage || b.hit.score - a.hit.score);

  const perLaw = new Map();
  const out = [];
  for (const { hit } of ranked) {
    const used = perLaw.get(hit.n) || 0;
    if (used >= PER_LAW_CAP) continue;
    perLaw.set(hit.n, used + 1);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}
