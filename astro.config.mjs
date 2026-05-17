// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import astroD2 from "astro-d2";
import tailwindcss from "@tailwindcss/vite";
import rehypePrettyCode from "rehype-pretty-code";
import sitemap from "@astrojs/sitemap";
import { transformerNotationDiff } from "@shikijs/transformers";
import theme from "shiki/themes/github-light-default.mjs";
import { visit } from "unist-util-visit";

import react from "@astrojs/react";

/** @type {import('rehype-pretty-code').Options} */
const rehypePrettyCodeOptions = {
  theme: theme,
  keepBackground: false,
  transformers: [transformerNotationDiff()],
};

/** @type {() => (tree: any) => void} */
const plugin = () => (tree) => {
  visit(tree, (node) => {
    if (node?.type === "element" && node?.tagName === "figure") {
      if (!("data-rehype-pretty-code-figure" in node.properties)) {
        return;
      }

      node.properties.class = "not-prose";
    }
  });
};

// https://astro.build/config
export default defineConfig({
  site: "https://klapacz.dev",
  integrations: [
    astroD2({
      pad: 40,
      sketch: true,
      experimental: {
        useD2js: true,
      },
    }),
    mdx(),
    sitemap(),
    react(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    syntaxHighlight: false,
    rehypePlugins: [
      [rehypePrettyCode, rehypePrettyCodeOptions],
      [plugin, {}],
    ],
  },
});
