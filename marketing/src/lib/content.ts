import { getCollection, type CollectionEntry } from "astro:content";

const isPublished = <T extends { data: { draft?: boolean } }>(entry: T) =>
  !entry.data.draft || !import.meta.env.PROD;

export const getPublishedPages = async (): Promise<
  CollectionEntry<"pages">[]
> => (await getCollection("pages")).filter(isPublished);
