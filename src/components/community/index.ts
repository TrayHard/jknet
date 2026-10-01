/**
 * The community screens: the catalogue and the pages of communities, shared
 * by the launcher, the website and the web app. A host builds a
 * {@link CommunityPlatform} and draws {@link CommunityApp}, or the two
 * screens in panes of its own under a {@link CommunityPlatformProvider}.
 */

export { communityApi, catalogPath, eventsPath, failureOf, isCommunityId, readRanking, type CatalogQuery, type CommunityApi } from "./api";
export { CommunityApp, CommunityFrame } from "./CommunityApp";
export { CommunityCatalog } from "./CommunityCatalog";
export { CommunityView } from "./CommunityView";
export {
  catalogTab,
  CommunityPlatformProvider,
  pageTab,
  useCommunityPlatform,
  type CatalogTab,
  type CommunityHost,
  type CommunityPlatform,
  type CommunityRoute,
  type CommunitySeed,
  type PageTab,
  type PlayContext,
} from "./platform";
export type * from "./types";
