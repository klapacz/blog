import { getCollection } from "astro:content";

export async function getPublishedBlogPosts() {
  return getCollection("blog", ({ data }) => !data.draft);
}

export async function getPublishedBlogPostsSorted() {
  const posts = await getPublishedBlogPosts();

  return posts.sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
  );
}
