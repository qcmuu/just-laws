// Query-side retrieval helpers for the in-browser MiniSearch index.
// Index tokenizer stays unigram+bigram. Queries drop stop unigrams and expand
// colloquial phrasing so "案子审完后原告还要做什么" can reach 民事诉讼法/执行条文
// instead of OR-matching 审/后/要 across 种子法、陪审员法.

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

const EXPANDERS = [
  { test: /案子|官司/, add: "案件" },
  { test: /审完|审结|判完|判下来|打完/, add: "判决 生效 审结" },
  { test: /原告|胜诉|赢了/, add: "申请执行 强制执行 履行 民事诉讼法" },
  { test: /被告|败诉|输了/, add: "履行 被执行人 民事诉讼法" },
  { test: /还要做什么|怎么办|下一步|之后怎么办/, add: "申请执行 执行程序 履行义务" },
  { test: /执行/, add: "强制执行 申请执行 民事诉讼法" },
  { test: /上诉/, add: "上诉期 第二审 民事诉讼法" },
  { test: /离婚/, add: "民法典 婚姻家庭 离婚" },
  { test: /劳动|开除|辞退|加班|工伤/, add: "劳动合同法 劳动争议" },
  { test: /合同违约|合同/, add: "民法典 合同编" },
];

export function expandLegalQuery(q) {
  const text = String(q || "").trim();
  if (!text) return "";
  const extra = [];
  for (const rule of EXPANDERS) {
    if (rule.test.test(text)) extra.push(rule.add);
  }
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
