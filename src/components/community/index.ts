/**
 * The community screens: the catalogue and the pages of communities, shared
 * by the launcher, the website and the web app. A host builds a
 * {@link CommunityPlatform} and draws {@link CommunityApp}, or the two
 * screens in panes of its own under a {@link CommunityPlatformProvider}.
 *
 * The management screen is not exported here: it carries the Markdown
 * editors, and a host that shows it imports `./manage` itself and hands it
 * to `CommunityApp` as `renderManage`.
 */

export { communityApi, catalogPath, eventsPath, failureOf, isCommunityId, readRanking, type CatalogQuery, type CommunityApi } from "./api";
export { CommunityApp, CommunityFrame } from "./CommunityApp";
export { CommunityCatalog } from "./CommunityCatalog";
export { CommunityView } from "./CommunityView";
export {
  catalogTab,
  CommunityPlatformProvider,
  manageSection,
  pageTab,
  useCommunityPlatform,
  type CatalogTab,
  type CommunityHost,
  type CommunityImageKind,
  type CommunityPlatform,
  type CommunityRoute,
  type CommunitySeed,
  type ImageRefusal,
  type ManageSection,
  type PageTab,
  type PickedImage,
  type PlayContext,
  type UploadedImage,
} from "./platform";
export type * from "./types";
