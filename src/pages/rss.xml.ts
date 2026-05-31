import type { APIRoute } from "astro";

import rss from "@astrojs/rss";
import { SITE_TITLE, SITE_DESCRIPTION } from "../consts";
import { getPublishedBlogPosts } from "../lib/posts";

export const GET: APIRoute = async (context) => {
  const posts = await getPublishedBlogPosts();
  return rss({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    site: context.site!,
    items: posts.map((post) => ({
      ...post.data,
      link: `/blog/${post.slug}/`,
    })),
  });
};
