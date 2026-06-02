// @ts-nocheck
import { defineAsyncComponent } from "vue";
import { defineClientConfig } from "@vuepress/client";

// Load the floating "AI 法律问答" widget asynchronously so its code (and its
// heavy deps) is split into a separate chunk and never blocks the initial page
// render/hydration — important on slow networks (e.g. GitHub Pages in China).
const LawChatWidget = defineAsyncComponent(() =>
  import("./components/LawChatWidget.vue")
);

export default defineClientConfig({
  // Render the floating "AI 法律问答" widget at the app root on every page.
  rootComponents: [LawChatWidget],
  enhance({ router }) {
    router.afterEach((to) => {
      if (typeof _hmt != "undefined") {
        if (to.path) {
          _hmt.push(["_trackPageview", to.fullPath]);
        }
      }
    });
  },
});
