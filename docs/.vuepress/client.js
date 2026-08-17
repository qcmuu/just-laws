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

// Try to scroll to the article named in the location hash; return true on hit.
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
      }
    });
  },
});
