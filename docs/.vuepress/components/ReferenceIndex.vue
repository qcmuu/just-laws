<!-- @ts-nocheck -->
<template>
  <div class="jl-ref">
    <nav class="jl-ref__toc" aria-label="专题分类导航">
      <a
        v-for="sec in sections"
        :key="sec.id"
        :href="'#' + sec.id"
        :class="{ 'is-current': currentId === sec.id }"
        @click.prevent="jump(sec.id)"
      >
        {{ sec.short }}（{{ sec.count }}）
      </a>
    </nav>

    <details
      v-for="(sec, i) in sections"
      :id="sec.id"
      :key="sec.id"
      class="jl-ref__fold"
      :open="!!opened[sec.id]"
      @toggle="onToggle(sec.id, $event)"
    >
      <summary>
        <span class="jl-ref__fold-title">{{ i + 1 }}. {{ sec.short }}</span>
        <span class="jl-ref__fold-count">共 {{ sec.count }} 篇</span>
      </summary>
      <div class="jl-ref__scroll">
        <table>
          <thead>
            <tr>
              <th>序号</th>
              <th>文献/案例名称</th>
              <th>类型</th>
              <th>正文长度</th>
              <th>原始来源</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in sec.items" :key="sec.id + '-' + it.n">
              <td>{{ it.n }}</td>
              <td>{{ it.title }}</td>
              <td class="jl-ref__kind">{{ it.kind }}</td>
              <td class="jl-ref__len">{{ it.len }}</td>
              <td>
                <a :href="it.url" target="_blank" rel="noopener noreferrer">原始网页</a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </div>
</template>

<script>
import catalog from "../data/ref-catalog.js";

export default {
  name: "ReferenceIndex",
  data() {
    const sections = catalog;
    const opened = {};
    sections.forEach((sec, i) => {
      opened[sec.id] = i === 0;
    });
    return {
      sections,
      opened,
      currentId: sections[0] ? sections[0].id : "",
    };
  },
  mounted() {
    this.applyHash();
    window.addEventListener("hashchange", this.applyHash);
  },
  beforeUnmount() {
    window.removeEventListener("hashchange", this.applyHash);
  },
  methods: {
    applyHash() {
      const raw = (window.location.hash || "").replace(/^#/, "");
      if (!raw) return;
      let id = raw;
      try {
        id = decodeURIComponent(raw);
      } catch (e) {
        /* keep */
      }
      if (this.sections.some((s) => s.id === id)) {
        this.jump(id, false);
      }
    },
    jump(id, push = true) {
      this.opened = { ...this.opened, [id]: true };
      this.currentId = id;
      if (push) {
        history.replaceState(null, "", `#${id}`);
      }
      this.$nextTick(() => {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },
    onToggle(id, event) {
      const isOpen = event.target.open;
      this.opened = { ...this.opened, [id]: isOpen };
      if (isOpen) this.currentId = id;
    },
  },
};
</script>
