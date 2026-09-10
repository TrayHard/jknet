import { Library, Monitor, Server, Settings, Users } from "lucide-react";
import { useNavigate } from "react-router";

import {
  useAccountState,
  useClients,
  useOnlineFriendCount,
  useSettings,
} from "../lib/queries";
import { Avatar, NavItem } from "./ui";

/**
 * The 232 px navigation column: three groups of routes and the user block at
 * the bottom. Group titles come from the design: Play, Manage, Community.
 */
export function Sidebar() {
  const navigate = useNavigate();
  const settings = useSettings();
  const clients = useClients();
  // --- slice: account ---
  const account = useAccountState();
  // --- slice: friends ---
  // Undefined while signed out or still loading, which leaves the counter off
  // rather than claiming zero friends are online.
  const friendsOnline = useOnlineFriendCount();

  const defaultClient = clients.data?.find(
    (client) => client.id === settings.data?.defaultClientId,
  );
  const user = account.data?.hubSignedIn ? (account.data.hubUser ?? null) : null;

  return (
    <nav className="flex flex-col shrink-0 w-232 bg-sidebar border-r border-line-subtle">
      <div className="flex-1 flex flex-col gap-20 p-12 overflow-y-auto">
        <Group title="Play">
          <NavItem to="/" end icon={<Monitor size={20} />} label="Home" />
          <NavItem to="/servers" icon={<Server size={20} />} label="Servers" />
        </Group>

        <Group title="Manage">
          <NavItem to="/library" icon={<Library size={20} />} label="Library" />
          <NavItem
            to="/clients"
            icon={<Monitor size={20} />}
            label="Clients"
            count={clients.data?.length}
          />
        </Group>

        <Group title="Community">
          <NavItem
            to="/friends"
            icon={<Users size={20} />}
            label="Friends"
            count={friendsOnline}
          />
        </Group>
      </div>

      <div className="flex items-center gap-8 p-12 border-t border-line-subtle">
        {/* --- slice: account --- the block opens Settings · Account, which is
            where signing in and out lives. */}
        <button
          type="button"
          title={user ? "Account settings" : "Sign in"}
          onClick={() => void navigate("/settings?section=account")}
          className="flex-1 min-w-0 flex items-center gap-8 rounded-sm p-4 -m-4 text-left hover:bg-hover-overlay transition-colors duration-150 cursor-pointer"
        >
          <Avatar name={user?.displayName ?? null} src={user?.avatarUrl} size="md" />
          <span className="flex-1 min-w-0">
            <span className="block text-body-sm-medium text-fg truncate">
              {user ? user.displayName : "Guest"}
            </span>
            <span className="block text-mono-xs text-fg-muted truncate">
              {defaultClient ? defaultClient.name : "No client yet"}
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={() => void navigate("/settings")}
          className="flex items-center justify-center size-28 shrink-0 rounded-sm text-fg-secondary hover:bg-hover-overlay hover:text-fg transition-colors duration-150 cursor-pointer"
        >
          <Settings size={16} />
        </button>
      </div>
    </nav>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <span className="text-label-xs text-fg-muted px-12 pb-4">{title}</span>
      {children}
    </div>
  );
}
