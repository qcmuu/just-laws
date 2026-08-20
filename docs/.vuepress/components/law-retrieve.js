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
  { test: /劳动|开除|辞退|加班|工伤|工资/, add: "劳动合同法 劳动争议" },
  { test: /合同违约|合同/, add: "民法典 合同编" },
  { test: /租房|房租|房东|租客|押金|租金/, add: "房屋租赁 出租人 承租人 民法典" },
  { test: /欠钱|借钱|诉讼时效/, add: "诉讼时效 民法典" },
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

export function searchLaws(mini, query, topK = 6) {
  if (!mini) return [];
  const q = expandLegalQuery(query);
  if (!q) return [];
  return mini.search(q, SEARCH_OPTIONS).slice(0, topK);
}
