import { createContext } from "react";

import type { ChatWebFileOrigin } from "../../lib/ipc";

/**
 * --- slice: web app ---
 *
 * Where the composer hands files of the page on a platform whose core has no
 * file dialog of its own (`usePlatform().nativeDialogs` off): the ones picked
 * through **File** and **Photo** of the attach menu, pasted into the field
 * or dropped on the composer. They come back staged as `chat:files-staged`,
 * the way a drop on the launcher window does.
 *
 * The web shell may provide its own source — a native picker of a wrapped
 * app, say. Without a provider the files go to `chat_stage_web_files`.
 */
export type ComposerFileSource = (files: File[], origin: ChatWebFileOrigin) => Promise<unknown>;

export const ComposerFileSourceContext = createContext<ComposerFileSource | null>(null);
