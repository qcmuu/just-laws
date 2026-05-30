// @ts-nocheck
import { defineClientConfig } from "@vuepress/client";
import LawChatWidget from "./components/LawChatWidget.vue";

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
