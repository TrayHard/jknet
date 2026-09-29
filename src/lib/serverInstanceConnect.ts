import type { Game, ServerInstanceView } from "./ipc";

/** The part of a server row needed by the shared connection dialog. */
export interface ConnectTarget {
  game: Game;
  address: string;
  hostnameClean: string;
}

/** Connects a local client through loopback, regardless of the server's public bind. */
export function serverInstanceConnectTarget(
  server: Pick<ServerInstanceView, "game" | "name" | "port">,
): ConnectTarget {
  return {
    game: server.game,
    address: `127.0.0.1:${server.port}`,
    hostnameClean: server.name,
  };
}
