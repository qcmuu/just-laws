const { defaultTheme } = require("@vuepress/theme-default");
const { searchPlugin } = require("@vuepress/plugin-search");

const siteBase = process.env.JUSTLAWS_BASE || "/";

// Absolute site origin (+base) for SEO tags and the generated sitemap URLs.
const siteUrl =
  (process.env.JUSTLAWS_SITE_URL || "https://qcmuu.github.io").replace(
    /\/+$/,
    ""
  ) + (siteBase !== "/" ? siteBase : "/");

module.exports = {
  lang: "zh-CN",
  title: "Just Laws AI",
  description: "中华人民共和国现行法律文库与 AI 智能法律问答系统",

  // Site base path. Defaults to "/" (custom domain / nginx root). For a GitHub
  // Pages project site (https://<user>.github.io/just-laws/) set
  // JUSTLAWS_BASE=/just-laws/ at build time. Must start and end with "/".
  base: siteBase,

  // Disable route-chunk prefetching. With 300+ laws the entry chunk
  // dynamic-imports hundreds of page chunks, so VuePress would otherwise emit
  // 400+ `<link rel="prefetch">` tags that fire on first paint. On a slow /
  // unstable connection (e.g. GitHub Pages from mainland China) this request
  // flood saturates the link and starves the critical hydration JS — the page
  // renders (prerendered HTML) but stays non-interactive ("假死"), so the
  // floating widget launcher looks clickable but does nothing until much later.
  // Without prefetch each page's chunk is fetched on navigation instead, which
  // makes the initial page interactive far sooner.
  shouldPrefetch: false,

  // Build-time config for the AI 法律问答 chat widget.
  // The widget is now fully client-side (BYOK): it loads /law-corpus.json,
  // retrieves 法条 in the browser, and calls a user-supplied OpenAI-compatible
  // endpoint — no backend required — so it is enabled by default.
  // - JUSTLAWS_RAG_ENABLED: feature flag. Set JUSTLAWS_RAG_ENABLED=false to hide
  //   the floating launcher (runtime override: window.__JUSTLAWS_RAG_ENABLED__).
  // VuePress JSON-stringifies define values itself, so pass the raw value.
  define: {
    __JUSTLAWS_RAG_ENABLED__: !["false", "0", "off", "no"].includes(
      String(process.env.JUSTLAWS_RAG_ENABLED || "true").toLowerCase()
    ),
  },
  head: [
    ["link", { rel: "icon", href: `${siteBase}images/logo.png` }],
    // --- SEO: social cards & misc (the <meta name="description"> comes from
    // `description` above; og/twitter apply site-wide) ---
    ["meta", { name: "theme-color", content: "#de2910" }],
    [
      "meta",
      {
        name: "keywords",
        content:
          "中国法律法规,法律文库,民法典,刑法,行政法,劳动法,AI法律问答,法条检索,法条原文",
      },
    ],
    ["meta", { property: "og:site_name", content: "Just Laws AI" }],
    ["meta", { property: "og:type", content: "website" }],
    [
      "meta",
      {
        property: "og:title",
        content: "Just Laws AI — 中国现行法律文库与 AI 智能法律问答",
      },
    ],
    [
      "meta",
      {
        property: "og:description",
        content:
          "收录 300+ 部现行法律法规原文，浏览器内 AI 智能问答、法条精准溯源，支持商汤、DeepSeek 等模型直连。",
      },
    ],
    ["meta", { property: "og:url", content: siteUrl }],
    ["meta", { property: "og:image", content: `${siteUrl}images/logo.png` }],
    ["meta", { name: "twitter:card", content: "summary" }],
    [
      "script",
      {},
      `var _hmt = _hmt || [];
      (function () {
        var hm = document.createElement('script')
        hm.src = 'https://hm.baidu.com/hm.js?f1b6f06a4a48c2db87fcba1a4b3c3ac4'
        var s = document.getElementsByTagName('script')[0]
        s.parentNode.insertBefore(hm, s)
      })()`,
    ],
  ],

  theme: defaultTheme({
    logo: "/images/logo.png",
    navbar: [
      {
        text: "全部类别",
        link: "/category/",
      },
      {
        text: "宪法",
        children: [
          { text: "宪法", link: "/constitution/", activeMatch: "^/constitution/(?!amendment)" },
          { text: "宪法修正案", link: "/constitution/amendment/" },
        ],
      },
      {
        text: "宪法相关法",
        children: [
          { text: "全国人民代表大会组织法", link: "/constitutional-relevance/npc-organization-law/" },
          { text: "民族区域自治法", link: "/constitutional-relevance/law-on-regional-national-autonomy/" },
          { text: "香港特别行政区基本法", link: "/constitutional-relevance/hong-kong-special-administrative-region-basic-law/" },
          { text: "查看全部 55 部宪法相关法", link: "/category/constitutional-relevance" },
        ],
      },
      {
        text: "民商法",
        children: [
          { text: "民法典", link: "/civil-and-commercial/civil-code/" },
          { text: "著作权法", link: "/civil-and-commercial/copyright-law/" },
          { text: "消费者权益保护法", link: "/civil-and-commercial/protection-of-the-rights-and-interests-of-consumers/" },
          { text: "公司法", link: "/civil-and-commercial/company-law/" },
        ],
      },
      {
        text: "行政法",
        children: [
          { text: "行政处罚法", link: "/administrative/administrative-penalty/" },
          { text: "治安管理处罚法", link: "/administrative/penalties-for-administration-of-public-security/" },
          { text: "义务教育法", link: "/administrative/compulsory-education-law/" },
          { text: "查看全部 96 部行政法", link: "/category/administrative" },
        ],
      },
      {
        text: "经济法",
        children: [
          { text: "个人所得税法", link: "/economic/individual-income-tax-law/" },
          { text: "中国人民银行法", link: "/economic/peoples-bank-of-china-law/" },
          { text: "个人信息保护法", link: "/economic/personal-information-protection-law/" },
          { text: "查看全部 90 部经济法", link: "/category/economic" },
        ],
      },
      {
        text: "社会法",
        children: [
          { text: "未成年人保护法", link: "/social/protection-of-minors/" },
          { text: "劳动法", link: "/social/labor-law/" },
          { text: "预防未成年人犯罪法", link: "/social/prevention-of-juvenile-delinquency/" },
          { text: "安全生产法", link: "/social/work-safety-law/" },
        ],
      },
      {
        text: "刑法",
        children: [
          { text: "刑法", link: "/criminal-law/criminal-law/" },
          { text: "刑法修正案", link: "/criminal-law/amendment/" },
          { text: "反有组织犯罪法", link: "/criminal-law/anti-organized-crime-law/" },
          { text: "反电信网络诈骗法", link: "/criminal-law/combating-telecom-and-online-fraud/" },
        ],
      },
      {
        text: "程序法",
        children: [
          { text: "刑事诉讼法", link: "/procedural/criminal-procedure/" },
          { text: "行政诉讼法", link: "/procedural/administrative-procedure/" },
          { text: "民事诉讼法", link: "/procedural/civil-procedure/" },
        ],
      },
      {
        text: "生态环境",
        children: [
          { text: "生态环境法典", link: "/ecological-environment/ecological-environment-code/" },
        ],
      },
      {
        text: "案例与文献",
        link: "/references/",
      },
      {
        text: "AI 设置",
        link: "/settings/",
      },
    ],
    sidebar: {
      "/category/": [
        {
          text: "类别",
          children: [
            "/category/constitutional-relevance",
            "/category/civil-and-commercial",
            "/category/administrative",
            "/category/economic",
            "/category/social",
            "/category/criminal-law",
            "/category/procedural",
            "/category/ecological-environment",
          ]
        }
      ],
      "/constitution/": [
        {
          text: "中华人民共和国宪法",
          children: [
            "/constitution/preamble.md",
            "/constitution/01-general-principles.md",
            "/constitution/02-civil-rights-and-duties.md",
            "/constitution/03-state-institutions.md",
            "/constitution/04-flag-anthem-emblem-capital.md",
          ],
        },
      ],
      "/criminal-law/criminal-law/": [
        {
          text: "中华人民共和国刑法",
          children: [
            "/criminal-law/criminal-law/01-general-provisions.md",
            "/criminal-law/criminal-law/02-specific-provisions.md",
            "/criminal-law/criminal-law/00-supplementary.md",
          ],
        },
      ],
      "/criminal-law/amendment/": [
        {
          text: "目录",
          children: [
            "/criminal-law/amendment/criminal-law-amendment-i.md",
            "/criminal-law/amendment/criminal-law-amendment-ii.md",
            "/criminal-law/amendment/criminal-law-amendment-iii.md",
            "/criminal-law/amendment/criminal-law-amendment-iv.md",
            "/criminal-law/amendment/criminal-law-amendment-v.md",
            "/criminal-law/amendment/criminal-law-amendment-vi.md",
            "/criminal-law/amendment/criminal-law-amendment-vii.md",
            "/criminal-law/amendment/criminal-law-amendment-viii.md",
            "/criminal-law/amendment/criminal-law-amendment-ix.md",
            "/criminal-law/amendment/criminal-law-amendment-x.md",
            "/criminal-law/amendment/criminal-law-amendment-xi.md",
          ],
        },
      ],
      "/procedural/criminal-procedure/": [
        {
          text: "中华人民共和国刑事诉讼法",
          children: [
            "/procedural/criminal-procedure/01-general-provisions.md",
            "/procedural/criminal-procedure/02-filing-investigation-prosecution.md",
            "/procedural/criminal-procedure/03-trial.md",
            "/procedural/criminal-procedure/04-enforcement.md",
            "/procedural/criminal-procedure/05-special-procedures.md",
            "/procedural/criminal-procedure/00-supplementary.md",
          ],
        },
      ],
      "/procedural/civil-procedure/": [
        {
          text: "中华人民共和国民事诉讼法",
          children: [
            "/procedural/civil-procedure/01-general-provisions.md",
            "/procedural/civil-procedure/02-trial-procedure.md",
            "/procedural/civil-procedure/03-execution-procedure.md",
            "/procedural/civil-procedure/04-special-provisions-for-foreign-related-civil-procedure.md",
          ],
        },
      ],
      "/civil-and-commercial/civil-code/": [
        {
          text: "中华人民共和国民法典",
          children: [
            "/civil-and-commercial/civil-code/01-general-principles.md",
            "/civil-and-commercial/civil-code/02-property-rights.md",
            "/civil-and-commercial/civil-code/03-contracts.md",
            "/civil-and-commercial/civil-code/04-personality-rights.md",
            "/civil-and-commercial/civil-code/05-marriage-and-family.md",
            "/civil-and-commercial/civil-code/06-inheritance.md",
            "/civil-and-commercial/civil-code/07-tort-liability.md",
            "/civil-and-commercial/civil-code/00-supplementary.md",
          ],
        },
      ],
      "/ecological-environment/ecological-environment-code/": [
        {
          text: "中华人民共和国生态环境法典",
          children: [
            "/ecological-environment/ecological-environment-code/01-general-principles.md",
            "/ecological-environment/ecological-environment-code/02-pollution-prevention-and-control.md",
            "/ecological-environment/ecological-environment-code/03-ecological-protection.md",
            "/ecological-environment/ecological-environment-code/04-green-and-low-carbon-development.md",
            "/ecological-environment/ecological-environment-code/05-legal-liability-and-supplementary.md",
          ],
        },
      ],
    },
    repo: "https://github.com/qcmuu/just-laws",
    docsRepo: "https://github.com/qcmuu/just-laws",
    docsBranch: "master",
    docsDir: "docs",
    editLinkText: "在 GitHub 上编辑此页",
    lastUpdated: true,
    lastUpdatedText: "上次更新",
    contributors: true,
    contributorsText: "贡献者",
    notFound: ["页面未找到"],
    backToHome: "回到主页",
    toggleColorMode: "切换夜间模式",
    toggleSidebar: "切换侧边栏",
  }),

  plugins: [
    // Local, build-time search index — zero third-party runtime requests.
    // This replaces DocSearch: its Algolia index (owned by the upstream repo)
    // returned results linking to www.justlaws.cn, leaking users to another
    // site, and Algolia endpoints are slow/unreliable from mainland China.
    searchPlugin({
      // Skip historical law versions (/versions/) to keep the index lean.
      isSearchable: (page) => !page.path.includes("/versions/"),
      hotKeys: [{ key: "k", ctrl: true }],
      maxSuggestions: 10,
      locales: {
        "/": {
          placeholder: "搜索法律、条文…",
        },
      },
    }),
  ],
};
