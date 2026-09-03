// @ts-nocheck
import { defineAsyncComponent } from "vue";
import { defineClientConfig } from "@vuepress/client";

import LawModelSettings from "./components/LawModelSettings.vue";
import ReferenceIndex from "./components/ReferenceIndex.vue";

// Load the floating "AI 法律问答" widget asynchronously so its code (and its
// heavy deps) is split into a separate chunk and never blocks the initial page
// render/hydration — important on slow networks (e.g. GitHub Pages in China).
const LawChatWidget = defineAsyncComponent(() =>
  import("./components/LawChatWidget.vue")
);

// --- SEO: per-page WebPage + BreadcrumbList JSON-LD -------------------------
// The static WebSite entity lives in config.js head. Here we keep a single
// injected script tag updated on every route so crawlers that execute JS see
// the current page and its position in the site hierarchy.

const SEGMENT_NAMES = {
  category: "部门法分类",
  constitution: "宪法",
  "constitutional-relevance": "宪法相关法",
  "civil-and-commercial": "民商法",
  administrative: "行政法",
  economic: "经济法",
  social: "社会法",
  "criminal-law": "刑法",
  procedural: "诉讼程序法",
  "ecological-environment": "生态环境",
  references: "案例与文献",
  settings: "AI 设置",
  versions: "历史版本",
};

function upsertJsonLd(path) {
  const origin = window.location.origin;
  const base = typeof __JUSTLAWS_BASE__ === "string" ? __JUSTLAWS_BASE__ : "/";
  const url = origin + base.replace(/\/+$/, "") + path;
  const segments = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const first = segments[0];
  const rootName = first ? SEGMENT_NAMES[first] : "首页";

  const graph = [
    {
      "@type": "WebPage",
      "@id": url,
      url,
      name: document.title.replace(/\s*\|\s*Just Laws AI\s*$/, ""),
      isPartOf: { "@id": origin + base },
    },
  ];

  // Breadcrumb only makes sense when the page sits below a known section.
  if (first && rootName) {
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "首页", item: origin + base },
        {
          "@type": "ListItem",
          position: 2,
          name: rootName,
          item: origin + base.replace(/\/+$/, "") + "/" + first + "/",
        },
        { "@type": "ListItem", position: 3, name: document.title.replace(/\s*\|\s*Just Laws AI\s*$/, ""), item: url },
      ],
    });
  }

  let el = document.getElementById("jl-jsonld");
  if (!el) {
    el = document.createElement("script");
    el.type = "application/ld+json";
    el.id = "jl-jsonld";
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": graph,
  });
}

// --- 法条锚点 affordance -----------------------------------------------------
// hovering a bold "第X条" marker shows a small seal-styled button; clicking it
// writes the article deep link (#第X条) into the URL and copies it. The tip is
// a single floating element — the rendered markdown DOM is never mutated.

const ARTICLE_RE = /^第[〇零一二三四五六七八九十百千万\d]+条/;
// Created lazily on first client-side enhance(): this module is also evaluated
// during the build's SSR pass, where `document` does not exist.
let anchorTip = null;
let anchorTarget = null;
let anchorHideTimer = 0;
let anchorFlashTimer = 0;

function anchorTipVisible() {
  return !!anchorTip && anchorTip.style.display === "block";
}

function positionAnchorTip(el) {
  const rect = el.getBoundingClientRect();
  anchorTip.style.left =
    window.scrollX + rect.left - anchorTip.offsetWidth - 10 + "px";
  anchorTip.style.top =
    window.scrollY + rect.top + rect.height / 2 - anchorTip.offsetHeight / 2 + "px";
}

function onMouseOver(e) {
  const el = e.target.closest && e.target.closest(".theme-default-content strong");
  if (!el || !anchorTip || !ARTICLE_RE.test((el.textContent || "").trim())) return;
  clearTimeout(anchorHideTimer);
  if (anchorTarget === el && anchorTipVisible()) return;
  anchorTarget = el;
  anchorTip.style.display = "block";
  positionAnchorTip(el);
}

function onMouseOut(e) {
  if (!anchorTipVisible()) return;
  const to = e.relatedTarget;
  // stay visible while the pointer is still on the article marker or has
  // moved onto the tip itself (the 120 ms timer only covers brief gaps)
  if (to && anchorTarget && (to === anchorTarget || anchorTarget.contains(to)))
    return;
  if (to && (to === anchorTip || anchorTip.contains(to))) return;
  anchorHideTimer = window.setTimeout(() => {
    anchorTip.style.display = "none";
    anchorTarget = null;
  }, 120);
}

function onAnchorTipClick() {
  if (!anchorTarget) return;
  const label = (anchorTarget.textContent || "").trim().match(ARTICLE_RE)[0];
  window.location.hash = encodeURIComponent(label);
  const link = window.location.href;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).catch(() => {});
  }
  clearTimeout(anchorFlashTimer);
  anchorTip.textContent = "✓ 已复制";
  anchorFlashTimer = window.setTimeout(() => {
    anchorTip.textContent = "§ 引用";
  }, 1200);
}

// Mount the floating citation tip and its delegated listeners. Called from
// enhance() in the browser only.
function ensureAnchorTip() {
  if (anchorTip || typeof document === "undefined") return;
  anchorTip = document.createElement("button");
  anchorTip.type = "button";
  anchorTip.className = "jl-art-anchor";
  anchorTip.textContent = "§ 引用";
  anchorTip.setAttribute("aria-label", "复制本条深链");
  anchorTip.style.display = "none";
  anchorTip.addEventListener("click", onAnchorTipClick);
  document.body.appendChild(anchorTip);
  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("mouseout", onMouseOut, true);
  // hide the tip on scroll: it is positioned absolutely, so it would drift
  // away from its article marker
  window.addEventListener(
    "scroll",
    () => {
      if (anchorTipVisible()) {
        anchorTip.style.display = "none";
        anchorTarget = null;
      }
    },
    { passive: true }
  );
}
function scrollToLawArticle(hash) {
  // Corpus citations use the article marker (e.g. #第一条), which is bold text
  // rather than a heading, so VuePress has no native anchor for it.
  const root = document.querySelector(".theme-default-content");
  if (!root) return false;
  const nodes = root.querySelectorAll("strong");
  for (let i = 0; i < nodes.length; i++) {
    const t = (nodes[i].textContent || "").trim();
    if (t === hash || t.startsWith(hash)) {
      nodes[i].scrollIntoView({ behavior: "smooth", block: "start" });
      return true;
    }
  }
  return false;
}

// On SPA navigation the page chunk may still be loading, so retry with a short
// backoff. A navigation id cancels timers from earlier navigations and stops
// retrying once the article has been found.
let articleScrollNavId = 0;
const ARTICLE_SCROLL_DELAYS = [80, 250, 600, 1200];

function scheduleArticleScroll() {
  let hash = window.location.hash.replace(/^#/, "");
  if (!hash) return;
  try {
    hash = decodeURIComponent(hash);
  } catch (e) {
    /* keep raw */
  }
  if (!/^第.+条/.test(hash)) return;
  const navId = ++articleScrollNavId;
  for (const delay of ARTICLE_SCROLL_DELAYS) {
    window.setTimeout(() => {
      if (navId !== articleScrollNavId) return;
      if (scrollToLawArticle(hash)) articleScrollNavId++;
    }, delay);
  }
}

export default defineClientConfig({
  // Render the floating "AI 法律问答" widget at the app root on every page.
  rootComponents: [LawChatWidget],
  enhance({ app, router }) {
    // Global registration so markdown pages (docs/settings/README.md) can use
    // the shared BYOK settings form: <LawModelSettings variant="page" />.
    app.component("LawModelSettings", LawModelSettings);
    app.component("ReferenceIndex", ReferenceIndex);
    router.afterEach((to) => {
      if (typeof _hmt != "undefined") {
        if (to.path) {
          _hmt.push(["_trackPageview", to.fullPath]);
        }
      }
      if (typeof window !== "undefined") {
        scheduleArticleScroll();
        // document.title is updated right after afterEach, so read it on the
        // next tick to name the WebPage / breadcrumb items correctly.
        window.setTimeout(() => upsertJsonLd(to.path), 120);
      }
    });
    // Mount the floating article-citation tip (browser only — enhance also
    // runs during the build's SSR pass).
    if (typeof document !== "undefined") {
      ensureAnchorTip();
    }
  },
});
