export interface CommunityRecommendation { jkhubId: number; title: string }
export interface CommunityServer {
  id: string; game: "ja" | "jo"; address: string; name: string;
  description: string; website: string; discord: string; rules: string;
  recommendations: CommunityRecommendation[]; ownerId: string | null;
  featured: boolean; revision: number; createdAt: string; updatedAt: string;
}
export interface CommunityClaim {
  id: string; serverId: string; userId: string; code: string; expiresAt: string;
  manual: boolean; status: "pending" | "approved" | "rejected";
}
export interface CommunityMe {
  isAdmin: boolean; userId: string; servers: CommunityServer[]; claims: CommunityClaim[];
}
export type CommunityRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export function jkhubId(value: string): number | null {
  const trimmed = value.trim();
  if (/^[1-9]\d{0,8}$/.test(trimmed)) return Number(trimmed);
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.hostname !== "jkhub.org" || url.username || url.password) return null;
    const match = /^\/files\/file\/([1-9]\d{0,8})(?:-[^/]+)?\/?$/.exec(url.pathname);
    return match ? Number(match[1]) : null;
  } catch { return null; }
}
