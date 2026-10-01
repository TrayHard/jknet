/**
 * The launcher's drops of pictures on their tiles — the logo and the cover
 * of the management screen, the cover of an event in its editor.
 *
 * Tauri takes the files dropped on the window and tells the webview their
 * paths and the position of the drag, in physical pixels. One router of the
 * window (`createDropRouter`) hears those events while a tile is on screen,
 * turns the position into the page's pixels and finds the tile under it;
 * whether a drop now would land on a tile goes to the core, which keeps such
 * a drop from the chat composer (`community_claim_drop`). The path of a drop
 * on a tile goes to `community_drop_image`. The community platforms of the
 * launcher hand both on as `dropZones` and `dropImage`.
 */

import { getCurrentWebview } from "@tauri-apps/api/webview";

import type { CommunityPlatform, PictureKind } from "../components/community";
import { createDropRouter, pagePoint, type DropZones } from "../components/community/pictureDrop";
import { communityIpc } from "../lib/ipc";
import { isTauri } from "../lib/runtime";

const router = createDropRouter((claimed) => {
  communityIpc.claimDrop(claimed).catch((error: unknown) => console.warn("community_claim_drop failed", error));
});

/** The tiles on screen: the window's drags are heard while there is one. */
let tiles = 0;
let stopListening: (() => void) | null = null;

function listen(): () => void {
  let unlisten: (() => void) | undefined;
  let stopped = false;
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      const drag = event.payload;
      const ratio = window.devicePixelRatio;
      switch (drag.type) {
        case "enter":
          router.handle({ type: "enter", paths: drag.paths, point: pagePoint(drag.position, ratio) });
          return;
        case "over":
          router.handle({ type: "over", point: pagePoint(drag.position, ratio) });
          return;
        case "drop":
          router.handle({ type: "drop", paths: drag.paths, point: pagePoint(drag.position, ratio) });
          return;
        case "leave":
          router.handle({ type: "leave" });
      }
    })
    .then((off) => {
      if (stopped) off();
      else unlisten = off;
    })
    .catch((error: unknown) => console.warn("cannot hear the drops of files on the window", error));
  return () => {
    stopped = true;
    unlisten?.();
  };
}

const dropZones: DropZones = {
  add(zone) {
    const remove = router.add(zone);
    tiles += 1;
    if (tiles === 1) stopListening = listen();
    return () => {
      remove();
      tiles -= 1;
      if (tiles > 0) return;
      stopListening?.();
      stopListening = null;
    };
  },
};

const dropImage = (kind: PictureKind, path: string) => communityIpc.dropImage(kind, path);

/** What the launcher's community platforms give a picture's tile for drops; nothing outside Tauri. */
export function launcherPictureDrops(): Pick<CommunityPlatform, "dropZones" | "dropImage"> {
  return isTauri() ? { dropZones, dropImage } : {};
}
